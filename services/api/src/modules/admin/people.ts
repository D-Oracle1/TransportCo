import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import {
  assignRolesSchema,
  createDriverSchema,
  loyaltyAdjustmentSchema,
  pageQuerySchema,
  suspendCustomerSchema,
} from '@transportco/validation';
import { formatMoney, maskPhone, normalisePhone } from '@transportco/utils';
import { generateCode } from '@transportco/utils/secure';
import { asyncHandler, paginate, param, sendCreated, sendOk } from '../../lib/http';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate';
import { authenticate, claimsOf, requirePermission } from '../../middleware/auth';
import { query, queryOne, withTransaction } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import { hasPermission } from '../../domain/rbac/access';
import { recordAudit } from '../../services/audit';
import { computeWorkloadScore } from '../../domain/dispatch/scoring';

/**
 * People management: customers, drivers, employees and roles.
 *
 * PII exposure is graded. A dispatcher sees a customer's name so they can talk
 * about the trip; only roles holding `customer:read_pii` see the phone number.
 * A transport operator holds the home addresses of everyone who has ever
 * booked, and that data deserves more care than a permissions afterthought.
 */
export const adminPeopleRouter = Router();

adminPeopleRouter.use(authenticate);

const idParams = z.object({ id: z.string().uuid() });

// --- Customers -------------------------------------------------------------

adminPeopleRouter.get(
  '/customers',
  requirePermission('customer:read'),
  validateQuery(pageQuerySchema.extend({ search: z.string().max(80).optional() })),
  asyncHandler(async (req, res) => {
    const { page, pageSize, search } = req.query as unknown as {
      page: number;
      pageSize: number;
      search?: string;
    };
    const canSeePii = hasPermission(claimsOf(req), 'customer:read_pii');

    const [rows, count] = await Promise.all([
      query<{
        id: string;
        reference: string;
        full_name: string;
        phone: string;
        email: string | null;
        status: string;
        rating: number | null;
        total_trips: number;
        outstanding: number;
        created_at: Date;
      }>(
        `SELECT c.id, c.reference, u.full_name, u.phone, u.email, u.status, c.rating, c.total_trips,
                COALESCE((SELECT SUM(amount_minor - settled_amount_minor) FROM outstanding_balances b
                           WHERE b.customer_id = c.id AND b.status IN ('outstanding','partially_settled')), 0)::bigint AS outstanding,
                c.created_at
           FROM customers c JOIN users u ON u.id = c.user_id
          WHERE u.deleted_at IS NULL
            AND ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%'
                 OR c.reference ILIKE '%' || $1 || '%')
          ORDER BY c.created_at DESC
          LIMIT $2 OFFSET $3`,
        [search ?? null, pageSize, (page - 1) * pageSize],
      ),
      queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM customers c JOIN users u ON u.id = c.user_id
          WHERE u.deleted_at IS NULL
            AND ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.phone ILIKE '%' || $1 || '%'
                 OR c.reference ILIKE '%' || $1 || '%')`,
        [search ?? null],
      ),
    ]);

    sendOk(
      res,
      paginate(
        rows.map((row) => ({
          ...row,
          phone: canSeePii ? row.phone : maskPhone(row.phone),
          email: canSeePii ? row.email : null,
          outstanding: Number(row.outstanding),
          outstandingLabel: formatMoney(Number(row.outstanding)),
        })),
        count?.count ?? 0,
        page,
        pageSize,
      ),
    );
  }),
);

adminPeopleRouter.get(
  '/customers/:id',
  requirePermission('customer:read'),
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const canSeePii = hasPermission(claimsOf(req), 'customer:read_pii');

    const customer = await queryOne<Record<string, unknown>>(
      `SELECT c.*, u.full_name, u.phone, u.email, u.status, u.created_at AS joined_at,
              u.suspended_reason
         FROM customers c JOIN users u ON u.id = c.user_id
        WHERE c.id = $1`,
      [param(req, 'id')],
    );
    if (!customer) throw notFound('Customer', param(req, 'id'));

    const [trips, payments, loyalty, balances, tickets] = await Promise.all([
      query(
        `SELECT id, reference, status, pickup_address, destination_address,
                quoted_fare_minor, final_fare_minor, payment_status, created_at
           FROM trips WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [param(req, 'id')],
      ),
      query(
        `SELECT id, reference, method, amount_minor, status, paid_at
           FROM payments WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [param(req, 'id')],
      ),
      queryOne(
        'SELECT balance_points, lifetime_earned_points, lifetime_redeemed_points, tier FROM loyalty_accounts WHERE customer_id = $1',
        [param(req, 'id')],
      ),
      query(
        `SELECT id, reason, amount_minor, settled_amount_minor, status, created_at
           FROM outstanding_balances WHERE customer_id = $1 ORDER BY created_at DESC`,
        [param(req, 'id')],
      ),
      query(
        `SELECT id, reference, category, status, created_at FROM support_tickets
          WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [param(req, 'id')],
      ),
    ]);

    const cancellations = await queryOne<{ count: number }>(
      `SELECT count(*)::int AS count FROM trips
        WHERE customer_id = $1 AND status = 'CANCELLED' AND cancelled_by_type = 'customer'`,
      [param(req, 'id')],
    );

    if (!canSeePii) {
      customer.phone = maskPhone(customer.phone as string);
      customer.email = null;
    }

    sendOk(res, {
      customer,
      trips,
      payments,
      loyalty,
      balances,
      tickets,
      cancellationCount: cancellations?.count ?? 0,
    });
  }),
);

