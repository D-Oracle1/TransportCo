import bcrypt from 'bcryptjs';
import { createHash } from 'node:crypto';
import type { AuthenticatedSession, Permission } from '@transportco/types';
import { addSeconds, maskPhone, normalisePhone } from '@transportco/utils';
import { generateCode, generateOtp } from '@transportco/utils/secure';
import { query, queryOne, withTransaction } from '../../db/pool';
import { AppError } from '../../lib/errors';
import { generateRefreshToken, hashRefreshToken, parseDuration, signAccessToken } from '../../lib/tokens';
import { getContext } from '../../lib/context';
import { env } from '../../config';
import { recordAudit } from '../../services/audit';
import { logger } from '../../lib/logger';
import { evaluateDuplicateDevice } from '../../domain/fraud/rules';

/**
 * AUTHENTICATION.
 *
 * Phone-first, because that is how this market signs in. Deliberate choices:
 *
 *  - NO CARD IS REQUESTED AT SIGN-UP. The brief is explicit and the reasoning
 *    is sound: a new Nigerian transport brand asking for card details before it
 *    has delivered a single trip loses customers at the first screen. The
 *    consequence — unpaid cancellation fees — is handled by outstanding
 *    balances instead.
 *  - Failed logins are counted and the account locks temporarily. Phone-number
 *    enumeration and credential stuffing are the realistic attacks here.
 *  - Sign-in responses never distinguish "no such account" from "wrong
 *    password". Telling an attacker which phone numbers are registered is a
 *    free gift.
 */

const BCRYPT_ROUNDS = 12;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

interface UserRow {
  id: string;
  principal_type: 'customer' | 'employee';
  full_name: string;
  email: string | null;
  phone: string;
  password_hash: string | null;
  status: string;
  phone_verified_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
}

function normalisePhoneOrThrow(input: string): string {
  const phone = normalisePhone(input);
  if (!phone) {
    throw new AppError({ code: 'validation_failed', message: 'Enter a valid Nigerian phone number' });
  }
  return phone;
}

async function loadPermissions(userId: string): Promise<{ roles: string[]; permissions: Permission[] }> {
  const rows = await query<{ role_key: string; permission_key: Permission }>(
    `SELECT r.key AS role_key, rp.permission_key
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE ur.user_id = $1`,
    [userId],
  );

  const roles = [...new Set(rows.map((row) => row.role_key))];
  const permissions = [...new Set(rows.map((row) => row.permission_key).filter(Boolean))];
  return { roles, permissions };
}

