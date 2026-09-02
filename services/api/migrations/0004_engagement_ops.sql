-- =============================================================================
-- 0004 — Loyalty, reviews, support, emergency, notifications, payroll, audit
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Loyalty. The balance column is a cached projection; the ledger is the truth.
-- Every movement writes a transaction row — no exceptions, including admin
-- adjustments and expiries.
-- -----------------------------------------------------------------------------
CREATE TABLE reward_rules (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                           TEXT NOT NULL UNIQUE,
  name                           TEXT NOT NULL,
  active                         BOOLEAN NOT NULL DEFAULT true,
  spend_unit_minor               BIGINT NOT NULL CHECK (spend_unit_minor > 0),
  points_per_unit                NUMERIC(8, 2) NOT NULL CHECK (points_per_unit >= 0),
  point_value_minor              BIGINT NOT NULL CHECK (point_value_minor >= 0),
  minimum_redeemable_points      INTEGER NOT NULL DEFAULT 0,
  max_redemption_percent_of_fare NUMERIC(5, 2) NOT NULL DEFAULT 50,
  valid_from                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to                       TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER reward_rules_set_updated_at BEFORE UPDATE ON reward_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE loyalty_accounts (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id               UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  balance_points            INTEGER NOT NULL DEFAULT 0 CHECK (balance_points >= 0),
  lifetime_earned_points    INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_earned_points >= 0),
  lifetime_redeemed_points  INTEGER NOT NULL DEFAULT 0 CHECK (lifetime_redeemed_points >= 0),
  tier                      TEXT NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard','silver','gold','platinum')),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER loyalty_accounts_set_updated_at BEFORE UPDATE ON loyalty_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE loyalty_transactions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID NOT NULL REFERENCES loyalty_accounts(id) ON DELETE CASCADE,
  customer_id          UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  type                 TEXT NOT NULL CHECK (type IN ('earn','redeem','expire','adjustment','reversal')),
  points               INTEGER NOT NULL CHECK (points <> 0),
  balance_after        INTEGER NOT NULL CHECK (balance_after >= 0),
  trip_id              UUID REFERENCES trips(id) ON DELETE SET NULL,
  source_amount_minor  BIGINT,
  rule_id              UUID REFERENCES reward_rules(id) ON DELETE SET NULL,
  reason               TEXT NOT NULL,
  actor_user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX loyalty_transactions_customer_idx ON loyalty_transactions (customer_id, created_at DESC);
-- One earn per trip: a retry of the completion handler must not double-award.
CREATE UNIQUE INDEX loyalty_transactions_one_earn_per_trip ON loyalty_transactions (trip_id)
  WHERE type = 'earn' AND trip_id IS NOT NULL;
CREATE INDEX loyalty_transactions_expiry_idx ON loyalty_transactions (expires_at)
  WHERE type = 'earn' AND expires_at IS NOT NULL;

CREATE TABLE redemptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id             UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  trip_id                 UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  points                  INTEGER NOT NULL CHECK (points > 0),
  value_minor             BIGINT NOT NULL CHECK (value_minor > 0),
  currency                TEXT NOT NULL DEFAULT 'NGN',
  status                  TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied','reversed')),
  loyalty_transaction_id  UUID NOT NULL REFERENCES loyalty_transactions(id) ON DELETE RESTRICT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX redemptions_trip_idx ON redemptions (trip_id);

CREATE TRIGGER redemptions_set_updated_at BEFORE UPDATE ON redemptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- reviews — only a completed, paid trip can produce a rating that counts.
-- -----------------------------------------------------------------------------
CREATE TABLE reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         UUID NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  driver_id       UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  driver_rating   SMALLINT NOT NULL CHECK (driver_rating BETWEEN 1 AND 5),
  service_rating  SMALLINT CHECK (service_rating IS NULL OR service_rating BETWEEN 1 AND 5),
  comment         TEXT,
  verified        BOOLEAN NOT NULL DEFAULT true,
  tags            JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reviews_driver_idx ON reviews (driver_id, created_at DESC) WHERE verified;

CREATE TRIGGER reviews_set_updated_at BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Support
-- -----------------------------------------------------------------------------
CREATE TABLE support_tickets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference             TEXT NOT NULL UNIQUE,
  raised_by_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  customer_id           UUID REFERENCES customers(id) ON DELETE SET NULL,
  driver_id             UUID REFERENCES drivers(id) ON DELETE SET NULL,
  trip_id               UUID REFERENCES trips(id) ON DELETE SET NULL,
  category              TEXT NOT NULL CHECK (category IN (
                          'driver_did_not_arrive','driver_issue','payment_problem','incorrect_charge',
                          'lost_item','trip_issue','cancellation','safety_issue','other')),
  subject               TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'OPEN'
                          CHECK (status IN ('OPEN','IN_PROGRESS','WAITING_FOR_CUSTOMER','RESOLVED','CLOSED')),
  priority              TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  assigned_to_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  first_response_at     TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  resolution_note       TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX support_tickets_status_idx ON support_tickets (status, priority, created_at DESC);
CREATE INDEX support_tickets_customer_idx ON support_tickets (customer_id, created_at DESC);
CREATE INDEX support_tickets_trip_idx ON support_tickets (trip_id);

CREATE TRIGGER support_tickets_set_updated_at BEFORE UPDATE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE support_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id       UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  author_role     TEXT NOT NULL CHECK (author_role IN ('customer','driver','agent','system')),
  body            TEXT NOT NULL,
  -- Internal notes are never serialised to a customer or driver response.
  internal        BOOLEAN NOT NULL DEFAULT false,
  attachments     JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX support_messages_ticket_idx ON support_messages (ticket_id, created_at);

-- -----------------------------------------------------------------------------
-- Emergency. An SOS row is created before any notification is attempted, so a
-- notification outage can never lose the incident.
-- -----------------------------------------------------------------------------
CREATE TABLE emergency_incidents (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               TEXT NOT NULL UNIQUE,
  raised_by_user_id       UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  raised_by_type          TEXT NOT NULL CHECK (raised_by_type IN ('customer','driver')),
  trip_id                 UUID REFERENCES trips(id) ON DELETE SET NULL,
  driver_id               UUID REFERENCES drivers(id) ON DELETE SET NULL,
  customer_id             UUID REFERENCES customers(id) ON DELETE SET NULL,
  type                    TEXT NOT NULL DEFAULT 'sos'
                            CHECK (type IN ('sos','accident','harassment','vehicle_breakdown','medical','other')),
  status                  TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','acknowledged','responding','resolved','false_alarm')),
  latitude                DOUBLE PRECISION,
  longitude               DOUBLE PRECISION,
  location_address        TEXT,
  note                    TEXT,
  acknowledged_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at         TIMESTAMPTZ,
  resolved_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  resolved_at             TIMESTAMPTZ,
  resolution_notes        TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX emergency_incidents_open_idx ON emergency_incidents (created_at DESC)
  WHERE status IN ('open','acknowledged','responding');
CREATE INDEX emergency_incidents_trip_idx ON emergency_incidents (trip_id);

CREATE TRIGGER emergency_incidents_set_updated_at BEFORE UPDATE ON emergency_incidents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- Notifications
-- -----------------------------------------------------------------------------
CREATE TABLE notifications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event              TEXT NOT NULL,
  channel            TEXT NOT NULL CHECK (channel IN ('push','sms','email','whatsapp','in_app')),
  title              TEXT NOT NULL,
  body               TEXT NOT NULL,
  data               JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','sent','delivered','failed','suppressed','read')),
  -- Stops the same event firing twice for the same entity after a retry.
  dedupe_key         TEXT,
  failure_reason     TEXT,
  sent_at            TIMESTAMPTZ,
  read_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_recipient_idx ON notifications (recipient_user_id, created_at DESC);
CREATE INDEX notifications_unread_idx ON notifications (recipient_user_id)
  WHERE channel = 'in_app' AND read_at IS NULL;
CREATE UNIQUE INDEX notifications_dedupe_unique ON notifications (dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE push_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token         TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('ios','android','web')),
  device_id     TEXT,
  active        BOOLEAN NOT NULL DEFAULT true,
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX push_tokens_token_unique ON push_tokens (token);
CREATE INDEX push_tokens_user_idx ON push_tokens (user_id) WHERE active;

-- -----------------------------------------------------------------------------
-- Payroll. Drivers are employees: salary, allowances and deductions — not
-- commission, not a wallet.
-- -----------------------------------------------------------------------------
CREATE TABLE payroll_periods (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               TEXT NOT NULL UNIQUE,
  period_start            DATE NOT NULL,
  period_end              DATE NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','pending_approval','approved','paid','cancelled')),
  currency                TEXT NOT NULL DEFAULT 'NGN',
  total_gross_minor       BIGINT NOT NULL DEFAULT 0,
  total_deductions_minor  BIGINT NOT NULL DEFAULT 0,
  total_net_minor         BIGINT NOT NULL DEFAULT 0,
  prepared_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at             TIMESTAMPTZ,
  paid_at                 TIMESTAMPTZ,
  note                    TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (period_end >= period_start),
  -- Separation of duty: the preparer may not approve their own payroll run.
  CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> prepared_by_user_id)
);

CREATE INDEX payroll_periods_status_idx ON payroll_periods (status, period_start DESC);
-- Two overlapping payroll runs would double-pay. The database refuses.
CREATE UNIQUE INDEX payroll_periods_range_unique ON payroll_periods (period_start, period_end)
  WHERE status <> 'cancelled';

CREATE TRIGGER payroll_periods_set_updated_at BEFORE UPDATE ON payroll_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payroll_records (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id           UUID NOT NULL REFERENCES payroll_periods(id) ON DELETE CASCADE,
  employee_id         UUID NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
  currency            TEXT NOT NULL DEFAULT 'NGN',
  basic_salary_minor  BIGINT NOT NULL DEFAULT 0 CHECK (basic_salary_minor >= 0),
  allowances_minor    BIGINT NOT NULL DEFAULT 0 CHECK (allowances_minor >= 0),
  bonuses_minor       BIGINT NOT NULL DEFAULT 0 CHECK (bonuses_minor >= 0),
  overtime_minor      BIGINT NOT NULL DEFAULT 0 CHECK (overtime_minor >= 0),
  deductions_minor    BIGINT NOT NULL DEFAULT 0 CHECK (deductions_minor >= 0),
  penalties_minor     BIGINT NOT NULL DEFAULT 0 CHECK (penalties_minor >= 0),
  gross_minor         BIGINT NOT NULL DEFAULT 0,
  net_minor           BIGINT NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid')),
  payment_status      TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','processing','paid','failed')),
  paid_at             TIMESTAMPTZ,
  performance         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payroll_records_unique ON payroll_records (period_id, employee_id);
CREATE INDEX payroll_records_employee_idx ON payroll_records (employee_id, created_at DESC);

CREATE TRIGGER payroll_records_set_updated_at BEFORE UPDATE ON payroll_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payroll_items (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payroll_record_id   UUID NOT NULL REFERENCES payroll_records(id) ON DELETE CASCADE,
  type                TEXT NOT NULL CHECK (type IN ('basic_salary','allowance','bonus','overtime','deduction','penalty')),
  label               TEXT NOT NULL,
  amount_minor        BIGINT NOT NULL CHECK (amount_minor >= 0),
  quantity            NUMERIC(10, 2),
  note                TEXT,
  created_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX payroll_items_record_idx ON payroll_items (payroll_record_id);

-- -----------------------------------------------------------------------------
-- audit_logs — append-only. Every sensitive action lands here with before and
-- after values. Nothing in the application deletes from this table.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role      TEXT,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('customer','driver','admin','system')),
  action          TEXT NOT NULL,
  resource_type   TEXT NOT NULL,
  resource_id     TEXT,
  previous_value  JSONB,
  new_value       JSONB,
  reason          TEXT,
  ip_address      INET,
  user_agent      TEXT,
  request_id      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX audit_logs_resource_idx ON audit_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);

CREATE OR REPLACE FUNCTION forbid_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_audit_mutation();

-- -----------------------------------------------------------------------------
-- fraud_signals — rules and anomaly indicators, not a machine-learning system.
-- -----------------------------------------------------------------------------
CREATE TABLE fraud_signals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                TEXT NOT NULL,
  severity            TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  subject_type        TEXT NOT NULL CHECK (subject_type IN ('customer','driver','admin','trip')),
  subject_id          UUID NOT NULL,
  trip_id             UUID REFERENCES trips(id) ON DELETE SET NULL,
  details             JSONB NOT NULL DEFAULT '{}'::jsonb,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','dismissed','confirmed')),
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX fraud_signals_open_idx ON fraud_signals (severity, created_at DESC) WHERE status = 'open';
CREATE INDEX fraud_signals_subject_idx ON fraud_signals (subject_type, subject_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- idempotency_keys — a retried POST from a phone on a flaky network must not
-- create a second trip or a second payment.
-- -----------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  key            TEXT PRIMARY KEY,
  user_id        UUID REFERENCES users(id) ON DELETE CASCADE,
  endpoint       TEXT NOT NULL,
  request_hash   TEXT NOT NULL,
  response_body  JSONB,
  status_code    INTEGER,
  state          TEXT NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress','completed')),
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- -----------------------------------------------------------------------------
-- app_settings — operational toggles that are neither pricing nor secrets.
-- -----------------------------------------------------------------------------
CREATE TABLE app_settings (
  key                 TEXT PRIMARY KEY,
  value               JSONB NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  updated_by_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
