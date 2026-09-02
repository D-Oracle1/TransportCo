import { Router } from 'express';
import { z } from 'zod';
import { pageQuerySchema, payrollItemSchema, pricingRuleSetSchema, refundSchema } from '@transportco/validation';
import { formatMoney } from '@transportco/utils';
import { asyncHandler, paginate, param, sendCreated, sendOk } from '../../lib/http';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate';
import { authenticate, claimsOf, requirePermission } from '../../middleware/auth';
import { query, queryOne, withTransaction } from '../../db/pool';
import { AppError, notFound } from '../../lib/errors';
import { recordAudit } from '../../services/audit';
import { getAdapter } from '../../services/payments';
import { contributionMargin } from '../../domain/pricing/engine';
import { evaluateAdminRisk } from '../../domain/fraud/rules';
import {
  getActivePricingRuleSet,
  getPricingRuleSetById,
  listPricingRuleSets,
  nextVersionFor,
  toPricingRuleSet,
  type PricingRow,
} from '../pricing/repository';

/**
 * Business administration: pricing, finance, payroll, reporting and the audit
 * trail. This is where the money lives, so every route is permission-gated and
 * every mutation writes an audit entry.
 */
export const adminBusinessRouter = Router();

adminBusinessRouter.use(authenticate);

const idParams = z.object({ id: z.string().uuid() });

// --- Pricing ---------------------------------------------------------------

adminBusinessRouter.get(
  '/pricing',
  requirePermission('pricing:read'),
  asyncHandler(async (_req, res) => {
    sendOk(res, await listPricingRuleSets());
  }),
);

adminBusinessRouter.get(
  '/pricing/active',
  requirePermission('pricing:read'),
  asyncHandler(async (_req, res) => {
    sendOk(res, await getActivePricingRuleSet());
  }),
);

/**
 * Create a pricing DRAFT.
 *
 * Never edits a published set — that is refused by a database trigger. A change
 * is always a new version, so a completed trip can be re-priced exactly as it
 * was sold, however many times the price list has moved since.
 */
adminBusinessRouter.post(
  '/pricing',
  requirePermission('pricing:write'),
  validateBody(pricingRuleSetSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof pricingRuleSetSchema>;
    const version = await nextVersionFor(body.zoneId ?? null);

    const row = await queryOne<PricingRow>(
      `INSERT INTO pricing_rule_sets (
         version, name, status, zone_id, effective_from,
         base_fare_minor, per_kilometre_minor, per_minute_minor, minimum_fare_minor, maximum_fare_minor,
         round_to_nearest_minor, included_passengers, extra_passenger_fee_minor, max_passengers,
         long_distance_threshold_metres, long_distance_per_km_minor,
         scheduled_ride_multiplier, demand_multiplier, demand_multiplier_max,
         peak, night, weekend, public_holiday, public_holiday_dates,
         negotiation, cancellation, loyalty, cost_model,
         created_by_user_id, change_note
       ) VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
       RETURNING *`,
      [
        version,
        body.name,
        body.zoneId ?? null,
        body.effectiveFrom,
        body.baseFareMinor,
        body.perKilometreMinor,
        body.perMinuteMinor,
        body.minimumFareMinor,
        body.maximumFareMinor ?? null,
        body.roundToNearestMinor,
        body.includedPassengers,
        body.extraPassengerFeeMinor,
        body.maxPassengers,
        body.longDistanceThresholdMetres,
        body.longDistancePerKilometreMinor,
        body.scheduledRideMultiplier,
        body.demandMultiplier,
        body.demandMultiplierMax,
        JSON.stringify(body.peak),
        JSON.stringify(body.night),
        JSON.stringify(body.weekend),
        JSON.stringify(body.publicHoliday),
        JSON.stringify(body.publicHolidayDates),
        JSON.stringify(body.negotiation),
        JSON.stringify(body.cancellation),
        JSON.stringify(body.loyalty),
        JSON.stringify(body.costModel),
        claimsOf(req).sub,
        body.changeNote ?? null,
      ],
    );

    await recordAudit({
      action: 'pricing.created',
      resourceType: 'pricing_rule_set',
      resourceId: row!.id,
      newValue: { version, name: body.name },
      reason: body.changeNote ?? null,
    });

    sendCreated(res, toPricingRuleSet(row!));
  }),
);

