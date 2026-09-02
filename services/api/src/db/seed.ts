import bcrypt from 'bcryptjs';
import { DEFAULT_PRICING_RULE_SET } from '@transportco/config';
import { PERMISSIONS, ROLE_PERMISSIONS, type RoleKey } from '@transportco/types';
import { generateCode } from '@transportco/utils/secure';
import { pool, queryOne, withTransaction } from './pool';
import { migrateUp } from './migrate';
import { logger } from '../lib/logger';
import { env } from '../config';

/**
 * Development seed.
 *
 * Creates the Rivers State pilot as described in the brief: four company
 * vehicles, four employed drivers, the operations team, one published pricing
 * version and a test customer.
 *
 * Idempotent — safe to re-run. Refuses to run in production, because it creates
 * accounts with known passwords.
 */

const DEMO_PASSWORD = 'TransportCo123';

const PERMISSION_CATEGORY: Record<string, string> = {
  trip: 'Operations',
  negotiation: 'Negotiation',
  pricing: 'Pricing',
  fare: 'Pricing',
  customer: 'Customers',
  driver: 'People',
  employee: 'People',
  payment: 'Finance',
  balance: 'Finance',
  loyalty: 'Loyalty',
  support: 'Support',
  emergency: 'Safety',
  payroll: 'Payroll',
  report: 'Reporting',
  audit: 'Reporting',
  user: 'Platform',
  settings: 'Platform',
};

const ROLE_NAMES: Record<RoleKey, { name: string; description: string }> = {
  super_admin: { name: 'Super Admin', description: 'Unrestricted access to every function.' },
  operations_manager: {
    name: 'Operations Manager',
    description: 'Runs day-to-day operations: dispatch, negotiation, drivers and customers.',
  },
  dispatcher: { name: 'Dispatcher', description: 'Assigns drivers and monitors live trips.' },
  finance: { name: 'Finance', description: 'Payments, refunds and reconciliation.' },
  customer_support: { name: 'Customer Support', description: 'Handles customer and driver tickets.' },
  hr: { name: 'HR', description: 'Employee records and payroll preparation.' },
  management: { name: 'Management', description: 'Read-only access to business performance.' },
  driver: { name: 'Driver', description: 'Driver application access. No administrative rights.' },
};

const STAFF = [
  { name: 'Amaka Obi', phone: '+2348030000001', email: 'amaka@transportco.example', role: 'super_admin' },
  { name: 'Tunde Bello', phone: '+2348030000002', email: 'tunde@transportco.example', role: 'operations_manager' },
  { name: 'Chidi Nwosu', phone: '+2348030000003', email: 'chidi@transportco.example', role: 'dispatcher' },
  { name: 'Ngozi Eze', phone: '+2348030000004', email: 'ngozi@transportco.example', role: 'finance' },
  { name: 'Ibrahim Musa', phone: '+2348030000005', email: 'ibrahim@transportco.example', role: 'customer_support' },
  { name: 'Funke Adeyemi', phone: '+2348030000006', email: 'funke@transportco.example', role: 'hr' },
] as const;

const VEHICLES = [
  { plate: 'RIV-101-AB', make: 'Toyota', model: 'Corolla', year: 2020, color: 'Silver' },
  { plate: 'RIV-102-CD', make: 'Toyota', model: 'Camry', year: 2019, color: 'Black' },
  { plate: 'RIV-103-EF', make: 'Hyundai', model: 'Elantra', year: 2021, color: 'White' },
  { plate: 'RIV-104-GH', make: 'Kia', model: 'Rio', year: 2020, color: 'Grey' },
] as const;

const DRIVERS = [
  { name: 'Michael Okoro', phone: '+2348040000001', licence: 'RVS-DRV-0001' },
  { name: 'Emeka Duru', phone: '+2348040000002', licence: 'RVS-DRV-0002' },
  { name: 'Grace Ibiso', phone: '+2348040000003', licence: 'RVS-DRV-0003' },
  { name: 'Samuel Tamuno', phone: '+2348040000004', licence: 'RVS-DRV-0004' },
] as const;