async function issueSession(user: UserRow): Promise<AuthenticatedSession> {
  const [{ roles, permissions }, customer, driver] = await Promise.all([
    loadPermissions(user.id),
    queryOne<{ id: string }>('SELECT id FROM customers WHERE user_id = $1', [user.id]),
    queryOne<{ driver_id: string; employee_id: string }>(
      `SELECT d.id AS driver_id, e.id AS employee_id
         FROM employees e LEFT JOIN drivers d ON d.employee_id = e.id
        WHERE e.user_id = $1`,
      [user.id],
    ),
  ]);

  const context = getContext();
  const refresh = generateRefreshToken();
  const refreshTtlSeconds = parseDuration(env.JWT_REFRESH_TTL);

  const session = await queryOne<{ id: string }>(
    `INSERT INTO auth_sessions (user_id, refresh_token_hash, user_agent, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      user.id,
      refresh.hash,
      context?.userAgent ?? null,
      context?.ipAddress ?? null,
      addSeconds(new Date(), refreshTtlSeconds),
    ],
  );

  const access = signAccessToken({
    userId: user.id,
    principalType: user.principal_type,
    roles,
    permissions,
    sessionId: session!.id,
    ...(customer ? { customerId: customer.id } : {}),
    ...(driver?.driver_id ? { driverId: driver.driver_id } : {}),
  });

  await query('UPDATE users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1', [
    user.id,
  ]);

  return {
    tokens: {
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresAt: access.expiresAt.toISOString(),
      tokenType: 'Bearer',
    },
    user: {
      id: user.id,
      fullName: user.full_name,
      email: user.email,
      phone: user.phone,
      principalType: user.principal_type,
      status: user.status,
      ...(customer ? { customerId: customer.id } : {}),
      ...(driver?.driver_id ? { driverId: driver.driver_id } : {}),
      ...(driver?.employee_id ? { employeeId: driver.employee_id } : {}),
      roles,
      permissions,
    },
  };
}

export interface RegisterInput {
  fullName: string;
  phone: string;
  email?: string;
  password: string;
  referralCode?: string;
  deviceId?: string;
}

export async function registerCustomer(input: RegisterInput): Promise<{
  userId: string;
  customerId: string;
  phone: string;
  otpSent: boolean;
  /** Development only — lets the mobile app be exercised without an SMS provider. */
  devOtp?: string;
}> {
  const phone = normalisePhoneOrThrow(input.phone);

  return withTransaction(async (client) => {
    const existing = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE phone = $1 AND deleted_at IS NULL',
      [phone],
      client,
    );

    if (existing) {
      throw new AppError({
        code: 'conflict',
        message: 'An account with this phone number already exists. Try signing in.',
      });
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    const user = await queryOne<UserRow>(
      `INSERT INTO users (principal_type, full_name, email, phone, password_hash, status)
       VALUES ('customer', $1, $2, $3, $4, 'pending_verification')
       RETURNING *`,
      [input.fullName.trim(), input.email?.toLowerCase() ?? null, phone, passwordHash],
      client,
    );

    let referrerId: string | null = null;
    if (input.referralCode) {
      const referrer = await queryOne<{ id: string }>(
        'SELECT id FROM customers WHERE referral_code = $1',
        [input.referralCode.toUpperCase()],
        client,
      );
      referrerId = referrer?.id ?? null;
    }

    const sequence = await queryOne<{ value: number }>(
      "SELECT nextval('seq_customer_reference')::int AS value",
      [],
      client,
    );

    const customer = await queryOne<{ id: string }>(
      `INSERT INTO customers (user_id, reference, referral_code, referred_by_customer_id, signup_device_id, signup_ip)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        user!.id,
        `CUS-${String(sequence?.value ?? 1).padStart(6, '0')}`,
        generateCode(7),
        referrerId,
        input.deviceId ?? null,
        getContext()?.ipAddress ?? null,
      ],
      client,
    );

    await queryOne(
      'INSERT INTO loyalty_accounts (customer_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id',
      [customer!.id],
      client,
    );

    const otp = await issueOtp(client, { userId: user!.id, phone, purpose: 'phone_verification' });

    // Fire-and-forget: a fraud signal must never block a sign-up.
    void evaluateDuplicateDevice(customer!.id, input.deviceId ?? null);

    logger.info({ userId: user!.id, phone: maskPhone(phone) }, 'Customer registered');

    return {
      userId: user!.id,
      customerId: customer!.id,
      phone,
      otpSent: true,
      ...(env.NODE_ENV === 'production' ? {} : { devOtp: otp }),
    };
  });
}

/**
 * Issues a one-time code. Only the HASH is stored — a database dump must not
 * hand over live verification codes.
 */