/**
 * Publish a draft.
 *
 * Separate permission from `pricing:write` on purpose: writing a draft is
 * analysis, publishing changes what every customer is charged from the next
 * quote onward.
 */
adminBusinessRouter.post(
  '/pricing/:id/publish',
  requirePermission('pricing:publish'),
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const result = await withTransaction(async (client) => {
      const draft = await queryOne<PricingRow>(
        'SELECT * FROM pricing_rule_sets WHERE id = $1 FOR UPDATE',
        [param(req, 'id')],
        client,
      );
      if (!draft) throw notFound('Pricing rule set', param(req, 'id'));

      if (draft.status !== 'draft') {
        throw new AppError({ code: 'conflict', message: 'Only a draft can be published' });
      }

      // Archive the incumbent first: the partial unique index permits exactly
      // one published set per zone, and that is the guarantee worth keeping.
      const previous = await queryOne<PricingRow>(
        `UPDATE pricing_rule_sets
            SET status = 'archived', effective_to = now()
          WHERE status = 'published' AND zone_id IS NOT DISTINCT FROM $1
          RETURNING *`,
        [draft.zone_id],
        client,
      );

      const published = await queryOne<PricingRow>(
        `UPDATE pricing_rule_sets
            SET status = 'published', published_at = now(), published_by_user_id = $2,
                effective_from = GREATEST(effective_from, now())
          WHERE id = $1
          RETURNING *`,
        [param(req, 'id'), claimsOf(req).sub],
        client,
      );

      await recordAudit(
        {
          action: 'pricing.published',
          resourceType: 'pricing_rule_set',
          resourceId: param(req, 'id'),
          previousValue: previous ? { version: previous.version, id: previous.id } : null,
          newValue: { version: published!.version, id: published!.id },
          reason: draft.change_note,
        },
        client,
      );

      return toPricingRuleSet(published!);
    });

    sendOk(res, result);
  }),
);

// --- Payments & refunds ----------------------------------------------------