/** Rivers State operating zones. Port Harcourt first. */
const ZONES = [
  { code: 'PHC', name: 'Port Harcourt Metro', lat: 4.8156, lng: 7.0498, radius: 25_000 },
  { code: 'OBI', name: 'Obio-Akpor', lat: 4.8605, lng: 6.9954, radius: 15_000 },
] as const;

export async function seed(): Promise<void> {
  if (env.NODE_ENV === 'production') {
    throw new Error('The development seed must never run in production');
  }

  await migrateUp();

  await withTransaction(async (client) => {
    // --- Permissions --------------------------------------------------------
    for (const permission of PERMISSIONS) {
      const category = PERMISSION_CATEGORY[permission.split(':')[0]!] ?? 'Other';
      await client.query(
        `INSERT INTO permissions (key, description, category) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET category = EXCLUDED.category`,
        [permission, permission.replace(':', ' — ').replace(/_/g, ' '), category],
      );
    }

    // --- Roles --------------------------------------------------------------
    for (const [key, permissions] of Object.entries(ROLE_PERMISSIONS)) {
      const meta = ROLE_NAMES[key as RoleKey];
      const role = await queryOne<{ id: string }>(
        `INSERT INTO roles (key, name, description, is_system) VALUES ($1, $2, $3, true)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description
         RETURNING id`,
        [key, meta.name, meta.description],
        client,
      );

      await client.query('DELETE FROM role_permissions WHERE role_id = $1', [role!.id]);
      for (const permission of permissions) {
        await client.query(
          'INSERT INTO role_permissions (role_id, permission_key) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [role!.id, permission],
        );
      }
    }

    // --- Zones --------------------------------------------------------------
    for (const zone of ZONES) {
      await client.query(
        `INSERT INTO zones (code, name, centre_lat, centre_lng, radius_metres)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (code) DO NOTHING`,
        [zone.code, zone.name, zone.lat, zone.lng, zone.radius],
      );
    }

    // --- Pricing ------------------------------------------------------------
    const existingPricing = await queryOne<{ id: string }>(
      "SELECT id FROM pricing_rule_sets WHERE status = 'published' AND zone_id IS NULL",
      [],
      client,
    );

    if (!existingPricing) {
      const p = DEFAULT_PRICING_RULE_SET;
      await client.query(
        `INSERT INTO pricing_rule_sets (
           version, name, status, zone_id, effective_from, published_at,
           base_fare_minor, per_kilometre_minor, per_minute_minor, minimum_fare_minor, maximum_fare_minor,
           round_to_nearest_minor, included_passengers, extra_passenger_fee_minor, max_passengers,
           long_distance_threshold_metres, long_distance_per_km_minor,
           scheduled_ride_multiplier, demand_multiplier, demand_multiplier_max,
           peak, night, weekend, public_holiday, public_holiday_dates,
           negotiation, cancellation, loyalty, cost_model, change_note
         ) VALUES (1,$1,'published',NULL,now(),now(),
                   $2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   $16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
        [
          p.name,
          p.baseFareMinor,
          p.perKilometreMinor,
          p.perMinuteMinor,
          p.minimumFareMinor,
          p.maximumFareMinor,
          p.roundToNearestMinor,
          p.includedPassengers,
          p.extraPassengerFeeMinor,
          p.maxPassengers,
          p.longDistanceThresholdMetres,
          p.longDistancePerKilometreMinor,
          p.scheduledRideMultiplier,
          p.demandMultiplier,
          p.demandMultiplierMax,
          JSON.stringify(p.peak),
          JSON.stringify(p.night),
          JSON.stringify(p.weekend),
          JSON.stringify(p.publicHoliday),
          JSON.stringify(p.publicHolidayDates),
          JSON.stringify(p.negotiation),
          JSON.stringify(p.cancellation),
          JSON.stringify(p.loyalty),
          JSON.stringify(p.costModel),
          p.changeNote,
        ],
      );
      logger.info('Seeded the launch pricing rule set');
    }

    // --- Reward rule --------------------------------------------------------
    await client.query(
      `INSERT INTO reward_rules (code, name, spend_unit_minor, points_per_unit, point_value_minor,
                                 minimum_redeemable_points, max_redemption_percent_of_fare)
       VALUES ('launch', 'Launch loyalty', $1, $2, $3, $4, $5)
       ON CONFLICT (code) DO NOTHING`,
      [
        DEFAULT_PRICING_RULE_SET.loyalty.pointsPerSpendUnitMinor,
        DEFAULT_PRICING_RULE_SET.loyalty.pointsPerUnit,
        DEFAULT_PRICING_RULE_SET.loyalty.pointValueMinor,
        DEFAULT_PRICING_RULE_SET.loyalty.minimumRedeemablePoints,
        DEFAULT_PRICING_RULE_SET.loyalty.maxRedemptionPercentOfFare,
      ],
    );

    // --- Vehicles -----------------------------------------------------------
    const vehicleIds: string[] = [];
    for (const vehicle of VEHICLES) {
      // Check before inserting: a failed INSERT inside a transaction aborts the
      // ENTIRE transaction in PostgreSQL, so catching the error is not enough.
      const existing = await queryOne<{ id: string }>(
        'SELECT id FROM vehicles WHERE upper(plate_number) = upper($1) AND deleted_at IS NULL',
        [vehicle.plate],
        client,
      );

      if (existing) {
        vehicleIds.push(existing.id);
        continue;
      }

      const created = await queryOne<{ id: string }>(
        `INSERT INTO vehicles (plate_number, make, model, year, color, seats, status, powertrain)
         VALUES ($1, $2, $3, $4, $5, 4, 'active', 'petrol')
         RETURNING id`,
        [vehicle.plate, vehicle.make, vehicle.model, vehicle.year, vehicle.color],
        client,
      );

      if (created) vehicleIds.push(created.id);
    }

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

    // --- Staff --------------------------------------------------------------
    for (const person of STAFF) {
      const existing = await queryOne<{ id: string }>(
        'SELECT id FROM users WHERE phone = $1',
        [person.phone],
        client,
      );
      if (existing) continue;

      const user = await queryOne<{ id: string }>(
        `INSERT INTO users (principal_type, full_name, email, phone, password_hash, status, phone_verified_at)
         VALUES ('employee', $1, $2, $3, $4, 'active', now())
         RETURNING id`,
        [person.name, person.email, person.phone, passwordHash],
        client,
      );

      const sequence = await queryOne<{ value: number }>(
        "SELECT nextval('seq_employee_reference')::int AS value",
        [],
        client,
      );

      await client.query(
        `INSERT INTO employees (user_id, employee_id, job_title, employment_status, employment_date, basic_salary_minor)
         VALUES ($1, $2, $3, 'active', CURRENT_DATE - interval '6 months', $4)`,
        [
          user!.id,
          `EMP-${String(sequence?.value ?? 1).padStart(4, '0')}`,
          ROLE_NAMES[person.role as RoleKey].name,
          45_000_00, // ₦450,000 monthly, in kobo
        ],
      );

      const role = await queryOne<{ id: string }>(
        'SELECT id FROM roles WHERE key = $1',
        [person.role],
        client,
      );
      await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [user!.id, role!.id]);
    }

    // --- Drivers ------------------------------------------------------------
    const driverRole = await queryOne<{ id: string }>("SELECT id FROM roles WHERE key = 'driver'", [], client);

    for (const [index, driver] of DRIVERS.entries()) {
      const existing = await queryOne<{ id: string }>(
        'SELECT id FROM users WHERE phone = $1',
        [driver.phone],
        client,
      );
      if (existing) continue;

      const user = await queryOne<{ id: string }>(
        `INSERT INTO users (principal_type, full_name, phone, password_hash, status, phone_verified_at)
         VALUES ('employee', $1, $2, $3, 'active', now())
         RETURNING id`,
        [driver.name, driver.phone, passwordHash],
        client,
      );

      const sequence = await queryOne<{ value: number }>(
        "SELECT nextval('seq_employee_reference')::int AS value",
        [],
        client,
      );

      const employee = await queryOne<{ id: string }>(
        `INSERT INTO employees (user_id, employee_id, job_title, employment_status, employment_date, basic_salary_minor)
         VALUES ($1, $2, 'Driver', 'active', CURRENT_DATE - interval '3 months', $3)
         RETURNING id`,
        [user!.id, `EMP-${String(sequence?.value ?? 1).padStart(4, '0')}`, 18_000_00], // ₦180,000
        client,
      );

      const vehicleId = vehicleIds[index] ?? null;

      const driverRow = await queryOne<{ id: string }>(
        `INSERT INTO drivers (employee_id, license_number, license_expiry, license_class, assigned_vehicle_id, state)
         VALUES ($1, $2, CURRENT_DATE + interval '2 years', 'C', $3, 'OFFLINE')
         RETURNING id`,
        [employee!.id, driver.licence, vehicleId],
        client,
      );

      if (vehicleId) {
        await client.query('UPDATE vehicles SET current_driver_id = $2 WHERE id = $1', [
          vehicleId,
          driverRow!.id,
        ]);
      }

      await client.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)', [
        user!.id,
        driverRole!.id,
      ]);
    }

    // --- Test customer ------------------------------------------------------
    const customerPhone = '+2348050000001';
    const existingCustomer = await queryOne<{ id: string }>(
      'SELECT id FROM users WHERE phone = $1',
      [customerPhone],
      client,
    );

    if (!existingCustomer) {
      const user = await queryOne<{ id: string }>(
        `INSERT INTO users (principal_type, full_name, email, phone, password_hash, status, phone_verified_at)
         VALUES ('customer', 'John Doe', 'john@example.com', $1, $2, 'active', now())
         RETURNING id`,
        [customerPhone, passwordHash],
        client,
      );

      const sequence = await queryOne<{ value: number }>(
        "SELECT nextval('seq_customer_reference')::int AS value",
        [],
        client,
      );

      const customer = await queryOne<{ id: string }>(
        `INSERT INTO customers (user_id, reference, referral_code) VALUES ($1, $2, $3) RETURNING id`,
        [user!.id, `CUS-${String(sequence?.value ?? 1).padStart(6, '0')}`, generateCode(7)],
        client,
      );

      await client.query('INSERT INTO loyalty_accounts (customer_id) VALUES ($1)', [customer!.id]);

      await client.query(
        `INSERT INTO saved_locations (customer_id, label, kind, address, latitude, longitude)
         VALUES ($1, 'Home', 'home', 'Rumuola, Port Harcourt', 4.8156, 7.0498),
                ($1, 'Office', 'work', 'GRA Phase 2, Port Harcourt', 4.8087, 7.0134)`,
        [customer!.id],
      );
    }

    // --- Settings -----------------------------------------------------------
    await client.query(
      `INSERT INTO app_settings (key, value, description) VALUES
         ('operations.hotline', '"+2348000000000"'::jsonb, 'Emergency hotline shown in both apps'),
         ('operations.launch_zone', '"PHC"'::jsonb, 'Primary operating zone')
       ON CONFLICT (key) DO NOTHING`,
    );
  });

  logger.info(
    {
      staff: STAFF.map((person) => person.email),
      drivers: DRIVERS.map((driver) => driver.phone),
      customer: '+2348050000001',
      password: DEMO_PASSWORD,
    },
    'Seed complete — every demo account uses the same password',
  );
}

if (require.main === module) {
  seed()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      logger.error({ err: error }, 'Seed failed');
      process.exit(1);
    });
}