adminPeopleRouter.post(
  '/customers/:id/suspend',
  requirePermission('customer:suspend'),
  validateParams(idParams),
  validateBody(suspendCustomerSchema),
  asyncHandler(async (req, res) => {
    const customer = await queryOne<{ user_id: string; status: string }>(
      'SELECT c.user_id, u.status FROM customers c JOIN users u ON u.id = c.user_id WHERE c.id = $1',
      [param(req, 'id')],
    );
    if (!customer) throw notFound('Customer', param(req, 'id'));

    await query(`UPDATE users SET status = 'suspended', suspended_reason = $2 WHERE id = $1`, [
      customer.user_id,
      req.body.reason,
    ]);

    // Sessions die with the suspension; otherwise a suspended customer keeps
    // booking until their access token happens to expire.
    await query(
      `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'account_suspended'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [customer.user_id],
    );

    await recordAudit({
      action: 'customer.suspended',
      resourceType: 'customer',
      resourceId: param(req, 'id'),
      previousValue: { status: customer.status },
      newValue: { status: 'suspended' },
      reason: req.body.reason,
    });

    sendOk(res, { suspended: true });
  }),
);

adminPeopleRouter.post(
  '/customers/:id/reactivate',
  requirePermission('customer:suspend'),
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const customer = await queryOne<{ user_id: string }>('SELECT user_id FROM customers WHERE id = $1', [
      param(req, 'id'),
    ]);
    if (!customer) throw notFound('Customer', param(req, 'id'));

    await query(`UPDATE users SET status = 'active', suspended_reason = NULL WHERE id = $1`, [
      customer.user_id,
    ]);

    await recordAudit({
      action: 'customer.reactivated',
      resourceType: 'customer',
      resourceId: param(req, 'id'),
      newValue: { status: 'active' },
    });

    sendOk(res, { reactivated: true });
  }),
);

// --- Loyalty adjustments ---------------------------------------------------

/**
 * Manual loyalty adjustment.
 *
 * Writes a LEDGER ENTRY, never a bare balance update — the balance is derived
 * and an unexplained change to it would be unauditable.
 */
adminPeopleRouter.post(
  '/loyalty/adjust',
  requirePermission('loyalty:adjust'),
  validateBody(loyaltyAdjustmentSchema),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (client) => {
      const account = await queryOne<{ id: string; balance_points: number }>(
        `INSERT INTO loyalty_accounts (customer_id) VALUES ($1)
         ON CONFLICT (customer_id) DO UPDATE SET updated_at = now()
         RETURNING id, balance_points`,
        [req.body.customerId],
        client,
      );

      const balanceAfter = account!.balance_points + req.body.points;
      if (balanceAfter < 0) {
        throw new AppError({
          code: 'validation_failed',
          message: 'That adjustment would take the balance below zero',
        });
      }

      await client.query(
        `INSERT INTO loyalty_transactions (account_id, customer_id, type, points, balance_after, reason, actor_user_id)
         VALUES ($1, $2, 'adjustment', $3, $4, $5, $6)`,
        [
          account!.id,
          req.body.customerId,
          req.body.points,
          balanceAfter,
          req.body.reason,
          claimsOf(req).sub,
        ],
      );

      await client.query('UPDATE loyalty_accounts SET balance_points = $2 WHERE id = $1', [
        account!.id,
        balanceAfter,
      ]);

      await recordAudit(
        {
          action: 'loyalty.adjusted',
          resourceType: 'customer',
          resourceId: req.body.customerId,
          previousValue: { balancePoints: account!.balance_points },
          newValue: { balancePoints: balanceAfter, delta: req.body.points },
          reason: req.body.reason,
        },
        client,
      );

      return { balancePoints: balanceAfter };
    });

    sendOk(res, result);
  }),
);

// --- Drivers ---------------------------------------------------------------

adminPeopleRouter.get(
  '/drivers',
  requirePermission('driver:read'),
  asyncHandler(async (_req, res) => {
    const rows = await query<{
      id: string;
      full_name: string;
      phone: string;
      employee_id: string;
      state: string;
      rating: number | null;
      total_trips: number;
      employment_status: string;
      plate_number: string | null;
      last_location_at: Date | null;
      active_trips: number;
      completed_today: number;
      scheduled_next_4h: number;
      on_duty_minutes: number;
    }>(
      `SELECT d.id, u.full_name, u.phone, e.employee_id, d.state, d.rating, d.total_trips,
              e.employment_status, v.plate_number, d.last_location_at,
              (SELECT count(*) FROM trips t WHERE t.driver_id = d.id
                AND t.status IN ('DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED'))::int AS active_trips,
              (SELECT count(*) FROM trips t WHERE t.driver_id = d.id
                AND t.completed_at >= date_trunc('day', now()))::int AS completed_today,
              (SELECT count(*) FROM scheduled_rides s WHERE s.assigned_driver_id = d.id
                AND s.status IN ('scheduled','reassigned')
                AND s.scheduled_pickup_at BETWEEN now() AND now() + interval '4 hours')::int AS scheduled_next_4h,
              COALESCE(EXTRACT(EPOCH FROM (now() - d.went_online_at)) / 60, 0)::int AS on_duty_minutes
         FROM drivers d
         JOIN employees e ON e.id = d.employee_id
         JOIN users u ON u.id = e.user_id
         LEFT JOIN vehicles v ON v.id = d.assigned_vehicle_id
        WHERE d.deleted_at IS NULL
        ORDER BY u.full_name`,
    );

    sendOk(
      res,
      rows.map((row) => ({
        ...row,
        rating: row.rating === null ? null : Number(row.rating),
        workloadScore: computeWorkloadScore({
          activeTrips: row.active_trips,
          scheduledTripsNext4h: row.scheduled_next_4h,
          completedTripsToday: row.completed_today,
          onDutyMinutesToday: row.on_duty_minutes,
        }),
      })),
    );
  }),
);

adminPeopleRouter.get(
  '/drivers/:id',
  requirePermission('driver:read'),
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const driver = await queryOne<Record<string, unknown>>(
      `SELECT d.*, e.employee_id, e.job_title, e.employment_status, e.employment_date, e.photo_url,
              u.full_name, u.phone, u.email, u.status AS user_status,
              v.plate_number, v.make, v.model, v.color
         FROM drivers d
         JOIN employees e ON e.id = d.employee_id
         JOIN users u ON u.id = e.user_id
         LEFT JOIN vehicles v ON v.id = d.assigned_vehicle_id
        WHERE d.id = $1`,
      [param(req, 'id')],
    );
    if (!driver) throw notFound('Driver', param(req, 'id'));

    // Salary is payroll data. A dispatcher looking at driver availability has
    // no business seeing what that driver earns.
    if (!hasPermission(claimsOf(req), 'payroll:read')) {
      delete driver.basic_salary_minor;
    }

    const [trips, reviews, incidents, performance] = await Promise.all([
      query(
        `SELECT id, reference, status, final_fare_minor, completed_at, created_at
           FROM trips WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 25`,
        [param(req, 'id')],
      ),
      query(
        `SELECT driver_rating, service_rating, comment, created_at
           FROM reviews WHERE driver_id = $1 AND verified ORDER BY created_at DESC LIMIT 20`,
        [param(req, 'id')],
      ),
      query(
        `SELECT id, reference, type, status, created_at FROM emergency_incidents
          WHERE driver_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [param(req, 'id')],
      ),
      queryOne<{ trips: number; distance: number; minutes: number }>(
        `SELECT count(*)::int AS trips,
                COALESCE(SUM(actual_distance_metres), 0)::int AS distance,
                COALESCE(SUM(actual_duration_seconds), 0)::int / 60 AS minutes
           FROM trips
          WHERE driver_id = $1 AND completed_at >= date_trunc('month', now())`,
        [param(req, 'id')],
      ),
    ]);

    sendOk(res, { driver, trips, reviews, incidents, performanceThisMonth: performance });
  }),
);