adminBusinessRouter.get(
  '/payments',
  requirePermission('payment:read'),
  validateQuery(pageQuerySchema.extend({ status: z.string().optional(), method: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const { page, pageSize, status, method } = req.query as unknown as {
      page: number;
      pageSize: number;
      status?: string;
      method?: string;
    };

    const filters = `($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR p.method = $2)`;

    const [rows, count] = await Promise.all([
      query(
        `SELECT p.id, p.reference, p.method, p.provider, p.amount_minor, p.status, p.purpose,
                p.verified_at, p.verification_source, p.paid_at, p.created_at,
                t.reference AS trip_reference, u.full_name AS customer_name,
                du.full_name AS collected_by
           FROM payments p
           JOIN customers c ON c.id = p.customer_id
           JOIN users u ON u.id = c.user_id
           LEFT JOIN trips t ON t.id = p.trip_id
           LEFT JOIN drivers d ON d.id = p.collected_by_driver_id
           LEFT JOIN employees e ON e.id = d.employee_id
           LEFT JOIN users du ON du.id = e.user_id
          WHERE ${filters}
          ORDER BY p.created_at DESC
          LIMIT $3 OFFSET $4`,
        [status ?? null, method ?? null, pageSize, (page - 1) * pageSize],
      ),
      queryOne<{ count: number }>(
        `SELECT count(*)::int AS count FROM payments p WHERE ${filters}`,
        [status ?? null, method ?? null],
      ),
    ]);

    sendOk(res, paginate(rows, count?.count ?? 0, page, pageSize));
  }),
);

/** Cash reconciliation: what each driver collected and has to hand in. */
adminBusinessRouter.get(
  '/payments/cash-reconciliation',
  requirePermission('payment:reconcile'),
  validateQuery(z.object({ from: z.string().optional(), to: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as { from?: string; to?: string };

    const rows = await query<{
      driver_id: string;
      driver_name: string;
      trips: number;
      collected_minor: number;
    }>(
      `SELECT p.collected_by_driver_id AS driver_id, u.full_name AS driver_name,
              count(*)::int AS trips, SUM(p.amount_minor)::bigint AS collected_minor
         FROM payments p
         JOIN drivers d ON d.id = p.collected_by_driver_id
         JOIN employees e ON e.id = d.employee_id
         JOIN users u ON u.id = e.user_id
        WHERE p.method = 'cash' AND p.status = 'succeeded'
          AND p.paid_at >= COALESCE($1::timestamptz, date_trunc('day', now()))
          AND p.paid_at < COALESCE($2::timestamptz, now() + interval '1 day')
        GROUP BY p.collected_by_driver_id, u.full_name
        ORDER BY collected_minor DESC`,
      [from ?? null, to ?? null],
    );

    const total = rows.reduce((sum, row) => sum + Number(row.collected_minor), 0);

    sendOk(res, {
      totalMinor: total,
      totalLabel: formatMoney(total),
      drivers: rows.map((row) => ({
        ...row,
        collected_minor: Number(row.collected_minor),
        collectedLabel: formatMoney(Number(row.collected_minor)),
      })),
    });
  }),
);

/**
 * Refund.
 *
 * Requested here and, above a threshold, approved by someone else — the table
 * refuses a row where the approver is the requester. Refund velocity per
 * administrator is monitored as an insider-risk signal.
 */
adminBusinessRouter.post(
  '/payments/refunds',
  requirePermission('payment:refund'),
  validateBody(refundSchema),
  asyncHandler(async (req, res) => {
    const actor = claimsOf(req);

    const payment = await queryOne<{
      id: string;
      trip_id: string | null;
      amount_minor: number;
      status: string;
      provider: 'paystack' | 'flutterwave' | 'cash' | 'mock';
      provider_reference: string | null;
    }>('SELECT * FROM payments WHERE id = $1', [req.body.paymentId]);

    if (!payment) throw notFound('Payment', req.body.paymentId);
    if (payment.status !== 'succeeded') {
      throw new AppError({ code: 'conflict', message: 'Only a settled payment can be refunded' });
    }

    const alreadyRefunded = await queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS total FROM refunds
        WHERE payment_id = $1 AND status IN ('approved','processing','succeeded')`,
      [payment.id],
    );

    if (Number(alreadyRefunded?.total ?? 0) + req.body.amountMinor > payment.amount_minor) {
      throw new AppError({
        code: 'validation_failed',
        message: 'That would refund more than was paid',
      });
    }

    const refund = await queryOne<{ id: string }>(
      `INSERT INTO refunds (payment_id, trip_id, amount_minor, reason, status, requested_by_user_id)
       VALUES ($1, $2, $3, $4, 'requested', $5)
       RETURNING id`,
      [payment.id, payment.trip_id, req.body.amountMinor, req.body.reason, actor.sub],
    );

    let providerResult: { status: string; providerReference: string } | null = null;

    // Cash refunds are handed over in person and settled by Finance; only card
    // and transfer payments go back through a provider.
    if (payment.provider !== 'cash' && payment.provider_reference) {
      const adapter = getAdapter(payment.provider);
      if (adapter.refund) {
        const result = await adapter.refund({
          providerReference: payment.provider_reference,
          amountMinor: req.body.amountMinor,
          reason: req.body.reason,
        });
        providerResult = { status: result.status, providerReference: result.providerReference };

        await query(
          `UPDATE refunds SET status = $2, provider_reference = $3,
                  processed_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE NULL END
            WHERE id = $1`,
          [refund!.id, result.status, result.providerReference],
        );
      }
    }

    const fullyRefunded = Number(alreadyRefunded?.total ?? 0) + req.body.amountMinor >= payment.amount_minor;

    await query(`UPDATE payments SET status = $2 WHERE id = $1`, [
      payment.id,
      fullyRefunded ? 'refunded' : 'partially_refunded',
    ]);

    if (payment.trip_id) {
      await query(`UPDATE trips SET payment_status = $2 WHERE id = $1`, [
        payment.trip_id,
        fullyRefunded ? 'refunded' : 'partially_refunded',
      ]);
    }

    await recordAudit({
      action: 'payment.refunded',
      resourceType: 'payment',
      resourceId: payment.id,
      newValue: { amountMinor: req.body.amountMinor, refundId: refund!.id },
      reason: req.body.reason,
    });

    void evaluateAdminRisk(actor.sub);

    sendCreated(res, { refundId: refund!.id, provider: providerResult });
  }),
);

adminBusinessRouter.post(
  '/balances/:id/write-off',
  requirePermission('balance:write_off'),
  validateParams(idParams),
  validateBody(z.object({ reason: z.string().trim().min(5).max(300) })),
  asyncHandler(async (req, res) => {
    const balance = await queryOne<{ id: string; customer_id: string; amount_minor: number }>(
      'SELECT id, customer_id, amount_minor FROM outstanding_balances WHERE id = $1',
      [param(req, 'id')],
    );
    if (!balance) throw notFound('Balance', param(req, 'id'));

    await query(
      `UPDATE outstanding_balances
          SET status = 'written_off', written_off_by_user_id = $2, note = $3, settled_at = now()
        WHERE id = $1`,
      [balance.id, claimsOf(req).sub, req.body.reason],
    );

    const remaining = await queryOne<{ total: number }>(
      `SELECT COALESCE(SUM(amount_minor - settled_amount_minor), 0)::bigint AS total
         FROM outstanding_balances
        WHERE customer_id = $1 AND status IN ('outstanding','partially_settled')`,
      [balance.customer_id],
    );

    await query('UPDATE customers SET has_outstanding_balance = $2 WHERE id = $1', [
      balance.customer_id,
      Number(remaining?.total ?? 0) > 0,
    ]);

    await recordAudit({
      action: 'balance.written_off',
      resourceType: 'outstanding_balance',
      resourceId: balance.id,
      newValue: { amountMinor: balance.amount_minor },
      reason: req.body.reason,
    });

    sendOk(res, { writtenOff: true });
  }),
);

// --- Payroll ---------------------------------------------------------------

adminBusinessRouter.get(
  '/payroll/periods',
  requirePermission('payroll:read'),
  asyncHandler(async (_req, res) => {
    sendOk(
      res,
      await query(
        `SELECT p.*, (SELECT count(*) FROM payroll_records r WHERE r.period_id = p.id)::int AS record_count
           FROM payroll_periods p ORDER BY p.period_start DESC LIMIT 24`,
      ),
    );
  }),
);

/**
 * Open a payroll period and generate a draft slip per active employee.
 *
 * Performance figures are attached at generation time so the bonus conversation
 * has evidence behind it: trips run, distance driven, hours on duty, rating,
 * incidents.
 */
adminBusinessRouter.post(
  '/payroll/periods',
  requirePermission('payroll:write'),
  validateBody(
    z.object({
      periodStart: z.string(),
      periodEnd: z.string(),
      note: z.string().max(500).optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const actor = claimsOf(req);

    const result = await withTransaction(async (client) => {
      const sequence = await queryOne<{ value: number }>(
        "SELECT nextval('seq_payroll_reference')::int AS value",
        [],
        client,
      );

      const period = await queryOne<{ id: string; reference: string }>(
        `INSERT INTO payroll_periods (reference, period_start, period_end, prepared_by_user_id, note)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, reference`,
        [
          `PAY-${String(sequence?.value ?? 1).padStart(4, '0')}`,
          req.body.periodStart,
          req.body.periodEnd,
          actor.sub,
          req.body.note ?? null,
        ],
        client,
      );

      const employees = await query<{ id: string; basic_salary_minor: number; driver_id: string | null }>(
        `SELECT e.id, e.basic_salary_minor, d.id AS driver_id
           FROM employees e
           LEFT JOIN drivers d ON d.employee_id = e.id
          WHERE e.employment_status IN ('active','probation') AND e.deleted_at IS NULL`,
        [],
        client,
      );

      for (const employee of employees) {
        const performance = employee.driver_id
          ? await queryOne<{ trips: number; distance: number; minutes: number; rating: number | null; incidents: number }>(
              `SELECT
                 (SELECT count(*) FROM trips t WHERE t.driver_id = $1 AND t.status = 'COMPLETED'
                    AND t.completed_at BETWEEN $2 AND $3)::int AS trips,
                 (SELECT COALESCE(SUM(actual_distance_metres), 0) FROM trips t WHERE t.driver_id = $1
                    AND t.completed_at BETWEEN $2 AND $3)::int AS distance,
                 (SELECT COALESCE(SUM(actual_duration_seconds), 0) / 60 FROM trips t WHERE t.driver_id = $1
                    AND t.completed_at BETWEEN $2 AND $3)::int AS minutes,
                 (SELECT ROUND(AVG(driver_rating)::numeric, 2) FROM reviews r WHERE r.driver_id = $1
                    AND r.created_at BETWEEN $2 AND $3) AS rating,
                 (SELECT count(*) FROM emergency_incidents i WHERE i.driver_id = $1
                    AND i.created_at BETWEEN $2 AND $3)::int AS incidents`,
              [employee.driver_id, req.body.periodStart, req.body.periodEnd],
              client,
            )
          : null;

        await client.query(
          `INSERT INTO payroll_records (period_id, employee_id, basic_salary_minor, gross_minor, net_minor, performance)
           VALUES ($1, $2, $3, $3, $3, $4)`,
          [
            period!.id,
            employee.id,
            employee.basic_salary_minor,
            JSON.stringify({
              trips: performance?.trips ?? 0,
              distanceMetres: performance?.distance ?? 0,
              onDutyMinutes: performance?.minutes ?? 0,
              averageRating: performance?.rating ?? null,
              incidents: performance?.incidents ?? 0,
            }),
          ],
        );
      }

      await recomputePeriodTotals(client, period!.id);

      return { periodId: period!.id, reference: period!.reference, employees: employees.length };
    });

    sendCreated(res, result);
  }),
);

adminBusinessRouter.get(
  '/payroll/periods/:id',
  requirePermission('payroll:read'),
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const period = await queryOne('SELECT * FROM payroll_periods WHERE id = $1', [param(req, 'id')]);
    if (!period) throw notFound('Payroll period', param(req, 'id'));

    const records = await query(
      `SELECT r.*, u.full_name, e.employee_id AS employee_reference, e.job_title
         FROM payroll_records r
         JOIN employees e ON e.id = r.employee_id
         JOIN users u ON u.id = e.user_id
        WHERE r.period_id = $1
        ORDER BY u.full_name`,
      [param(req, 'id')],
    );

    sendOk(res, { period, records });
  }),
);

adminBusinessRouter.post(
  '/payroll/records/:id/items',
  requirePermission('payroll:write'),
  validateParams(idParams),
  validateBody(payrollItemSchema),
  asyncHandler(async (req, res) => {
    const record = await queryOne<{ id: string; period_id: string; status: string }>(
      'SELECT id, period_id, status FROM payroll_records WHERE id = $1',
      [param(req, 'id')],
    );
    if (!record) throw notFound('Payroll record', param(req, 'id'));

    // An approved slip is a commitment. Changing it after approval would let a
    // number move between sign-off and payment.
    if (record.status !== 'draft') {
      throw new AppError({ code: 'conflict', message: 'This payroll record is no longer editable' });
    }

    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO payroll_items (payroll_record_id, type, label, amount_minor, quantity, note, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          record.id,
          req.body.type,
          req.body.label,
          req.body.amountMinor,
          req.body.quantity ?? null,
          req.body.note ?? null,
          claimsOf(req).sub,
        ],
      );

      await recomputeRecordTotals(client, record.id);
      await recomputePeriodTotals(client, record.period_id);
    });

    sendOk(res, { added: true });
  }),
);

/**
 * Approve a payroll run.
 *
 * `payroll:approve` is held by nobody who also holds `payroll:write` in the
 * seeded roles, and the table refuses a row where approver equals preparer. One
 * person must not be able to both write a salary and sign it off.
 */
adminBusinessRouter.post(
  '/payroll/periods/:id/approve',
  requirePermission('payroll:approve'),
  validateParams(idParams),
  asyncHandler(async (req, res) => {
    const actor = claimsOf(req);

    const period = await queryOne<{ id: string; status: string; prepared_by_user_id: string | null; total_net_minor: number }>(
      'SELECT id, status, prepared_by_user_id, total_net_minor FROM payroll_periods WHERE id = $1',
      [param(req, 'id')],
    );
    if (!period) throw notFound('Payroll period', param(req, 'id'));

    if (period.prepared_by_user_id === actor.sub) {
      throw new AppError({
        code: 'forbidden',
        message: 'You cannot approve a payroll run you prepared',
      });
    }

    if (!['draft', 'pending_approval'].includes(period.status)) {
      throw new AppError({ code: 'conflict', message: 'This payroll run cannot be approved' });
    }

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE payroll_periods SET status = 'approved', approved_by_user_id = $2, approved_at = now()
          WHERE id = $1`,
        [period.id, actor.sub],
      );
      await client.query(`UPDATE payroll_records SET status = 'approved' WHERE period_id = $1`, [period.id]);

      await recordAudit(
        {
          action: 'payroll.approved',
          resourceType: 'payroll_period',
          resourceId: period.id,
          previousValue: { status: period.status },
          newValue: { status: 'approved', totalNetMinor: period.total_net_minor },
        },
        client,
      );
    });

    sendOk(res, { approved: true });
  }),
);