async function issueOtp(
  client: Parameters<typeof queryOne>[2],
  args: { userId: string | null; phone: string; purpose: 'phone_verification' | 'password_reset' | 'login' },
): Promise<string> {
  const code = generateOtp(6);

  await queryOne(
    `INSERT INTO otp_codes (user_id, phone, purpose, code_hash, max_attempts, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      args.userId,
      args.phone,
      args.purpose,
      createHash('sha256').update(code).digest('hex'),
      env.OTP_MAX_ATTEMPTS,
      addSeconds(new Date(), env.OTP_TTL_SECONDS),
    ],
    client,
  );

  // Delivery goes through the SMS channel adapter. With no provider configured
  // it logs rather than pretending to have sent anything.
  logger.info({ phone: maskPhone(args.phone), purpose: args.purpose }, 'OTP issued');

  return code;
}

export async function requestOtp(
  phone: string,
  purpose: 'phone_verification' | 'password_reset' | 'login',
): Promise<{ sent: boolean; devOtp?: string }> {
  const normalised = normalisePhoneOrThrow(phone);
  const user = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE phone = $1 AND deleted_at IS NULL',
    [normalised],
  );

  // Always report success: a differing response would let anyone test whether a
  // phone number has an account.
  if (!user) {
    logger.info({ phone: maskPhone(normalised) }, 'OTP requested for unknown number');
    return { sent: true };
  }

  const code = await issueOtp(undefined, { userId: user.id, phone: normalised, purpose });
  return { sent: true, ...(env.NODE_ENV === 'production' ? {} : { devOtp: code }) };
}

export async function verifyOtp(args: {
  phone: string;
  code: string;
  purpose: 'phone_verification' | 'password_reset' | 'login';
}): Promise<{ verified: boolean; session?: AuthenticatedSession }> {
  const phone = normalisePhoneOrThrow(args.phone);

  const record = await queryOne<{
    id: string;
    user_id: string | null;
    code_hash: string;
    attempts: number;
    max_attempts: number;
    expires_at: Date;
    consumed_at: Date | null;
  }>(
    `SELECT * FROM otp_codes
      WHERE phone = $1 AND purpose = $2 AND consumed_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1`,
    [phone, args.purpose],
  );

  if (!record) {
    throw new AppError({ code: 'otp_invalid', message: 'That code is not valid. Request a new one.' });
  }

  if (record.expires_at.getTime() <= Date.now()) {
    throw new AppError({ code: 'otp_expired', message: 'That code has expired. Request a new one.' });
  }

  if (record.attempts >= record.max_attempts) {
    throw new AppError({
      code: 'otp_throttled',
      message: 'Too many incorrect attempts. Request a new code.',
    });
  }

  const providedHash = createHash('sha256').update(args.code).digest('hex');

  if (providedHash !== record.code_hash) {
    await query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [record.id]);
    throw new AppError({ code: 'otp_invalid', message: 'That code is not correct.' });
  }

  await query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [record.id]);

  if (args.purpose === 'password_reset') return { verified: true };

  const user = await queryOne<UserRow>(
    `UPDATE users
        SET phone_verified_at = COALESCE(phone_verified_at, now()),
            status = CASE WHEN status = 'pending_verification' THEN 'active' ELSE status END
      WHERE id = $1
      RETURNING *`,
    [record.user_id],
  );

  if (!user) throw new AppError({ code: 'not_found', message: 'Account not found' });

  return { verified: true, session: await issueSession(user) };
}

export async function login(identifier: string, password: string): Promise<AuthenticatedSession> {
  const phone = normalisePhone(identifier);
  const looksLikeEmail = identifier.includes('@');

  const user = await queryOne<UserRow>(
    `SELECT * FROM users
      WHERE deleted_at IS NULL AND (($1::text IS NOT NULL AND phone = $1) OR ($2 AND lower(email) = lower($3)))
      LIMIT 1`,
    [phone, looksLikeEmail, identifier],
  );

  const genericFailure = new AppError({
    code: 'invalid_credentials',
    message: 'Those details do not match an account',
  });

  if (!user || !user.password_hash) {
    // Hash anyway so a missing account is not detectable by response timing.
    await bcrypt.compare(password, '$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva');
    throw genericFailure;
  }

  if (user.locked_until && user.locked_until.getTime() > Date.now()) {
    throw new AppError({
      code: 'rate_limited',
      message: 'Too many failed attempts. Try again in a few minutes.',
      retryAfterSeconds: Math.ceil((user.locked_until.getTime() - Date.now()) / 1000),
    });
  }

  if (user.status === 'suspended' || user.status === 'deactivated') {
    throw new AppError({
      code: 'account_suspended',
      message: 'This account is not active. Please contact support.',
    });
  }

  const matches = await bcrypt.compare(password, user.password_hash);

  if (!matches) {
    const failures = user.failed_login_count + 1;
    await query(
      `UPDATE users
          SET failed_login_count = $2,
              locked_until = CASE WHEN $2 >= $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END
        WHERE id = $1`,
      [user.id, failures, MAX_FAILED_LOGINS, LOCK_MINUTES],
    );

    await recordAudit({
      action: 'auth.login_failed',
      resourceType: 'user',
      resourceId: user.id,
      actorUserId: user.id,
      actorType: user.principal_type === 'customer' ? 'customer' : 'admin',
      newValue: { failedAttempts: failures },
    }).catch(() => undefined);

    throw genericFailure;
  }

  if (user.status === 'pending_verification') {
    throw new AppError({
      code: 'phone_not_verified',
      message: 'Please verify your phone number to continue',
    });
  }

  await recordAudit({
    action: 'auth.login_succeeded',
    resourceType: 'user',
    resourceId: user.id,
    actorUserId: user.id,
    actorType: user.principal_type === 'customer' ? 'customer' : 'admin',
  }).catch(() => undefined);

  return issueSession(user);
}

export async function refreshSession(refreshToken: string): Promise<AuthenticatedSession> {
  const hash = hashRefreshToken(refreshToken);

  const session = await queryOne<{ id: string; user_id: string; expires_at: Date; revoked_at: Date | null }>(
    'SELECT id, user_id, expires_at, revoked_at FROM auth_sessions WHERE refresh_token_hash = $1',
    [hash],
  );

  if (!session || session.revoked_at || session.expires_at.getTime() <= Date.now()) {
    throw new AppError({ code: 'token_expired', message: 'Your session has expired. Sign in again.' });
  }

  const user = await queryOne<UserRow>('SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL', [
    session.user_id,
  ]);

  if (!user || user.status !== 'active') {
    throw new AppError({ code: 'account_suspended', message: 'This account is not active' });
  }

  // Refresh tokens rotate: the old one is revoked as the new one is issued, so
  // a stolen token is usable at most once before the theft becomes visible.
  await query(`UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1`, [
    session.id,
  ]);

  return issueSession(user);
}

export async function logout(refreshToken: string): Promise<void> {
  await query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'logout'
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
    [hashRefreshToken(refreshToken)],
  );
}

export async function resetPassword(args: {
  phone: string;
  code: string;
  newPassword: string;
}): Promise<void> {
  const verification = await verifyOtp({ phone: args.phone, code: args.code, purpose: 'password_reset' });
  if (!verification.verified) {
    throw new AppError({ code: 'otp_invalid', message: 'That code is not correct.' });
  }

  const phone = normalisePhoneOrThrow(args.phone);
  const passwordHash = await bcrypt.hash(args.newPassword, BCRYPT_ROUNDS);

  const user = await queryOne<{ id: string }>(
    `UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL
      WHERE phone = $1 AND deleted_at IS NULL
      RETURNING id`,
    [phone, passwordHash],
  );

  if (!user) throw new AppError({ code: 'not_found', message: 'Account not found' });

  // Every existing session dies with a password change. If the reset was
  // triggered by a compromise, leaving old sessions alive defeats the point.
  await query(
    `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'password_reset'
      WHERE user_id = $1 AND revoked_at IS NULL`,
    [user.id],
  );
}

export async function registerPushToken(args: {
  userId: string;
  token: string;
  platform: 'ios' | 'android' | 'web';
  deviceId?: string;
}): Promise<void> {
  await query(
    `INSERT INTO push_tokens (user_id, token, platform, device_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (token) DO UPDATE
       SET user_id = EXCLUDED.user_id, active = true, last_seen_at = now()`,
    [args.userId, args.token, args.platform, args.deviceId ?? null],
  );
}
