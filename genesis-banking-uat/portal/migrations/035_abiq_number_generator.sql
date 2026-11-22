-- Funding customers and number-only issues share the AVIP namespace. Each other
-- four-letter holder has its own series of seven-digit numbers starting at 1000101.
CREATE TABLE avis_core_v2.abiq_number_cursors (
 holder_code text PRIMARY KEY CHECK (holder_code ~ '^[A-Z]{4}$'),
 next_number integer NOT NULL CHECK (next_number BETWEEN 1000101 AND 10000000)
);
CREATE TABLE avis_core_v2.abiq_number_picks (
 holder_code text REFERENCES avis_core_v2.abiq_number_cursors,
 customer_number integer CHECK (customer_number BETWEEN 1000101 AND 9999999),
 PRIMARY KEY(holder_code,customer_number)
);
INSERT INTO avis_core_v2.abiq_number_cursors
 SELECT 'AVIP',greatest(1000101,last_value + CASE WHEN is_called THEN 1 ELSE 0 END,
  coalesce((SELECT max(customer_number)+1 FROM avis_core_v2.abiq_customer_numbers),1000101))
 FROM avis_core_v2.abiq_customer_numbers_seq;

CREATE FUNCTION avis_core_v2.abiq_number_choices(holder text) RETURNS SETOF integer
LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE candidate integer; offered integer:=0;
BEGIN
 IF holder !~ '^[A-Z]{4}$' THEN RAISE EXCEPTION 'ABIQ_HOLDER_CODE'; END IF;
 SELECT next_number INTO candidate FROM avis_core_v2.abiq_number_cursors WHERE holder_code=holder;
 candidate:=coalesce(candidate,1000101);
 WHILE candidate<=9999999 AND offered<12 LOOP
  IF NOT EXISTS(SELECT FROM avis_core_v2.abiq_number_picks WHERE holder_code=holder AND customer_number=candidate) THEN
   RETURN NEXT candidate; offered:=offered+1;
  END IF;
  candidate:=candidate+1;
 END LOOP;
END $$;

