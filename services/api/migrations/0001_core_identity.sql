-- =============================================================================
-- 0001 — Core identity, RBAC, vehicles and zones
--
-- Conventions used throughout this schema:
--   * UUID primary keys, generated server-side (gen_random_uuid).
--   * Money is BIGINT in MINOR UNITS (kobo). Never NUMERIC, never float.
--   * Status columns are TEXT + CHECK rather than PostgreSQL ENUMs, so adding a
--     status is an ordinary migration instead of a lock-taking type rewrite.
--   * created_at / updated_at on every mutable table, maintained by trigger.
--   * Soft deletion (deleted_at) only where records must survive for audit.
-- =============================================================================

-- pgcrypto for gen_random_uuid(). PostgreSQL 13+ has it in core, and managed
-- providers (Supabase, RDS) usually pre-install the extension; IF NOT EXISTS
-- makes this a no-op in both cases. No other extension is required.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Keeps updated_at honest without relying on every writer remembering it.
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Human-readable references (TRP-1032, CUS-000142) come from dedicated
-- sequences so they are gap-tolerant, monotonic and never guessable as a count
-- of anything sensitive.
CREATE SEQUENCE IF NOT EXISTS seq_trip_reference START 1000;
CREATE SEQUENCE IF NOT EXISTS seq_customer_reference START 1;
CREATE SEQUENCE IF NOT EXISTS seq_employee_reference START 1;
CREATE SEQUENCE IF NOT EXISTS seq_ticket_reference START 1;
CREATE SEQUENCE IF NOT EXISTS seq_incident_reference START 1;
CREATE SEQUENCE IF NOT EXISTS seq_payment_reference START 1;
CREATE SEQUENCE IF NOT EXISTS seq_payroll_reference START 1;

-- -----------------------------------------------------------------------------
-- users — one row per human, whatever their relationship to the company.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_type      TEXT NOT NULL CHECK (principal_type IN ('customer', 'employee')),
  full_name           TEXT NOT NULL CHECK (length(btrim(full_name)) >= 2),
  email               TEXT,
  phone               TEXT NOT NULL,
  password_hash       TEXT,
  status              TEXT NOT NULL DEFAULT 'pending_verification'
                        CHECK (status IN ('active', 'suspended', 'deactivated', 'pending_verification')),
  phone_verified_at   TIMESTAMPTZ,
  email_verified_at   TIMESTAMPTZ,
  last_login_at       TIMESTAMPTZ,
  failed_login_count  INTEGER NOT NULL DEFAULT 0,
  locked_until        TIMESTAMPTZ,
  suspended_reason    TEXT,
  -- External identity when AUTH_PROVIDER=supabase; NULL for local auth.
  external_auth_id    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);