async function recomputeRecordTotals(client: Parameters<typeof queryOne>[2], recordId: string): Promise<void> {
  await (client as NonNullable<typeof client>).query(
    `UPDATE payroll_records r
        SET allowances_minor = t.allowances, bonuses_minor = t.bonuses, overtime_minor = t.overtime,
            deductions_minor = t.deductions, penalties_minor = t.penalties,
            gross_minor = r.basic_salary_minor + t.allowances + t.bonuses + t.overtime,
            net_minor = r.basic_salary_minor + t.allowances + t.bonuses + t.overtime - t.deductions - t.penalties
       FROM (
         SELECT COALESCE(SUM(amount_minor) FILTER (WHERE type = 'allowance'), 0) AS allowances,
                COALESCE(SUM(amount_minor) FILTER (WHERE type = 'bonus'), 0) AS bonuses,
                COALESCE(SUM(amount_minor) FILTER (WHERE type = 'overtime'), 0) AS overtime,
                COALESCE(SUM(amount_minor) FILTER (WHERE type = 'deduction'), 0) AS deductions,
                COALESCE(SUM(amount_minor) FILTER (WHERE type = 'penalty'), 0) AS penalties
           FROM payroll_items WHERE payroll_record_id = $1
       ) t
      WHERE r.id = $1`,
    [recordId],
  );
}

