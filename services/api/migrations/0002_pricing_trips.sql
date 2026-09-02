-- =============================================================================
-- 0002 — Pricing versions, fare quotes, trips, trip history and dispatch
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pricing_rule_sets — immutable, versioned pricing documents.
--
-- Editing a published set is forbidden by trigger. Publishing a change creates
-- a new version; the previous one is archived. Every fare quote and every trip
-- stores the (id, version) that priced it, so a completed trip can always be
-- re-derived exactly as it was sold.
-- -----------------------------------------------------------------------------
CREATE TABLE pricing_rule_sets (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version                         INTEGER NOT NULL,
  name                            TEXT NOT NULL,
  status                          TEXT NOT NULL DEFAULT 'draft'
                                    CHECK (status IN ('draft', 'published', 'archived')),
  currency                        TEXT NOT NULL DEFAULT 'NGN' CHECK (currency = 'NGN'),
  zone_id                         UUID REFERENCES zones(id) ON DELETE SET NULL,
  effective_from                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_to                    TIMESTAMPTZ,

  base_fare_minor                 BIGINT NOT NULL CHECK (base_fare_minor >= 0),
  per_kilometre_minor             BIGINT NOT NULL CHECK (per_kilometre_minor >= 0),
  per_minute_minor                BIGINT NOT NULL CHECK (per_minute_minor >= 0),
  minimum_fare_minor              BIGINT NOT NULL CHECK (minimum_fare_minor >= 0),
  maximum_fare_minor              BIGINT CHECK (maximum_fare_minor IS NULL OR maximum_fare_minor >= minimum_fare_minor),
  round_to_nearest_minor          BIGINT NOT NULL DEFAULT 0 CHECK (round_to_nearest_minor >= 0),

  included_passengers             INTEGER NOT NULL DEFAULT 3 CHECK (included_passengers >= 1),
  extra_passenger_fee_minor       BIGINT NOT NULL DEFAULT 0 CHECK (extra_passenger_fee_minor >= 0),
  max_passengers                  INTEGER NOT NULL DEFAULT 6 CHECK (max_passengers >= included_passengers),

  long_distance_threshold_metres  INTEGER NOT NULL DEFAULT 0 CHECK (long_distance_threshold_metres >= 0),
  long_distance_per_km_minor      BIGINT NOT NULL DEFAULT 0 CHECK (long_distance_per_km_minor >= 0),

  scheduled_ride_multiplier       NUMERIC(4, 3) NOT NULL DEFAULT 1.0 CHECK (scheduled_ride_multiplier > 0),
  demand_multiplier               NUMERIC(4, 3) NOT NULL DEFAULT 1.0 CHECK (demand_multiplier > 0),
  demand_multiplier_max           NUMERIC(4, 3) NOT NULL DEFAULT 1.8 CHECK (demand_multiplier_max >= 1),

  -- Rule documents kept as JSONB: they are read whole, never queried by field,
  -- and their shape is owned by the validated PricingRuleSet type.
  peak                            JSONB NOT NULL,
  night                           JSONB NOT NULL,
  weekend                         JSONB NOT NULL,
  public_holiday                  JSONB NOT NULL,
  public_holiday_dates            JSONB NOT NULL DEFAULT '[]'::jsonb,
  negotiation                     JSONB NOT NULL,
  cancellation                    JSONB NOT NULL,
  loyalty                         JSONB NOT NULL,
  cost_model                      JSONB NOT NULL,

  created_by_user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
  published_by_user_id            UUID REFERENCES users(id) ON DELETE SET NULL,
  published_at                    TIMESTAMPTZ,
  change_note                     TEXT,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (demand_multiplier <= demand_multiplier_max)
);

-- Version numbering is per zone (NULL zone = the platform default set).
CREATE UNIQUE INDEX pricing_rule_sets_version_unique
  ON pricing_rule_sets (COALESCE(zone_id, '00000000-0000-0000-0000-000000000000'::uuid), version);

-- At most one published set per zone at any time. Enforced by the database
-- rather than by application discipline, because a second live price list
-- would silently produce two different fares for the same trip.
CREATE UNIQUE INDEX pricing_rule_sets_single_published
  ON pricing_rule_sets (COALESCE(zone_id, '00000000-0000-0000-0000-000000000000'::uuid))
  WHERE status = 'published';

CREATE INDEX pricing_rule_sets_status_idx ON pricing_rule_sets (status, effective_from DESC);