-- Phone is the primary login handle in this market and must be unique among
-- live accounts. Partial indexes let a deleted account release its number.
CREATE UNIQUE INDEX users_phone_unique ON users (phone) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX users_email_unique ON users (lower(email)) WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX users_external_auth_unique ON users (external_auth_id) WHERE external_auth_id IS NOT NULL;
CREATE INDEX users_status_idx ON users (status) WHERE deleted_at IS NULL;
CREATE INDEX users_created_at_idx ON users (created_at DESC);

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- RBAC — permissions are the unit of authorisation; roles bundle them.
-- -----------------------------------------------------------------------------
CREATE TABLE permissions (
  key          TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key          TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  -- System roles cannot be deleted or re-keyed; they are referenced by code.
  is_system    BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE role_permissions (
  role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_key  TEXT NOT NULL REFERENCES permissions(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

CREATE TABLE user_roles (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id      UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
  granted_by   UUID REFERENCES users(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE INDEX user_roles_role_idx ON user_roles (role_id);

-- -----------------------------------------------------------------------------
-- Sessions & one-time codes
-- -----------------------------------------------------------------------------
CREATE TABLE auth_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Only the hash is stored: a leaked database must not yield usable tokens.
  refresh_token_hash TEXT NOT NULL,
  device_id          TEXT,
  user_agent         TEXT,
  ip_address         INET,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  revoked_reason     TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX auth_sessions_token_idx ON auth_sessions (refresh_token_hash);
CREATE INDEX auth_sessions_user_idx ON auth_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions (expires_at);

CREATE TABLE otp_codes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE,
  phone         TEXT NOT NULL,
  purpose       TEXT NOT NULL CHECK (purpose IN ('phone_verification', 'password_reset', 'login')),
  code_hash     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  expires_at    TIMESTAMPTZ NOT NULL,
  consumed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX otp_codes_lookup_idx ON otp_codes (phone, purpose, created_at DESC);
CREATE INDEX otp_codes_expiry_idx ON otp_codes (expires_at);

-- -----------------------------------------------------------------------------
-- customers
-- -----------------------------------------------------------------------------
CREATE TABLE customers (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  reference                 TEXT NOT NULL UNIQUE,
  referral_code             TEXT NOT NULL UNIQUE,
  referred_by_customer_id   UUID REFERENCES customers(id) ON DELETE SET NULL,
  rating                    NUMERIC(3, 2) CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  total_trips               INTEGER NOT NULL DEFAULT 0,
  has_outstanding_balance   BOOLEAN NOT NULL DEFAULT false,
  notification_preferences  JSONB NOT NULL DEFAULT '{"push":true,"sms":true,"email":true,"whatsapp":false}'::jsonb,
  -- Fraud signal input: repeated sign-ups from one handset.
  signup_device_id          TEXT,
  signup_ip                 INET,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX customers_device_idx ON customers (signup_device_id) WHERE signup_device_id IS NOT NULL;
CREATE INDEX customers_referrer_idx ON customers (referred_by_customer_id);

CREATE TRIGGER customers_set_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- employees & drivers — drivers are employees, not marketplace participants.
-- -----------------------------------------------------------------------------
CREATE TABLE employees (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  employee_id         TEXT NOT NULL UNIQUE,
  job_title           TEXT NOT NULL DEFAULT 'Driver',
  employment_status   TEXT NOT NULL DEFAULT 'probation'
                        CHECK (employment_status IN ('active', 'probation', 'suspended', 'terminated', 'on_leave')),
  employment_date     DATE NOT NULL,
  termination_date    DATE,
  basic_salary_minor  BIGINT NOT NULL DEFAULT 0 CHECK (basic_salary_minor >= 0),
  photo_url           TEXT,
  address             TEXT,
  next_of_kin_name    TEXT,
  next_of_kin_phone   TEXT,
  bank_account_name   TEXT,
  bank_account_number TEXT,
  bank_name           TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);

CREATE INDEX employees_status_idx ON employees (employment_status) WHERE deleted_at IS NULL;

CREATE TRIGGER employees_set_updated_at BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- vehicles — no management UI in Phase 1, but first-class rows from day one,
-- including the EV telemetry columns the future own-brand fleet will populate.
-- -----------------------------------------------------------------------------
CREATE TABLE vehicles (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_number             TEXT NOT NULL,
  make                     TEXT NOT NULL,
  model                    TEXT NOT NULL,
  year                     INTEGER CHECK (year IS NULL OR (year >= 1980 AND year <= 2100)),
  color                    TEXT NOT NULL,
  seats                    INTEGER NOT NULL DEFAULT 4 CHECK (seats BETWEEN 1 AND 20),
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'maintenance', 'inactive', 'retired')),
  powertrain               TEXT NOT NULL DEFAULT 'petrol'
                             CHECK (powertrain IN ('petrol', 'diesel', 'hybrid', 'electric')),
  vin                      TEXT,
  current_driver_id        UUID,
  -- Telemetry: NULL for the current combustion fleet, populated for EVs.
  battery_percent          NUMERIC(5, 2) CHECK (battery_percent IS NULL OR (battery_percent >= 0 AND battery_percent <= 100)),
  estimated_range_metres   INTEGER CHECK (estimated_range_metres IS NULL OR estimated_range_metres >= 0),
  charging_status          TEXT CHECK (charging_status IS NULL OR charging_status IN ('idle', 'charging', 'discharging', 'fault')),
  odometer_metres          BIGINT CHECK (odometer_metres IS NULL OR odometer_metres >= 0),
  last_telemetry_at        TIMESTAMPTZ,
  health_status            TEXT CHECK (health_status IS NULL OR health_status IN ('ok', 'attention', 'critical')),
  next_service_due_at      TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ
);

CREATE UNIQUE INDEX vehicles_plate_unique ON vehicles (upper(plate_number)) WHERE deleted_at IS NULL;
CREATE INDEX vehicles_status_idx ON vehicles (status) WHERE deleted_at IS NULL;

CREATE TRIGGER vehicles_set_updated_at BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE drivers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id            UUID NOT NULL UNIQUE REFERENCES employees(id) ON DELETE CASCADE,
  license_number         TEXT NOT NULL,
  license_expiry         DATE NOT NULL,
  license_class          TEXT,
  state                  TEXT NOT NULL DEFAULT 'OFFLINE'
                           CHECK (state IN ('OFFLINE','ONLINE','AVAILABLE','ASSIGNED','PICKING_UP','ARRIVED','ON_TRIP','ON_BREAK','SUSPENDED')),
  assigned_vehicle_id    UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  rating                 NUMERIC(3, 2) CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  rating_count           INTEGER NOT NULL DEFAULT 0,
  total_trips            INTEGER NOT NULL DEFAULT 0,
  -- Last known fix. The full breadcrumb trail lives in trip_locations /
  -- driver_locations; these columns exist so dispatch can rank without a join.
  last_latitude          DOUBLE PRECISION,
  last_longitude         DOUBLE PRECISION,
  last_heading           REAL,
  last_location_at       TIMESTAMPTZ,
  went_online_at         TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ
);

CREATE UNIQUE INDEX drivers_license_unique ON drivers (upper(license_number)) WHERE deleted_at IS NULL;
CREATE INDEX drivers_state_idx ON drivers (state) WHERE deleted_at IS NULL;
CREATE INDEX drivers_vehicle_idx ON drivers (assigned_vehicle_id);
-- Dispatch scans available drivers with a recent fix; this covers that path.
CREATE INDEX drivers_dispatch_idx ON drivers (state, last_location_at DESC) WHERE deleted_at IS NULL;

CREATE TRIGGER drivers_set_updated_at BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE vehicles
  ADD CONSTRAINT vehicles_current_driver_fk
  FOREIGN KEY (current_driver_id) REFERENCES drivers(id) ON DELETE SET NULL;

-- Driver location history, independent of any trip (used for utilisation,
-- live ops map replay and GPS-plausibility checks).
CREATE TABLE driver_locations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id         UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  trip_id           UUID,
  latitude          DOUBLE PRECISION NOT NULL,
  longitude         DOUBLE PRECISION NOT NULL,
  heading_degrees   REAL,
  speed_mps         REAL,
  accuracy_metres   REAL,
  driver_state      TEXT NOT NULL,
  -- recorded_at is the DEVICE clock (may be replayed from an offline queue);
  -- created_at is the SERVER clock and is what ops reasoning uses.
  recorded_at       TIMESTAMPTZ NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX driver_locations_driver_time_idx ON driver_locations (driver_id, recorded_at DESC);
CREATE INDEX driver_locations_trip_idx ON driver_locations (trip_id, recorded_at) WHERE trip_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- zones — pricing and dispatch geography. Circular in Phase 1; a polygon column
-- can be added later without touching the pricing engine's interface.
-- -----------------------------------------------------------------------------
CREATE TABLE zones (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  centre_lat     DOUBLE PRECISION NOT NULL,
  centre_lng     DOUBLE PRECISION NOT NULL,
  radius_metres  INTEGER NOT NULL CHECK (radius_metres > 0),
  active         BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER zones_set_updated_at BEFORE UPDATE ON zones
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- saved_locations — customer's home/work shortcuts.
-- -----------------------------------------------------------------------------
CREATE TABLE saved_locations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  label        TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'other' CHECK (kind IN ('home', 'work', 'other')),
  address      TEXT NOT NULL,
  latitude     DOUBLE PRECISION NOT NULL,
  longitude    DOUBLE PRECISION NOT NULL,
  place_id     TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX saved_locations_customer_idx ON saved_locations (customer_id);
CREATE UNIQUE INDEX saved_locations_unique_kind ON saved_locations (customer_id, kind)
  WHERE kind IN ('home', 'work');

CREATE TRIGGER saved_locations_set_updated_at BEFORE UPDATE ON saved_locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