async function recomputePeriodTotals(client: Parameters<typeof queryOne>[2], periodId: string): Promise<void> {
  await (client as NonNullable<typeof client>).query(
    `UPDATE payroll_periods p
        SET total_gross_minor = t.gross, total_deductions_minor = t.deductions, total_net_minor = t.net
       FROM (
         SELECT COALESCE(SUM(gross_minor), 0) AS gross,
                COALESCE(SUM(deductions_minor + penalties_minor), 0) AS deductions,
                COALESCE(SUM(net_minor), 0) AS net
           FROM payroll_records WHERE period_id = $1
       ) t
      WHERE p.id = $1`,
    [periodId],
  );
}

// --- Reports ---------------------------------------------------------------

/**
 * Management KPIs, including the question the negotiation feature has to
 * answer: is discounting winning enough volume to pay for itself?
 */
adminBusinessRouter.get(
  '/reports/kpis',
  requirePermission('report:read'),
  validateQuery(z.object({ from: z.string().optional(), to: z.string().optional() })),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as { from?: string; to?: string };
    const params = [from ?? null, to ?? null];

    const window = `t.created_at >= COALESCE($1::timestamptz, date_trunc('month', now()))
                    AND t.created_at < COALESCE($2::timestamptz, now() + interval '1 day')`;

    const [totals, negotiation, operations] = await Promise.all([
      queryOne<Record<string, number>>(
        `SELECT count(*)::int AS total_trips,
                count(*) FILTER (WHERE t.status = 'COMPLETED')::int AS completed_trips,
                count(*) FILTER (WHERE t.status = 'CANCELLED')::int AS cancelled_trips,
                COALESCE(AVG(t.final_fare_minor) FILTER (WHERE t.final_fare_minor IS NOT NULL), 0)::bigint AS avg_fare,
                COALESCE(SUM(t.final_fare_minor) FILTER (WHERE t.payment_status = 'paid'), 0)::bigint AS revenue,
                COALESCE(SUM(t.actual_distance_metres), 0)::bigint AS distance,
                COUNT(DISTINCT t.customer_id)::int AS active_customers,
                COUNT(DISTINCT t.driver_id)::int AS active_drivers
           FROM trips t WHERE ${window}`,
        params,
      ),
      queryOne<Record<string, number>>(
        `SELECT count(*)::int AS negotiations,
                count(*) FILTER (WHERE n.status = 'ACCEPTED')::int AS accepted,
                COALESCE(AVG(n.original_fare_minor), 0)::bigint AS avg_original,
                COALESCE(AVG(n.final_fare_minor) FILTER (WHERE n.final_fare_minor IS NOT NULL), 0)::bigint AS avg_final,
                COALESCE(SUM(n.original_fare_minor - n.final_fare_minor) FILTER (WHERE n.final_fare_minor IS NOT NULL), 0)::bigint AS total_discount,
                count(*) FILTER (WHERE n.customer_rounds_used > 0)::int AS negotiated_count
           FROM negotiations n
           JOIN trips t ON t.id = n.trip_id
          WHERE ${window}`,
        params,
      ),
      queryOne<Record<string, number>>(
        `SELECT COALESCE(AVG(EXTRACT(EPOCH FROM (t.driver_arrived_at - t.assigned_at))), 0)::int AS avg_pickup_seconds,
                COALESCE(AVG(t.actual_duration_seconds), 0)::int AS avg_trip_seconds,
                (SELECT count(*) FROM payments p WHERE p.status = 'succeeded'
                   AND p.created_at >= COALESCE($1::timestamptz, date_trunc('month', now())))::int AS payments_succeeded,
                (SELECT count(*) FROM payments p WHERE p.created_at >= COALESCE($1::timestamptz, date_trunc('month', now())))::int AS payments_total,
                (SELECT count(*) FROM support_tickets s WHERE s.created_at >= COALESCE($1::timestamptz, date_trunc('month', now())))::int AS tickets,
                (SELECT count(*) FROM customers c WHERE c.created_at >= COALESCE($1::timestamptz, date_trunc('month', now())))::int AS new_customers
           FROM trips t WHERE ${window} AND t.status = 'COMPLETED'`,
        params,
      ),
    ]);

    const rules = await getActivePricingRuleSet();

    // Read every aggregate through a single coercion helper. Postgres returns
    // BIGINT sums as numbers and NULL for an empty window; normalising once
    // here keeps every ratio below free of null-guard noise.
    const n = (source: Record<string, number> | null, key: string): number => Number(source?.[key] ?? 0);
    const rate = (numerator: number, denominator: number): number =>
      denominator > 0 ? Math.round((numerator / denominator) * 1000) / 10 : 0;

    const totalTrips = n(totals, 'total_trips');
    const completed = n(totals, 'completed_trips');
    const cancelled = n(totals, 'cancelled_trips');
    const revenue = n(totals, 'revenue');
    const distance = n(totals, 'distance');
    const activeDrivers = n(totals, 'active_drivers');

    const negotiated = n(negotiation, 'negotiated_count');
    const accepted = n(negotiation, 'accepted');
    const averageOriginal = n(negotiation, 'avg_original');
    const averageFinal = n(negotiation, 'avg_final');

    const paymentsTotal = n(operations, 'payments_total');
    const paymentsSucceeded = n(operations, 'payments_succeeded');

    const vehicles = await queryOne<{ count: number }>(
      "SELECT count(*)::int AS count FROM vehicles WHERE status = 'active' AND deleted_at IS NULL",
    );
    const vehicleCount = vehicles?.count ?? 0;

    // Contribution margin across the window: revenue less the fuel, driver and
    // operating cost the active rule set says each trip carries.
    const margin = contributionMargin(rules, {
      quotedFareMinor: Math.round(averageOriginal * completed),
      finalFareMinor: revenue,
      distanceMetres: distance,
      paidByCard: false,
    });

    sendOk(res, {
      trips: {
        total: totalTrips,
        completed,
        cancelled,
        cancellationRate: rate(cancelled, totalTrips),
      },
      revenue: {
        totalMinor: revenue,
        totalLabel: formatMoney(revenue),
        averageFareMinor: n(totals, 'avg_fare'),
        perVehicleMinor: vehicleCount > 0 ? Math.round(revenue / vehicleCount) : 0,
        perDriverMinor: activeDrivers > 0 ? Math.round(revenue / activeDrivers) : 0,
      },
      negotiation: {
        total: n(negotiation, 'negotiations'),
        negotiated,
        accepted,
        // The number management actually asks for: of the customers who haggled,
        // how many did we close?
        acceptanceRate: rate(accepted, negotiated),
        averageOriginalFareMinor: averageOriginal,
        averageFinalFareMinor: averageFinal,
        averageDiscountPercent: rate(averageOriginal - averageFinal, averageOriginal),
        totalDiscountMinor: n(negotiation, 'total_discount'),
        totalDiscountLabel: formatMoney(n(negotiation, 'total_discount')),
      },
      operations: {
        averagePickupSeconds: n(operations, 'avg_pickup_seconds'),
        averageTripSeconds: n(operations, 'avg_trip_seconds'),
        paymentSuccessRate: rate(paymentsSucceeded, paymentsTotal),
        supportTickets: n(operations, 'tickets'),
        newCustomers: n(operations, 'new_customers'),
        activeCustomers: n(totals, 'active_customers'),
      },
      contributionMargin: {
        ...margin,
        contributionMarginLabel: formatMoney(margin.contributionMarginMinor),
      },
    });
  }),
);