CREATE TRIGGER pricing_rule_sets_set_updated_at BEFORE UPDATE ON pricing_rule_sets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A published price list is history. The only permitted change is retiring it.
CREATE OR REPLACE FUNCTION guard_published_pricing()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'published' AND NEW.status = 'published' THEN
    IF row_to_json(OLD)::text IS DISTINCT FROM row_to_json(NEW)::text
       AND (OLD.effective_to IS NOT DISTINCT FROM NEW.effective_to)
       AND (OLD.updated_at IS NOT DISTINCT FROM NEW.updated_at) THEN
      RAISE EXCEPTION 'pricing_rule_sets: a published rule set is immutable (id=%). Publish a new version instead.', OLD.id;
    END IF;
  END IF;
  IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
    RAISE EXCEPTION 'pricing_rule_sets: an archived rule set cannot be reactivated (id=%).', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pricing_rule_sets_guard BEFORE UPDATE ON pricing_rule_sets
  FOR EACH ROW EXECUTE FUNCTION guard_published_pricing();

-- -----------------------------------------------------------------------------
-- fare_quotes — a priced, time-boxed offer. Trips are created FROM a quote, so
-- the client never supplies a fare.
-- -----------------------------------------------------------------------------
CREATE TABLE fare_quotes (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'expired', 'consumed', 'superseded')),
  pickup_lat            DOUBLE PRECISION NOT NULL,
  pickup_lng            DOUBLE PRECISION NOT NULL,
  pickup_address        TEXT NOT NULL,
  pickup_place_id       TEXT,
  destination_lat       DOUBLE PRECISION NOT NULL,
  destination_lng       DOUBLE PRECISION NOT NULL,
  destination_address   TEXT NOT NULL,
  destination_place_id  TEXT,
  passengers            INTEGER NOT NULL DEFAULT 1 CHECK (passengers >= 1),
  scheduled_for         TIMESTAMPTZ,
  distance_metres       INTEGER NOT NULL CHECK (distance_metres >= 0),
  duration_seconds      INTEGER NOT NULL CHECK (duration_seconds >= 0),
  route_provider        TEXT NOT NULL,
  route_polyline        TEXT,
  currency              TEXT NOT NULL DEFAULT 'NGN',
  quoted_fare_minor     BIGINT NOT NULL CHECK (quoted_fare_minor > 0),
  floor_minor           BIGINT NOT NULL CHECK (floor_minor > 0),
  auto_accept_at_minor  BIGINT NOT NULL CHECK (auto_accept_at_minor > 0),
  breakdown             JSONB NOT NULL,
  pricing_rule_set_id   UUID NOT NULL REFERENCES pricing_rule_sets(id) ON DELETE RESTRICT,
  pricing_version       INTEGER NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (floor_minor <= quoted_fare_minor),
  CHECK (auto_accept_at_minor <= quoted_fare_minor),
  CHECK (floor_minor <= auto_accept_at_minor)
);

CREATE INDEX fare_quotes_customer_idx ON fare_quotes (customer_id, created_at DESC);
CREATE INDEX fare_quotes_active_idx ON fare_quotes (expires_at) WHERE status = 'active';

