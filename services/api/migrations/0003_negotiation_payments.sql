-- =============================================================================
-- 0003 — Negotiation and money
-- =============================================================================

-- -----------------------------------------------------------------------------
-- negotiations — one conversation per trip, between the CUSTOMER and THE
-- COMPANY. Drivers are never party to it and the driver API never reads it.
-- -----------------------------------------------------------------------------
CREATE TABLE negotiations (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id                   UUID NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  customer_id               UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status                    TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN (
                              'OPEN','AWAITING_CUSTOMER','AWAITING_COMPANY','ACCEPTED','REJECTED','EXPIRED','CANCELLED')),
  currency                  TEXT NOT NULL DEFAULT 'NGN',

  original_fare_minor       BIGINT NOT NULL CHECK (original_fare_minor > 0),
  -- Internal only. Never serialised to a customer response.
  floor_minor               BIGINT NOT NULL CHECK (floor_minor > 0),
  auto_accept_at_minor      BIGINT NOT NULL CHECK (auto_accept_at_minor > 0),
  company_position_minor    BIGINT NOT NULL CHECK (company_position_minor > 0),
  customer_position_minor   BIGINT CHECK (customer_position_minor IS NULL OR customer_position_minor > 0),

  customer_rounds_used      INTEGER NOT NULL DEFAULT 0 CHECK (customer_rounds_used >= 0),
  max_customer_rounds       INTEGER NOT NULL DEFAULT 2 CHECK (max_customer_rounds >= 0),

  final_fare_minor          BIGINT CHECK (final_fare_minor IS NULL OR final_fare_minor > 0),
  accepted_at               TIMESTAMPTZ,
  accepted_by_party         TEXT CHECK (accepted_by_party IS NULL OR accepted_by_party IN ('customer','company')),
  pending_offer_id          UUID,
  pricing_rule_set_id       UUID NOT NULL REFERENCES pricing_rule_sets(id) ON DELETE RESTRICT,
  pricing_version           INTEGER NOT NULL,
  -- Optimistic concurrency: a customer offer and an admin counter can land in
  -- the same instant. The loser retries against fresh state.
  version                   INTEGER NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (customer_rounds_used <= max_customer_rounds),
  CHECK (floor_minor <= original_fare_minor),
  CHECK (accepted_at IS NULL OR final_fare_minor IS NOT NULL)
);

CREATE INDEX negotiations_status_idx ON negotiations (status, created_at DESC);
-- The admin negotiation queue: everything waiting on a human.
CREATE INDEX negotiations_review_queue_idx ON negotiations (created_at)
  WHERE status = 'AWAITING_COMPANY';
CREATE INDEX negotiations_customer_idx ON negotiations (customer_id, created_at DESC);

CREATE TRIGGER negotiations_set_updated_at BEFORE UPDATE ON negotiations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- negotiation_offers — append-only messages. Nothing is ever edited or deleted;
-- the complete history is a business record.
-- -----------------------------------------------------------------------------
CREATE TABLE negotiation_offers (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  negotiation_id   UUID NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  trip_id          UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  sequence         INTEGER NOT NULL CHECK (sequence > 0),
  party            TEXT NOT NULL CHECK (party IN ('customer', 'company')),
  actor_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  amount_minor     BIGINT NOT NULL CHECK (amount_minor > 0),
  currency         TEXT NOT NULL DEFAULT 'NGN',
  message          TEXT,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                     'pending','accepted','rejected','countered','expired','withdrawn')),
  resolution       TEXT CHECK (resolution IS NULL OR resolution IN (
                     'auto_accepted','auto_rejected','auto_countered','admin_accepted','admin_rejected',
                     'admin_countered','customer_accepted','customer_rejected','expired')),
  -- Server-authoritative. The client only renders a countdown to this value.
  expires_at       TIMESTAMPTZ NOT NULL,
  responded_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX negotiation_offers_sequence_unique ON negotiation_offers (negotiation_id, sequence);
CREATE INDEX negotiation_offers_trip_idx ON negotiation_offers (trip_id, sequence);
-- The expiry sweeper's working set.
CREATE INDEX negotiation_offers_pending_idx ON negotiation_offers (expires_at) WHERE status = 'pending';

ALTER TABLE negotiations
  ADD CONSTRAINT negotiations_pending_offer_fk
  FOREIGN KEY (pending_offer_id) REFERENCES negotiation_offers(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- payments — provider-agnostic. Card data never reaches this database; we hold
-- provider references only.
-- -----------------------------------------------------------------------------
CREATE TABLE payments (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               TEXT NOT NULL UNIQUE,
  customer_id             UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  trip_id                 UUID REFERENCES trips(id) ON DELETE SET NULL,
  purpose                 TEXT NOT NULL DEFAULT 'trip_fare'
                            CHECK (purpose IN ('trip_fare','cancellation_fee','no_show_fee','outstanding_balance')),
  method                  TEXT NOT NULL CHECK (method IN ('cash','card','bank_transfer','wallet')),
  provider                TEXT NOT NULL CHECK (provider IN ('paystack','flutterwave','cash','mock')),
  amount_minor            BIGINT NOT NULL CHECK (amount_minor > 0),
  currency                TEXT NOT NULL DEFAULT 'NGN',
  status                  TEXT NOT NULL DEFAULT 'initialized' CHECK (status IN (
                            'initialized','pending','processing','succeeded','failed','cancelled','refunded','partially_refunded')),
  provider_reference      TEXT,
  -- Set ONLY by a verified webhook, a server-side verification call, or a
  -- driver's cash confirmation. Never by the customer saying they paid.
  verified_at             TIMESTAMPTZ,
  verification_source     TEXT CHECK (verification_source IS NULL OR verification_source IN (
                            'webhook','polling','manual','driver_confirmation')),
  failure_reason          TEXT,
  collected_by_driver_id  UUID REFERENCES drivers(id) ON DELETE SET NULL,
  redeemed_points         INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_points >= 0),
  redeemed_value_minor    BIGINT NOT NULL DEFAULT 0 CHECK (redeemed_value_minor >= 0),
  paid_at                 TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (status <> 'succeeded' OR verified_at IS NOT NULL)
);

