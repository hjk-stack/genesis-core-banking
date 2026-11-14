-- Sovereign Core v2 §§1–4; Azure ESQL v3 §§2–4; ABIQ v8.1 §§1–4.
-- Additive migration. Existing customer records and balances are retained.
CREATE SEQUENCE avis_core_v2.sovereign_user_ids MAXVALUE 99999999999999;
SELECT setval('avis_core_v2.sovereign_user_ids', COALESCE((SELECT max(user_id) FROM avis_core_v2.sovereign_users),0)+1, false);
ALTER TABLE avis_core_v2.sovereign_users ADD COLUMN account_type text NOT NULL DEFAULT 'PERSONAL'
 CHECK (account_type IN ('PERSONAL','BUSINESS'));
CREATE TABLE avis_core_v2.operation_requests (
 operation_key text PRIMARY KEY, actor_id text NOT NULL, operation text NOT NULL,
 request jsonb NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.operation_audit (
 audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 actor_id text NOT NULL, operation text NOT NULL, resource_id text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE avis_core_v2.operator_sessions (
 token_hash text PRIMARY KEY, csrf_hash text NOT NULL, actor_id text NOT NULL, username text NOT NULL,
 expires_at timestamptz NOT NULL
);
CREATE TABLE avis_core_v2.connector_outbox (
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users,
 connector_code varchar(35) NOT NULL REFERENCES avis_core_v2.platform_connectors,
 event_type text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz,
 UNIQUE(user_id,connector_code,event_type)
);
ALTER TABLE avis_core_v2.ledger_journals ADD COLUMN request_payload jsonb;
ALTER TABLE avis_core_v2.ledger_journals ADD COLUMN actor_id text;
ALTER TABLE avis_core_v2.ledger_journals ADD COLUMN reverses_journal_id uuid UNIQUE REFERENCES avis_core_v2.ledger_journals;

CREATE FUNCTION avis_core_v2.immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'APPEND_ONLY_RECORD'; END $$;
CREATE TRIGGER immutable_journal BEFORE UPDATE OR DELETE ON avis_core_v2.ledger_journals
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
CREATE TRIGGER immutable_entry BEFORE UPDATE OR DELETE ON avis_core_v2.ledger_entries
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON avis_core_v2.operation_audit
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

CREATE FUNCTION avis_core_v2.post_journal(request_key text, event_name text, reference text,
 actor text, lines jsonb, reverses uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE prior avis_core_v2.ledger_journals%ROWTYPE; journal uuid; locked_account record; line jsonb;
 payload jsonb; delta numeric; balance numeric; quantity numeric;
BEGIN
 IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 128
 OR actor IS NULL OR length(actor)=0 OR event_name IS NULL OR length(event_name) NOT BETWEEN 1 AND 50
 OR jsonb_typeof(lines) IS DISTINCT FROM 'array' OR jsonb_array_length(lines) NOT BETWEEN 2 AND 200 THEN
  RAISE EXCEPTION 'INVALID_JOURNAL';
 END IF;
 payload := jsonb_build_object('event',event_name,'reference',reference,'lines',lines,'reverses',reverses);
 PERFORM pg_advisory_xact_lock(hashtextextended('journal:'||request_key,0));
 SELECT * INTO prior FROM avis_core_v2.ledger_journals WHERE idempotency_key=request_key;
 IF FOUND THEN
  IF prior.request_payload IS DISTINCT FROM payload OR prior.actor_id IS DISTINCT FROM actor THEN
   RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT';
  END IF;
  RETURN prior.journal_id;
 END IF;
 FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
  IF (line->>'direction') NOT IN ('DEBIT','CREDIT') OR (line->>'direction') IS NULL
  OR jsonb_typeof(line->'amount') IS DISTINCT FROM 'string'
  OR (line->>'amount') !~ '^[0-9]{1,18}(\.[0-9]{1,18})?$'
  OR (line->>'amount')::numeric <= 0 OR NOT EXISTS
   (SELECT 1 FROM avis_core_v2.ledger_accounts WHERE account_id=(line->>'accountId')::uuid) THEN
   RAISE EXCEPTION 'INVALID_JOURNAL_LINE';
  END IF;
 END LOOP;
 -- Lock in deterministic order, then validate each asset/network independently.
 PERFORM 1 FROM avis_core_v2.ledger_accounts WHERE account_id IN
  (SELECT (value->>'accountId')::uuid FROM jsonb_array_elements(lines)) ORDER BY account_id FOR UPDATE;
 IF EXISTS (
  SELECT 1 FROM jsonb_array_elements(lines) l JOIN avis_core_v2.ledger_accounts a ON a.account_id=(l->>'accountId')::uuid
  GROUP BY a.currency_code,a.network
  HAVING sum((l->>'amount')::numeric * CASE WHEN l->>'direction'='DEBIT' THEN 1 ELSE -1 END)<>0
 ) THEN RAISE EXCEPTION 'UNBALANCED_JOURNAL'; END IF;
 FOR locked_account IN SELECT * FROM avis_core_v2.ledger_accounts WHERE account_id IN
  (SELECT (value->>'accountId')::uuid FROM jsonb_array_elements(lines)) LOOP
  SELECT sum((l->>'amount')::numeric * CASE WHEN (l->>'direction'='DEBIT') =
   (locked_account.account_category IN ('ASSET','EXPENSE')) THEN 1 ELSE -1 END)
   INTO delta FROM jsonb_array_elements(lines) l WHERE (l->>'accountId')::uuid=locked_account.account_id;
  IF locked_account.owner_type IN ('USER','MARKETPLACE_ESCROW','SUSPENSE_INBOUND','SUSPENSE_OUTBOUND','SUSPENSE_CARD_FX')
   AND locked_account.available_balance+delta<0 THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS'; END IF;
 END LOOP;
 INSERT INTO avis_core_v2.ledger_journals(idempotency_key,event_type,reference_id,request_payload,actor_id,reverses_journal_id)
 VALUES(request_key,event_name,reference,payload,actor,reverses) RETURNING journal_id INTO journal;
 FOR line IN SELECT value FROM jsonb_array_elements(lines) LOOP
  quantity := (line->>'amount')::numeric;
  UPDATE avis_core_v2.ledger_accounts SET available_balance=available_balance + quantity *
   CASE WHEN (line->>'direction'='DEBIT')=(account_category IN ('ASSET','EXPENSE')) THEN 1 ELSE -1 END,
   updated_at=now() WHERE account_id=(line->>'accountId')::uuid RETURNING available_balance INTO balance;
  INSERT INTO avis_core_v2.ledger_entries(journal_id,account_id,direction,amount,running_balance)
   VALUES(journal,(line->>'accountId')::uuid,line->>'direction',quantity,balance);
 END LOOP;
 RETURN journal;
END $$;

-- Default own-network participant from ABIQ v8.1 §3; no external bank identity is allocated.
INSERT INTO avis_core_v2.abiq_network_participants(participant_code,institution_name,abiq_bic,is_active)
 VALUES('AVIS','AVISPay PLC','AVISIQMMXXX',true) ON CONFLICT DO NOTHING;

-- POS v6 §3: issuing, switch, terminals and gateway routing are separate records.
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN card_rail_mode varchar(25) NOT NULL DEFAULT 'AVIS_PROPRIETARY_ONLY'
 CHECK(card_rail_mode IN ('AVIS_PROPRIETARY_ONLY','GLOBAL_SCHEME_ONLY','DUAL_COBADGED'));
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN funding_account_id uuid REFERENCES avis_core_v2.ledger_accounts;
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN proprietary_aid varchar(32)
 CHECK(proprietary_aid ~ '^([A-F0-9]{2}){5,16}$');
ALTER TABLE avis_core_v2.avis_cards ADD COLUMN global_scheme_aid varchar(32)
 CHECK(global_scheme_aid ~ '^([A-F0-9]{2}){5,16}$');
CREATE TABLE avis_core_v2.pos_terminals (
 terminal_id varchar(32) PRIMARY KEY, merchant_id varchar(64) NOT NULL REFERENCES avis_core_v2.marketplace_merchants,
 terminal_type varchar(25) NOT NULL CHECK(terminal_type IN ('SMART_POS','SOFTPOS_NFC','TRANSIT_GATE','UNATTENDED_KIOSK','WEB_POS')),
 terminal_public_key_pem text, offline_enabled boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','RETIRED')),
 last_heartbeat_at timestamptz
);
CREATE TABLE avis_core_v2.payment_gateway_bridges (
 gateway_code varchar(32) PRIMARY KEY,
 gateway_category varchar(25) NOT NULL CHECK(gateway_category IN ('PROPRIETARY_CARD','GLOBAL_CARD_SCHEME','EXTERNAL_PSP','OPEN_BANKING')),
 display_name varchar(100) NOT NULL, endpoint_url text, credential_reference text,
 clearing_account_id uuid REFERENCES avis_core_v2.external_cash_accounts,
 settlement_cycle varchar(15) NOT NULL DEFAULT 'INSTANT', interchange_fee_bps int NOT NULL DEFAULT 0 CHECK(interchange_fee_bps BETWEEN 0 AND 10000),
 is_active boolean NOT NULL DEFAULT false
);
INSERT INTO avis_core_v2.payment_gateway_bridges(gateway_code,gateway_category,display_name,is_active)
 VALUES('AVIS_PROPRIETARY_LOOP','PROPRIETARY_CARD','AVIS Card Switch',true);
CREATE TABLE avis_core_v2.card_authorizations (
 authorization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), card_id uuid NOT NULL REFERENCES avis_core_v2.avis_cards,
 terminal_id varchar(32) NOT NULL REFERENCES avis_core_v2.pos_terminals, network_reference varchar(128) UNIQUE NOT NULL,
 amount numeric(36,18) NOT NULL CHECK(amount>0), currency_code varchar(25) NOT NULL,
 status varchar(15) NOT NULL CHECK(status IN ('AUTHORIZED','CAPTURED','REVERSED')),
 authorization_journal_id uuid NOT NULL REFERENCES avis_core_v2.ledger_journals,
 settlement_journal_id uuid REFERENCES avis_core_v2.ledger_journals,
 created_at timestamptz NOT NULL DEFAULT now()
);