CREATE TRIGGER fare_quotes_set_updated_at BEFORE UPDATE ON fare_quotes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- trips
-- -----------------------------------------------------------------------------
CREATE TABLE trips (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference               TEXT NOT NULL UNIQUE,
  customer_id             UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  driver_id               UUID REFERENCES drivers(id) ON DELETE SET NULL,
  vehicle_id              UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  status                  TEXT NOT NULL DEFAULT 'REQUESTED' CHECK (status IN (
                            'REQUESTED','FARE_CALCULATED','NEGOTIATING','FARE_ACCEPTED','FARE_LOCKED',
                            'DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED',
                            'TRIP_COMPLETED','PAYMENT_PENDING','PAYMENT_COMPLETED','REVIEW_PENDING','COMPLETED',
                            'CANCELLED','EXPIRED','DRIVER_UNAVAILABLE','REASSIGNED','PAYMENT_FAILED','DISPUTED','NO_SHOW')),
  type                    TEXT NOT NULL DEFAULT 'immediate' CHECK (type IN ('immediate', 'scheduled')),

  pickup_lat              DOUBLE PRECISION NOT NULL,
  pickup_lng              DOUBLE PRECISION NOT NULL,
  pickup_address          TEXT NOT NULL,
  pickup_place_id         TEXT,
  destination_lat         DOUBLE PRECISION NOT NULL,
  destination_lng         DOUBLE PRECISION NOT NULL,
  destination_address     TEXT NOT NULL,
  destination_place_id    TEXT,
  passengers              INTEGER NOT NULL DEFAULT 1 CHECK (passengers >= 1),
  special_instructions    TEXT,

  distance_metres         INTEGER NOT NULL CHECK (distance_metres >= 0),
  duration_seconds        INTEGER NOT NULL CHECK (duration_seconds >= 0),
  route_provider          TEXT NOT NULL,
  route_polyline          TEXT,

  currency                TEXT NOT NULL DEFAULT 'NGN',
  -- The company's original calculated fare. NEVER updated after creation.
  quoted_fare_minor       BIGINT NOT NULL CHECK (quoted_fare_minor > 0),
  -- The agreed fare. NULL until the negotiation resolves.
  final_fare_minor        BIGINT CHECK (final_fare_minor IS NULL OR final_fare_minor > 0),
  fare_breakdown          JSONB NOT NULL,
  fare_quote_id           UUID REFERENCES fare_quotes(id) ON DELETE SET NULL,
  pricing_rule_set_id     UUID NOT NULL REFERENCES pricing_rule_sets(id) ON DELETE RESTRICT,
  pricing_version         INTEGER NOT NULL,
  fare_locked_at          TIMESTAMPTZ,

  scheduled_pickup_at     TIMESTAMPTZ,
  assigned_at             TIMESTAMPTZ,
  driver_en_route_at      TIMESTAMPTZ,
  driver_arrived_at       TIMESTAMPTZ,
  started_at              TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,

  cancellation_reason     TEXT,
  cancelled_by_type       TEXT CHECK (cancelled_by_type IS NULL OR cancelled_by_type IN ('customer','driver','admin','system')),
  cancelled_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  cancellation_fee_minor  BIGINT CHECK (cancellation_fee_minor IS NULL OR cancellation_fee_minor >= 0),

  payment_method          TEXT CHECK (payment_method IS NULL OR payment_method IN ('cash','card','bank_transfer','wallet')),
  payment_status          TEXT NOT NULL DEFAULT 'unpaid'
                            CHECK (payment_status IN ('unpaid','pending','paid','failed','refunded','partially_refunded')),

  actual_distance_metres  INTEGER CHECK (actual_distance_metres IS NULL OR actual_distance_metres >= 0),
  actual_duration_seconds INTEGER CHECK (actual_duration_seconds IS NULL OR actual_duration_seconds >= 0),

  -- Optimistic concurrency. Two dispatchers acting on one trip is a real
  -- scenario; the second write must fail loudly rather than silently win.
  version                 INTEGER NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A scheduled trip must carry a pickup time; an immediate one must not.
  CHECK ((type = 'scheduled') = (scheduled_pickup_at IS NOT NULL)),
  -- Once locked, a final fare must exist.
  CHECK (fare_locked_at IS NULL OR final_fare_minor IS NOT NULL)
);

CREATE INDEX trips_customer_idx ON trips (customer_id, created_at DESC);
CREATE INDEX trips_driver_idx ON trips (driver_id, created_at DESC);
CREATE INDEX trips_status_idx ON trips (status, created_at DESC);
CREATE INDEX trips_payment_status_idx ON trips (payment_status) WHERE payment_status <> 'paid';
CREATE INDEX trips_scheduled_idx ON trips (scheduled_pickup_at)
  WHERE type = 'scheduled' AND status NOT IN ('COMPLETED','CANCELLED','EXPIRED');
-- The dispatch queue: unassigned work, oldest first.
CREATE INDEX trips_unassigned_idx ON trips (created_at)
  WHERE driver_id IS NULL AND status IN ('FARE_LOCKED','DRIVER_UNAVAILABLE');
-- The live operations board.
CREATE INDEX trips_active_idx ON trips (status)
  WHERE status IN ('DRIVER_ASSIGNED','DRIVER_EN_ROUTE','DRIVER_ARRIVED','TRIP_STARTED');