// --- Audit -----------------------------------------------------------------

adminBusinessRouter.get(
  '/audit-logs',
  requirePermission('audit:read'),
  validateQuery(
    pageQuerySchema.extend({
      action: z.string().optional(),
      resourceType: z.string().optional(),
      actorUserId: z.string().uuid().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { page, pageSize, action, resourceType, actorUserId } = req.query as unknown as {
      page: number;
      pageSize: number;
      action?: string;
      resourceType?: string;
      actorUserId?: string;
    };

    const filters = `($1::text IS NULL OR a.action = $1)
                     AND ($2::text IS NULL OR a.resource_type = $2)
                     AND ($3::uuid IS NULL OR a.actor_user_id = $3)`;
    const params = [action ?? null, resourceType ?? null, actorUserId ?? null];

    const [rows, count] = await Promise.all([
      query(
        `SELECT a.*, u.full_name AS actor_name
           FROM audit_logs a
           LEFT JOIN users u ON u.id = a.actor_user_id
          WHERE ${filters}
          ORDER BY a.created_at DESC
          LIMIT $4 OFFSET $5`,
        [...params, pageSize, (page - 1) * pageSize],
      ),
      queryOne<{ count: number }>(`SELECT count(*)::int AS count FROM audit_logs a WHERE ${filters}`, params),
    ]);

    sendOk(res, paginate(rows, count?.count ?? 0, page, pageSize));
  }),
);

adminBusinessRouter.get(
  '/fraud-signals',
  requirePermission('audit:read'),
  asyncHandler(async (_req, res) => {
    sendOk(
      res,
      await query(
        `SELECT * FROM fraud_signals
          WHERE status IN ('open','reviewing')
          ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC
          LIMIT 100`,
      ),
    );
  }),
);

/**
 * Data export.
 *
 * TransportCo owns its data and must be able to take it out. Exports are
 * themselves audited — a bulk export is exactly the event you want a record of.
 */
adminBusinessRouter.get(
  '/export/:dataset',
  requirePermission('report:read'),
  validateParams(z.object({ dataset: z.enum(['trips', 'payments', 'customers', 'negotiations']) })),
  asyncHandler(async (req, res) => {
    const dataset = param(req, 'dataset') as 'trips' | 'payments' | 'customers' | 'negotiations';

    const queries: Record<typeof dataset, string> = {
      trips: `SELECT reference, status, type, pickup_address, destination_address, distance_metres,
                     quoted_fare_minor, final_fare_minor, payment_method, payment_status, created_at, completed_at
                FROM trips ORDER BY created_at DESC LIMIT 10000`,
      payments: `SELECT reference, method, provider, amount_minor, status, verification_source, paid_at, created_at
                   FROM payments ORDER BY created_at DESC LIMIT 10000`,
      customers: `SELECT c.reference, c.total_trips, c.rating, c.created_at
                    FROM customers c ORDER BY c.created_at DESC LIMIT 10000`,
      negotiations: `SELECT n.id, t.reference, n.original_fare_minor, n.final_fare_minor,
                            n.customer_rounds_used, n.status, n.created_at
                       FROM negotiations n JOIN trips t ON t.id = n.trip_id
                      ORDER BY n.created_at DESC LIMIT 10000`,
    };

    const rows = await query<Record<string, unknown>>(queries[dataset]);

    await recordAudit({
      action: 'data.exported',
      resourceType: 'export',
      resourceId: dataset,
      newValue: { rows: rows.length },
    });

    // CSV, because the finance team lives in a spreadsheet.
    const headers = rows.length > 0 ? Object.keys(rows[0]!) : [];
    const escape = (value: unknown): string => {
      if (value == null) return '';
      const text = value instanceof Date ? value.toISOString() : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const csv = [
      headers.join(','),
      ...rows.map((row) => headers.map((header) => escape(row[header])).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${dataset}-${Date.now()}.csv"`);
    res.send(csv);
  }),
);
