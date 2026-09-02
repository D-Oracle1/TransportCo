import { Router } from 'express';
import { z } from 'zod';
import { savedLocationSchema } from '@transportco/validation';
import { formatMoney } from '@transportco/utils';
import { asyncHandler, param, sendCreated, sendNoContent, sendOk } from '../../lib/http';
import { validateBody, validateParams } from '../../middleware/validate';
import { authenticate, claimsOf, customerIdOf, requireCustomer } from '../../middleware/auth';
import { query, queryOne } from '../../db/pool';
import { notFound } from '../../lib/errors';

/**
 * Customer self-service: profile, saved places, loyalty and what they owe.
 * Every query is filtered by the customer id from the token.
 */
export const customerRouter = Router();

customerRouter.use(authenticate, requireCustomer);

const idParams = z.object({ id: z.string().uuid() });

customerRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    const customerId = customerIdOf(req);

    const profile = await queryOne<{
      id: string;
      reference: string;
      referral_code: string;
      rating: number | null;
      total_trips: number;
      has_outstanding_balance: boolean;
      notification_preferences: Record<string, boolean>;
      full_name: string;
      email: string | null;
      phone: string;
      created_at: Date;
    }>(
      `SELECT c.id, c.reference, c.referral_code, c.rating, c.total_trips,
              c.has_outstanding_balance, c.notification_preferences,
              u.full_name, u.email, u.phone, u.created_at
         FROM customers c JOIN users u ON u.id = c.user_id
        WHERE c.id = $1`,
      [customerId],
    );

    if (!profile) throw notFound('Customer', customerId);

    const [loyalty, outstanding] = await Promise.all([
      queryOne<{ balance_points: number; tier: string; lifetime_earned_points: number }>(
        'SELECT balance_points, tier, lifetime_earned_points FROM loyalty_accounts WHERE customer_id = $1',
        [customerId],
      ),
      queryOne<{ total: number }>(
        `SELECT COALESCE(SUM(amount_minor - settled_amount_minor), 0)::bigint AS total
           FROM outstanding_balances
          WHERE customer_id = $1 AND status IN ('outstanding','partially_settled')`,
        [customerId],
      ),
    ]);

    sendOk(res, {
      id: profile.id,
      reference: profile.reference,
      fullName: profile.full_name,
      email: profile.email,
      phone: profile.phone,
      referralCode: profile.referral_code,
      rating: profile.rating === null ? null : Number(profile.rating),
      totalTrips: profile.total_trips,
      memberSince: profile.created_at.toISOString(),
      notificationPreferences: profile.notification_preferences,
      loyalty: {
        balancePoints: loyalty?.balance_points ?? 0,
        lifetimePoints: loyalty?.lifetime_earned_points ?? 0,
        tier: loyalty?.tier ?? 'standard',
      },
      outstandingBalanceMinor: Number(outstanding?.total ?? 0),
      outstandingBalanceLabel: formatMoney(Number(outstanding?.total ?? 0)),
    });
  }),
);

customerRouter.patch(
  '/me',
  validateBody(
    z.object({
      fullName: z.string().trim().min(2).max(120).optional(),
      email: z.string().email().optional(),
      notificationPreferences: z
        .object({
          push: z.boolean(),
          sms: z.boolean(),
          email: z.boolean(),
          whatsapp: z.boolean(),
        })
        .partial()
        .optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const claims = claimsOf(req);
    const body = req.body as {
      fullName?: string;
      email?: string;
      notificationPreferences?: Record<string, boolean>;
    };

    if (body.fullName || body.email) {
      await query(
        `UPDATE users SET full_name = COALESCE($2, full_name), email = COALESCE($3, email) WHERE id = $1`,
        [claims.sub, body.fullName ?? null, body.email?.toLowerCase() ?? null],
      );
    }

    if (body.notificationPreferences) {
      // Merged rather than replaced, so a partial update cannot silently
      // switch off a channel the customer never mentioned.
      await query(
        `UPDATE customers
            SET notification_preferences = notification_preferences || $2::jsonb
          WHERE id = $1`,
        [customerIdOf(req), JSON.stringify(body.notificationPreferences)],
      );
    }

    sendOk(res, { updated: true });
  }),
);

// --- Saved locations -------------------------------------------------------

customerRouter.get(
  '/me/locations',
  asyncHandler(async (req, res) => {
    sendOk(
      res,
      await query(
        `SELECT id, label, kind, address, latitude, longitude, place_id
           FROM saved_locations WHERE customer_id = $1 ORDER BY kind, label`,
        [customerIdOf(req)],
      ),
    );
  }),
);

customerRouter.post(
  '/me/locations',
  validateBody(savedLocationSchema),
  asyncHandler(async (req, res) => {
    const row = await queryOne(
      `INSERT INTO saved_locations (customer_id, label, kind, address, latitude, longitude, place_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (customer_id, kind) WHERE kind IN ('home','work')
         DO UPDATE SET label = EXCLUDED.label, address = EXCLUDED.address,
                       latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude
       RETURNING *`,
      [
        customerIdOf(req),
        req.body.label,
        req.body.kind,
        req.body.address,
        req.body.latitude,
        req.body.longitude,
        req.body.placeId ?? null,
      ],
    );

    sendCreated(res, row);
  }),
);

customerRouter.delete(
  '/me/locations/:id',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    await query('DELETE FROM saved_locations WHERE id = $1 AND customer_id = $2', [
      param(req, 'id'),
      customerIdOf(req),
    ]);
    sendNoContent(res);
  }),
);