CREATE FUNCTION avis_core_v2.take_abiq_number(holder text,requested integer DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE first_free integer; chosen integer;
BEGIN
 INSERT INTO avis_core_v2.abiq_number_cursors VALUES(holder,1000101) ON CONFLICT DO NOTHING;
 SELECT next_number INTO STRICT first_free FROM avis_core_v2.abiq_number_cursors WHERE holder_code=holder FOR UPDATE;
 IF first_free>9999999 THEN RAISE EXCEPTION 'ABIQ_NUMBER_EXHAUSTED'; END IF;
 chosen:=coalesce(requested,first_free);
 IF chosen<>first_free AND NOT EXISTS(SELECT FROM avis_core_v2.abiq_number_choices(holder) n WHERE n=chosen) THEN
  RAISE EXCEPTION 'ABIQ_NUMBER_TAKEN';
 END IF;
 IF chosen=first_free THEN
  first_free:=first_free+1;
  LOOP
   DELETE FROM avis_core_v2.abiq_number_picks WHERE holder_code=holder AND customer_number=first_free;
   EXIT WHEN NOT FOUND;
   first_free:=first_free+1;
  END LOOP;
  UPDATE avis_core_v2.abiq_number_cursors SET next_number=first_free WHERE holder_code=holder;
 ELSE
  INSERT INTO avis_core_v2.abiq_number_picks VALUES(holder,chosen);
 END IF;
 RETURN chosen;
END $$;

ALTER TABLE avis_core_v2.abiq_customer_numbers ALTER COLUMN customer_number
 SET DEFAULT avis_core_v2.take_abiq_number('AVIP');

-- The internal custody code participates only in number issuance.
CREATE VIEW avis_core_v2.abiq_number_codes AS
 SELECT currency_code,iso_numeric_partition,account_series,currency_code::text AS label FROM avis_core_v2.abiq_currencies
 UNION ALL SELECT '579','0579',15,'Custodial account';

CREATE TABLE avis_core_v2.abiq_generated_numbers (
 identifier text PRIMARY KEY, country_code text NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
 holder_code text NOT NULL, currency_code varchar(3) NOT NULL,
 fiat_currency varchar(3) GENERATED ALWAYS AS (nullif(currency_code,'579')) STORED,
 iso_numeric_partition varchar(4) NOT NULL, account_series integer NOT NULL, customer_number integer NOT NULL,
 issued_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(holder_code,customer_number,country_code,currency_code), UNIQUE(identifier,currency_code),
 CHECK(currency_code<>'579' OR (iso_numeric_partition='0579' AND account_series=15)),
 FOREIGN KEY(fiat_currency,iso_numeric_partition) REFERENCES avis_core_v2.abiq_currencies(currency_code,iso_numeric_partition),
 FOREIGN KEY(fiat_currency,account_series) REFERENCES avis_core_v2.abiq_currencies(currency_code,account_series),
 CHECK(identifier=avis_core_v2.customer_abiq_identifier(country_code,holder_code,right(iso_numeric_partition,3),account_series,customer_number))
);
CREATE TABLE avis_core_v2.abiq_number_bindings (
 identifier text PRIMARY KEY, currency_code varchar(3) NOT NULL, ledger_account_id uuid NOT NULL,
 primary_for_ledger boolean NOT NULL DEFAULT false,
 FOREIGN KEY(identifier,currency_code) REFERENCES avis_core_v2.abiq_generated_numbers(identifier,currency_code),
 FOREIGN KEY(ledger_account_id) REFERENCES avis_core_v2.ledger_accounts(account_id)
);
CREATE UNIQUE INDEX abiq_new_ledger_primary ON avis_core_v2.abiq_number_bindings(ledger_account_id) WHERE primary_for_ledger;
CREATE INDEX abiq_number_account_lookup ON avis_core_v2.abiq_number_bindings(ledger_account_id);
CREATE INDEX abiq_generator_issues_by_actor ON avis_core_v2.abiq_generated_numbers(issued_by,created_at DESC);
CREATE TRIGGER preserve_generated_abiq BEFORE UPDATE OR DELETE ON avis_core_v2.abiq_generated_numbers
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
CREATE TRIGGER preserve_abiq_binding BEFORE UPDATE OR DELETE ON avis_core_v2.abiq_number_bindings
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

CREATE FUNCTION avis_core_v2.issue_abiq_number(country text,holder text,curr text,requested integer,actor text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE c avis_core_v2.abiq_number_codes%ROWTYPE; n integer; id text;
BEGIN
 SELECT * INTO c FROM avis_core_v2.abiq_number_codes WHERE currency_code=curr;
 IF NOT FOUND THEN RAISE EXCEPTION 'ABIQ_UNSUPPORTED_CURRENCY'; END IF;
 -- A manually issued customer number can be used for another currency of the
 -- same holder. The original allocating operator retains this use of the suffix.
 IF requested IS NOT NULL AND EXISTS(SELECT FROM avis_core_v2.abiq_generated_numbers
  WHERE holder_code=holder AND customer_number=requested AND issued_by=actor) THEN
  PERFORM pg_advisory_xact_lock(hashtextextended('abiq:issue:'||holder||':'||requested||':'||country||':'||curr,0));
  IF EXISTS(SELECT FROM avis_core_v2.abiq_generated_numbers
   WHERE holder_code=holder AND customer_number=requested AND country_code=country AND currency_code=curr) THEN
   RAISE EXCEPTION 'ABIQ_NUMBER_TAKEN';
  END IF;
  n:=requested;
 ELSE
  n:=avis_core_v2.take_abiq_number(holder,requested);
 END IF;
 id:=avis_core_v2.customer_abiq_identifier(country,holder,right(c.iso_numeric_partition,3),c.account_series,n);
 INSERT INTO avis_core_v2.abiq_generated_numbers(identifier,country_code,holder_code,currency_code,iso_numeric_partition,account_series,customer_number,issued_by)
 VALUES(id,country,holder,curr,c.iso_numeric_partition,c.account_series,n,actor);
 RETURN id;
END $$;

CREATE FUNCTION avis_core_v2.check_abiq_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_currencies c USING(currency_code)
  WHERE a.account_id=NEW.ledger_account_id AND a.network IS NULL AND (a.currency_code=NEW.currency_code OR (a.wallet_scope='CUSTODY' AND NEW.currency_code='579')) FOR SHARE OF a)
 THEN RAISE EXCEPTION 'ABIQ_LEDGER_IDENTITY_MISMATCH'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER check_generated_abiq_binding BEFORE INSERT ON avis_core_v2.abiq_number_bindings
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.check_abiq_binding();

-- Preserve the original registry IDs and aliases. Only future non-funding ledgers
-- receive a new primary here; existing numbered accounts are never renumbered.
ALTER VIEW avis_core_v2.abiq_account_identifiers RENAME TO abiq_account_identifiers_base;
CREATE VIEW avis_core_v2.abiq_account_identifiers AS
 SELECT i.ledger_account_id,coalesce(g.identifier,i.abiq_iban) AS abiq_iban,i.participant_code,
  i.currency_code,i.status,i.account_number,i.identifier_source
 FROM avis_core_v2.abiq_account_identifiers_base i
 LEFT JOIN avis_core_v2.abiq_number_bindings g ON g.ledger_account_id=i.ledger_account_id
  AND g.primary_for_ledger AND i.identifier_source='LEDGER_REGISTRY';

CREATE OR REPLACE VIEW avis_core_v2.abiq_identifier_routes AS
 SELECT abiq_iban AS identifier,bridge_id FROM avis_core_v2.abiq_routing_bridge
 UNION ALL SELECT identifier,bridge_id FROM avis_core_v2.abiq_identifier_aliases
 UNION ALL SELECT g.identifier::varchar,b.bridge_id FROM avis_core_v2.abiq_number_bindings g
 JOIN avis_core_v2.abiq_routing_bridge b USING(ledger_account_id);

ALTER FUNCTION avis_core_v2.ensure_ledger_abiq(uuid) RENAME TO ensure_ledger_abiq_serial;
CREATE FUNCTION avis_core_v2.ensure_ledger_abiq(ledger_id uuid) RETURNS text LANGUAGE plpgsql AS $$
DECLARE curr text; id text;
BEGIN
 SELECT CASE WHEN a.wallet_scope='CUSTODY' THEN '579' ELSE a.currency_code END INTO curr FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_currencies c USING(currency_code)
  WHERE a.account_id=ledger_id AND a.network IS NULL FOR UPDATE OF a;
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT abiq_iban INTO id FROM avis_core_v2.abiq_account_identifiers WHERE ledger_account_id=ledger_id;
 IF FOUND THEN RETURN id; END IF;
 PERFORM avis_core_v2.ensure_ledger_abiq_serial(ledger_id);
 id:=avis_core_v2.issue_abiq_number('TN','AVIP',curr,NULL,'system:ledger');
 INSERT INTO avis_core_v2.abiq_number_bindings VALUES(id,curr,ledger_id,true);
 RETURN id;
END $$;
