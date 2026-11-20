CREATE TABLE avis_core_v2.stripe_pos_payments (
    payment_id uuid PRIMARY KEY,
    request_key text NOT NULL UNIQUE,
    actor_id text NOT NULL,
    terminal_id varchar(32) NOT NULL REFERENCES avis_core_v2.pos_terminals (terminal_id),
    merchant_id varchar(64) NOT NULL REFERENCES avis_core_v2.marketplace_merchants (merchant_id),
    reference varchar(100) NOT NULL,
    currency_code varchar(3) NOT NULL CHECK (currency_code IN ('EUR', 'USD', 'GBP', 'CHF')),
    amount_minor integer NOT NULL CHECK (amount_minor BETWEEN 100 AND 99999999),
    status text NOT NULL DEFAULT 'INITIATED' CHECK (status IN (
        'INITIATED', 'CHECKOUT_CREATED', 'PAID', 'FAILED', 'EXPIRED',
        'PARTIALLY_REFUNDED', 'REFUNDED', 'DISPUTED'
    )),
    session_id text UNIQUE,
    checkout_url text,
    payment_intent_id text UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    paid_at timestamptz,
    CHECK ((session_id IS NULL) = (checkout_url IS NULL))
);

CREATE INDEX stripe_pos_payments_created_at_idx
    ON avis_core_v2.stripe_pos_payments (created_at DESC);

CREATE TABLE avis_core_v2.stripe_pos_webhook_events (
    stripe_event_id text PRIMARY KEY,
    payment_id uuid NOT NULL REFERENCES avis_core_v2.stripe_pos_payments (payment_id),
    event_type text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now()
);
