ALTER TABLE avis_core_v2.ledger_accounts ADD CONSTRAINT fx_inventory_nonnegative CHECK
 ((owner_type<>'TREASURY' AND NOT(owner_type='EXCHANGE_CLEARING' AND sub_account_code LIKE 'FX:%')) OR available_balance>=0);
CREATE TABLE avis_core_v2.fx_reference_rates (
 currency_code varchar(3) PRIMARY KEY REFERENCES avis_core_v2.abiq_currencies,
 units_per_eur numeric(36,18) NOT NULL CHECK(units_per_eur>0),source text NOT NULL,
 source_date date NOT NULL,observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.fx_quotes (
 quote_id uuid PRIMARY KEY,user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users,
 from_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts,to_account_id uuid NOT NULL REFERENCES avis_core_v2.ledger_accounts,
 from_currency varchar(3) NOT NULL,to_currency varchar(3) NOT NULL,
 from_amount numeric(20,6) NOT NULL CHECK(from_amount>0),fee_amount numeric(20,6) NOT NULL CHECK(fee_amount>=0 AND fee_amount<from_amount),
 to_amount numeric(20,6) NOT NULL CHECK(to_amount>0),rate numeric(36,18) NOT NULL CHECK(rate>0),
 rate_source text NOT NULL,rate_date date NOT NULL,expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','EXECUTED','EXPIRED','CANCELLED')),
 reserve_journal_id uuid NOT NULL REFERENCES avis_core_v2.ledger_journals,execution_journal_id uuid REFERENCES avis_core_v2.ledger_journals,
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(from_currency<>to_currency)
);