/**
 * Create a driver.
 *
 * Creates the user, the employee record and the driver record in one
 * transaction, and grants the `driver` role — which carries no admin
 * permissions at all. A driver account is not a staff account.
 */
adminPeopleRouter.post(
  '/drivers',
  requirePermission('driver:write'),
  validateBody(createDriverSchema),
  asyncHandler(async (req, res) => {
    const phone = normalisePhone(req.body.phone);
    if (!phone) throw new AppError({ code: 'validation_failed', message: 'Enter a valid phone number' });

    const result = await withTransaction(async (client) => {
      const temporaryPassword = req.body.temporaryPassword ?? `${generateCode(4)}-${generateCode(4)}`;
      const passwordHash = await bcrypt.hash(temporaryPassword, 12);

      const user = await queryOne<{ id: string }>(
        `INSERT INTO users (principal_type, full_name, email, phone, password_hash, status)
         VALUES ('employee', $1, $2, $3, $4, 'active')
         RETURNING id`,
        [req.body.fullName, req.body.email?.toLowerCase() ?? null, phone, passwordHash],
        client,
      );

      const sequence = await queryOne<{ value: number }>(
        "SELECT nextval('seq_employee_reference')::int AS value",
        [],
        client,
      );

      const employee = await queryOne<{ id: string }>(
        `INSERT INTO employees (user_id, employee_id, job_title, employment_status, employment_date, basic_salary_minor)
         VALUES ($1, $2, $3, 'probation', $4, $5)
         RETURNING id`,
        [
          user!.id,
          req.body.employeeId ?? `EMP-${String(sequence?.value ?? 1).padStart(4, '0')}`,
          req.body.jobTitle,
          req.body.employmentDate,
          req.body.basicSalaryMinor,
        ],
        client,
      );

      const driver = await queryOne<{ id: string }>(
        `INSERT INTO drivers (employee_id, license_number, license_expiry, license_class, assigned_vehicle_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          employee!.id,
          req.body.licenseNumber,
          req.body.licenseExpiry,
          req.body.licenseClass ?? null,
          req.body.assignedVehicleId ?? null,
        ],
        client,
      );

      if (req.body.assignedVehicleId) {
        await client.query('UPDATE vehicles SET current_driver_id = $2 WHERE id = $1', [
          req.body.assignedVehicleId,
          driver!.id,
        ]);
      }

      const role = await queryOne<{ id: string }>("SELECT id FROM roles WHERE key = 'driver'", [], client);
      if (role) {
        await client.query(
          'INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $3)',
          [user!.id, role.id, claimsOf(req).sub],
        );
      }

      await recordAudit(
        {
          action: 'driver.created',
          resourceType: 'driver',
          resourceId: driver!.id,
          newValue: { fullName: req.body.fullName, employeeId: req.body.employeeId },
        },
        client,
      );

      return { driverId: driver!.id, employeeId: employee!.id, userId: user!.id, temporaryPassword };
    });

    // The temporary password is returned ONCE, for the operations manager to
    // hand over in person. It is never stored in readable form.
    sendCreated(res, result);
  }),
);

adminPeopleRouter.patch(
  '/drivers/:id',
  requirePermission('driver:write'),
  validateParams(idParams),
  validateBody(
    z.object({
      employmentStatus: z.enum(['active', 'probation', 'suspended', 'terminated', 'on_leave']).optional(),
      assignedVehicleId: z.string().uuid().nullable().optional(),
      basicSalaryMinor: z.number().int().nonnegative().optional(),
      licenseExpiry: z.string().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.body as Record<string, unknown>;

    const before = await queryOne<Record<string, unknown>>(
      `SELECT d.id, d.assigned_vehicle_id, e.employment_status, e.basic_salary_minor
         FROM drivers d JOIN employees e ON e.id = d.employee_id WHERE d.id = $1`,
      [param(req, 'id')],
    );
    if (!before) throw notFound('Driver', param(req, 'id'));

    // Salary is HR/payroll territory, separate from ordinary driver admin.
    if (body.basicSalaryMinor !== undefined && !hasPermission(claimsOf(req), 'payroll:write')) {
      throw new AppError({ code: 'forbidden', message: 'You cannot change salary information' });
    }

    await withTransaction(async (client) => {
      if (body.employmentStatus !== undefined || body.basicSalaryMinor !== undefined) {
        await client.query(
          `UPDATE employees
              SET employment_status = COALESCE($2, employment_status),
                  basic_salary_minor = COALESCE($3, basic_salary_minor)
            WHERE id = (SELECT employee_id FROM drivers WHERE id = $1)`,
          [param(req, 'id'), body.employmentStatus ?? null, body.basicSalaryMinor ?? null],
        );
      }

      if (body.assignedVehicleId !== undefined || body.licenseExpiry !== undefined) {
        await client.query(
          `UPDATE drivers
              SET assigned_vehicle_id = COALESCE($2, assigned_vehicle_id),
                  license_expiry = COALESCE($3, license_expiry)
            WHERE id = $1`,
          [param(req, 'id'), body.assignedVehicleId ?? null, body.licenseExpiry ?? null],
        );
      }

      // A terminated or suspended driver goes offline immediately — they must
      // not remain dispatchable.
      if (body.employmentStatus === 'terminated' || body.employmentStatus === 'suspended') {
        await client.query(`UPDATE drivers SET state = 'SUSPENDED' WHERE id = $1`, [param(req, 'id')]);
      }

      await recordAudit(
        {
          action: 'driver.updated',
          resourceType: 'driver',
          resourceId: param(req, 'id'),
          previousValue: before,
          newValue: body,
        },
        client,
      );
    });

    sendOk(res, { updated: true });
  }),
);

// --- Roles -----------------------------------------------------------------

adminPeopleRouter.get(
  '/roles',
  requirePermission('user:manage_roles'),
  asyncHandler(async (_req, res) => {
    sendOk(
      res,
      await query(
        `SELECT r.id, r.key, r.name, r.description, r.is_system,
                COALESCE(array_agg(rp.permission_key) FILTER (WHERE rp.permission_key IS NOT NULL), '{}') AS permissions,
                (SELECT count(*) FROM user_roles ur WHERE ur.role_id = r.id)::int AS user_count
           FROM roles r
           LEFT JOIN role_permissions rp ON rp.role_id = r.id
          GROUP BY r.id
          ORDER BY r.name`,
      ),
    );
  }),
);

adminPeopleRouter.post(
  '/users/:id/roles',
  requirePermission('user:manage_roles'),
  validateParams(idParams),
  validateBody(assignRolesSchema),
  asyncHandler(async (req, res) => {
    const actor = claimsOf(req);

    // Nobody edits their own permissions. It is the simplest privilege
    // escalation there is, and the easiest to prevent.
    if (actor.sub === param(req, 'id')) {
      throw new AppError({ code: 'forbidden', message: 'You cannot change your own roles' });
    }

    await withTransaction(async (client) => {
      const before = await query<{ key: string }>(
        'SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1',
        [param(req, 'id')],
        client,
      );

      await client.query('DELETE FROM user_roles WHERE user_id = $1', [param(req, 'id')]);

      for (const key of req.body.roleKeys as string[]) {
        const role = await queryOne<{ id: string }>('SELECT id FROM roles WHERE key = $1', [key], client);
        if (!role) throw notFound('Role', key);
        await client.query(
          'INSERT INTO user_roles (user_id, role_id, granted_by) VALUES ($1, $2, $3)',
          [param(req, 'id'), role.id, actor.sub],
        );
      }

      await recordAudit(
        {
          action: 'user.role_changed',
          resourceType: 'user',
          resourceId: param(req, 'id'),
          previousValue: { roles: before.map((row) => row.key) },
          newValue: { roles: req.body.roleKeys },
          reason: req.body.reason ?? null,
        },
        client,
      );
    });

    // Existing sessions carry the old permissions in their token; revoking them
    // forces a refresh so a removed permission actually takes effect.
    await query(
      `UPDATE auth_sessions SET revoked_at = now(), revoked_reason = 'roles_changed'
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [param(req, 'id')],
    );

    sendOk(res, { updated: true });
  }),
);