CREATE TRIGGER trips_set_updated_at BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The locked fare is the contract with the customer. Only an explicit,
-- audited adjustment path may change it, and that path clears the lock first.
CREATE OR REPLACE FUNCTION guard_locked_fare()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.quoted_fare_minor IS DISTINCT FROM NEW.quoted_fare_minor THEN
    RAISE EXCEPTION 'trips: quoted_fare_minor is immutable (trip=%)', OLD.id;
  END IF;
  IF OLD.fare_locked_at IS NOT NULL
     AND OLD.final_fare_minor IS DISTINCT FROM NEW.final_fare_minor
     AND NEW.fare_locked_at IS NOT DISTINCT FROM OLD.fare_locked_at THEN
    RAISE EXCEPTION 'trips: final_fare_minor is locked (trip=%). Use the audited fare-adjustment path.', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trips_guard_locked_fare BEFORE UPDATE ON trips
  FOR EACH ROW EXECUTE FUNCTION guard_locked_fare();

ALTER TABLE driver_locations
  ADD CONSTRAINT driver_locations_trip_fk FOREIGN KEY (trip_id) REFERENCES trips(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- trip_status_history — append-only. Every transition, who caused it and why.
-- -----------------------------------------------------------------------------
CREATE TABLE trip_status_history (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  from_status    TEXT,
  to_status      TEXT NOT NULL,
  actor_type     TEXT NOT NULL CHECK (actor_type IN ('customer','driver','admin','system')),
  actor_user_id  UUID REFERENCES users(id) ON DELETE SET NULL,
  reason         TEXT,
  metadata       JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX trip_status_history_trip_idx ON trip_status_history (trip_id, created_at);

-- -----------------------------------------------------------------------------
-- trip_locations — GPS breadcrumbs for an in-progress trip.
-- -----------------------------------------------------------------------------
CREATE TABLE trip_locations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id          UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  driver_id        UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  latitude         DOUBLE PRECISION NOT NULL,
  longitude        DOUBLE PRECISION NOT NULL,
  heading_degrees  REAL,
  speed_mps        REAL,
  accuracy_metres  REAL,
  recorded_at      TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX trip_locations_trip_idx ON trip_locations (trip_id, recorded_at);

-- -----------------------------------------------------------------------------
-- trip_assignments — full assignment history, including overrides and the
-- recommendation score, so dispatch quality can be reviewed after the fact.
-- -----------------------------------------------------------------------------
CREATE TABLE trip_assignments (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id                UUID NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  driver_id              UUID NOT NULL REFERENCES drivers(id) ON DELETE RESTRICT,
  vehicle_id             UUID REFERENCES vehicles(id) ON DELETE SET NULL,
  assigned_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  reason                 TEXT NOT NULL DEFAULT 'initial_assignment' CHECK (reason IN (
                           'initial_assignment','admin_override','driver_unavailable','driver_no_show',
                           'schedule_conflict','customer_request','system_reassignment')),
  recommendation_score   NUMERIC(5, 2),
  was_override           BOOLEAN NOT NULL DEFAULT false,
  active                 BOOLEAN NOT NULL DEFAULT true,
  released_at            TIMESTAMPTZ,
  note                   TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one active assignment per trip.
CREATE UNIQUE INDEX trip_assignments_one_active ON trip_assignments (trip_id) WHERE active;
CREATE INDEX trip_assignments_driver_idx ON trip_assignments (driver_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- scheduled_rides — the operational wrapper around a future trip.
-- -----------------------------------------------------------------------------
CREATE TABLE scheduled_rides (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id              UUID NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  customer_id          UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  scheduled_pickup_at  TIMESTAMPTZ NOT NULL,
  assigned_driver_id   UUID REFERENCES drivers(id) ON DELETE SET NULL,
  status               TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN (
                         'scheduled','driver_unavailable','reassigned','dispatched','cancelled','completed')),
  reminder_sent_at     TIMESTAMPTZ,
  -- When the background worker must hand this trip to the driver.
  dispatch_due_at      TIMESTAMPTZ NOT NULL,
  dispatched_at        TIMESTAMPTZ,
  reassignment_count   INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX scheduled_rides_due_idx ON scheduled_rides (dispatch_due_at)
  WHERE status IN ('scheduled', 'driver_unavailable', 'reassigned');
CREATE INDEX scheduled_rides_driver_idx ON scheduled_rides (assigned_driver_id, scheduled_pickup_at)
  WHERE status IN ('scheduled', 'reassigned');

CREATE TRIGGER scheduled_rides_set_updated_at BEFORE UPDATE ON scheduled_rides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