// --- Loyalty ---------------------------------------------------------------

customerRouter.get(
  '/me/loyalty',
  asyncHandler(async (req, res) => {
    const customerId = customerIdOf(req);

    const [account, transactions] = await Promise.all([
      queryOne<{ balance_points: number; lifetime_earned_points: number; lifetime_redeemed_points: number; tier: string }>(
        'SELECT balance_points, lifetime_earned_points, lifetime_redeemed_points, tier FROM loyalty_accounts WHERE customer_id = $1',
        [customerId],
      ),
      query(
        `SELECT type, points, balance_after, reason, created_at, trip_id
           FROM loyalty_transactions
          WHERE customer_id = $1
          ORDER BY created_at DESC
          LIMIT 50`,
        [customerId],
      ),
    ]);

    sendOk(res, {
      balancePoints: account?.balance_points ?? 0,
      lifetimeEarned: account?.lifetime_earned_points ?? 0,
      lifetimeRedeemed: account?.lifetime_redeemed_points ?? 0,
      tier: account?.tier ?? 'standard',
      transactions,
    });
  }),
);

// --- Outstanding balances --------------------------------------------------

/**
 * What the customer owes, and why.
 *
 * This screen exists because we chose not to take a card at sign-up: an unpaid
 * cancellation fee has to be visible and settleable, not a silent block on the
 * next booking.
 */
customerRouter.get(
  '/me/balances',
  asyncHandler(async (req, res) => {
    const rows = await query<{
      id: string;
      reason: string;
      amount_minor: number;
      settled_amount_minor: number;
      status: string;
      created_at: Date;
      trip_reference: string | null;
    }>(
      `SELECT b.id, b.reason, b.amount_minor, b.settled_amount_minor, b.status, b.created_at,
              t.reference AS trip_reference
         FROM outstanding_balances b
         LEFT JOIN trips t ON t.id = b.trip_id
        WHERE b.customer_id = $1 AND b.status IN ('outstanding','partially_settled')
        ORDER BY b.created_at ASC`,
      [customerIdOf(req)],
    );

    const totalMinor = rows.reduce((sum, row) => sum + (row.amount_minor - row.settled_amount_minor), 0);

    sendOk(res, {
      totalMinor,
      totalLabel: formatMoney(totalMinor),
      items: rows.map((row) => ({
        id: row.id,
        reason: row.reason,
        outstandingMinor: row.amount_minor - row.settled_amount_minor,
        outstandingLabel: formatMoney(row.amount_minor - row.settled_amount_minor),
        tripReference: row.trip_reference,
        since: row.created_at.toISOString(),
      })),
    });
  }),
);

// --- Notifications ---------------------------------------------------------

customerRouter.get(
  '/me/notifications',
  asyncHandler(async (req, res) => {
    sendOk(
      res,
      await query(
        `SELECT id, event, title, body, data, read_at, created_at
           FROM notifications
          WHERE recipient_user_id = $1 AND channel = 'in_app'
          ORDER BY created_at DESC
          LIMIT 50`,
        [claimsOf(req).sub],
      ),
    );
  }),
);

customerRouter.post(
  '/me/notifications/:id/read',
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE notifications SET read_at = now(), status = 'read'
        WHERE id = $1 AND recipient_user_id = $2`,
      [param(req, 'id'), claimsOf(req).sub],
    );
    sendOk(res, { read: true });
  }),
);