CREATE INDEX payments_customer_idx ON payments (customer_id, created_at DESC);
CREATE INDEX payments_trip_idx ON payments (trip_id);
CREATE INDEX payments_status_idx ON payments (status, created_at DESC);
CREATE UNIQUE INDEX payments_provider_ref_unique ON payments (provider, provider_reference)
  WHERE provider_reference IS NOT NULL;
-- One successful fare payment per trip.
CREATE UNIQUE INDEX payments_one_success_per_trip ON payments (trip_id)
  WHERE purpose = 'trip_fare' AND status = 'succeeded' AND trip_id IS NOT NULL;

CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- payment_transactions — append-only ledger of everything a provider told us.
-- Financial records are never deleted.
-- -----------------------------------------------------------------------------
CREATE TABLE payment_transactions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id          UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  provider            TEXT NOT NULL,
  event               TEXT NOT NULL,
  status              TEXT NOT NULL,
  amount_minor        BIGINT NOT NULL,
  currency            TEXT NOT NULL DEFAULT 'NGN',
  provider_reference  TEXT,
  raw_response        JSONB NOT NULL,
  -- A provider redelivering a webhook must be a no-op, not a double credit.
  idempotency_key     TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX payment_transactions_idempotency_unique ON payment_transactions (idempotency_key);
CREATE INDEX payment_transactions_payment_idx ON payment_transactions (payment_id, created_at);

-- Raw webhook envelopes, kept before parsing so a signature dispute can be
-- settled from evidence rather than from memory.
CREATE TABLE webhook_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          TEXT NOT NULL,
  event_id          TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  signature_valid   BOOLEAN NOT NULL,
  processed         BOOLEAN NOT NULL DEFAULT false,
  processing_error  TEXT,
  payload           JSONB NOT NULL,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX webhook_events_unique ON webhook_events (provider, event_id);
CREATE INDEX webhook_events_unprocessed_idx ON webhook_events (received_at) WHERE NOT processed;

CREATE TABLE refunds (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id            UUID NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  trip_id               UUID REFERENCES trips(id) ON DELETE SET NULL,
  amount_minor          BIGINT NOT NULL CHECK (amount_minor > 0),
  currency              TEXT NOT NULL DEFAULT 'NGN',
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'requested'
                          CHECK (status IN ('requested','approved','processing','succeeded','failed','rejected')),
  requested_by_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  approved_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  provider_reference    TEXT,
  processed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Separation of duty: the requester may not also approve.
  CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> requested_by_user_id)
);

CREATE INDEX refunds_payment_idx ON refunds (payment_id);
CREATE INDEX refunds_status_idx ON refunds (status, created_at DESC);

CREATE TRIGGER refunds_set_updated_at BEFORE UPDATE ON refunds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- outstanding_balances — the consequence of not forcing card binding at
-- sign-up. A cancellation fee becomes a debt, settled on the customer's next
-- payment, not silently charged to a card we never asked for.
-- -----------------------------------------------------------------------------
CREATE TABLE outstanding_balances (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id            UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  trip_id                UUID REFERENCES trips(id) ON DELETE SET NULL,
  reason                 TEXT NOT NULL CHECK (reason IN ('cancellation_fee','no_show_fee','failed_payment','manual_adjustment')),
  amount_minor           BIGINT NOT NULL CHECK (amount_minor > 0),
  settled_amount_minor   BIGINT NOT NULL DEFAULT 0 CHECK (settled_amount_minor >= 0),
  currency               TEXT NOT NULL DEFAULT 'NGN',
  status                 TEXT NOT NULL DEFAULT 'outstanding'
                           CHECK (status IN ('outstanding','partially_settled','settled','written_off')),
  settled_at             TIMESTAMPTZ,
  written_off_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  note                   TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (settled_amount_minor <= amount_minor)
);

CREATE INDEX outstanding_balances_customer_idx ON outstanding_balances (customer_id)
  WHERE status IN ('outstanding', 'partially_settled');

CREATE TRIGGER outstanding_balances_set_updated_at BEFORE UPDATE ON outstanding_balances
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- customer_payment_methods — provider tokens only. Storing a PAN here would be
-- both illegal and unnecessary.
-- -----------------------------------------------------------------------------
CREATE TABLE customer_payment_methods (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('paystack','flutterwave')),
  type            TEXT NOT NULL CHECK (type IN ('card','bank_account')),
  provider_token  TEXT NOT NULL,
  last4           TEXT CHECK (last4 IS NULL OR last4 ~ '^[0-9]{4}$'),
  brand           TEXT,
  expiry_month    INTEGER CHECK (expiry_month IS NULL OR expiry_month BETWEEN 1 AND 12),
  expiry_year     INTEGER CHECK (expiry_year IS NULL OR expiry_year BETWEEN 2020 AND 2100),
  bank_name       TEXT,
  is_default      BOOLEAN NOT NULL DEFAULT false,
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX customer_payment_methods_token_unique ON customer_payment_methods (provider, provider_token);
CREATE UNIQUE INDEX customer_payment_methods_one_default ON customer_payment_methods (customer_id)
  WHERE is_default AND active;

CREATE TRIGGER customer_payment_methods_set_updated_at BEFORE UPDATE ON customer_payment_methods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
