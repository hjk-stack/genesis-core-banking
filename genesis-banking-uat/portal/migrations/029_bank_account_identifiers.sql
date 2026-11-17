-- Number existing FIAT bank/custody ledgers without replacing accounts or postings.
-- Customer routing keeps its current primary identifier and all historical aliases.
-- Additional ledgers use the installed AVIP serial issuer and its shared sequence.
ALTER TABLE avis_core_v2.ledger_accounts ADD CONSTRAINT abiq_numbered_ledger_currency
 UNIQUE(account_id,currency_code);

CREATE TABLE avis_core_v2.abiq_ledger_identifiers (
 ledger_account_id uuid PRIMARY KEY,
 participant_code varchar(4) NOT NULL REFERENCES avis_core_v2.abiq_issuers
  CHECK(participant_code='AVIP'),
 currency_code varchar(3) NOT NULL,
 iso_numeric_partition varchar(4) NOT NULL,
 account_number bigint NOT NULL UNIQUE CHECK(account_number BETWEEN 1 AND 99999999999999),
 abiq_iban varchar(25) NOT NULL UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(ledger_account_id,currency_code)
  REFERENCES avis_core_v2.ledger_accounts(account_id,currency_code),
 FOREIGN KEY(currency_code,iso_numeric_partition)
  REFERENCES avis_core_v2.abiq_currencies(currency_code,iso_numeric_partition),
 CHECK(abiq_iban=avis_core_v2.issued_abiq_identifier('TN',participant_code,right(iso_numeric_partition,3),account_number))
);

CREATE FUNCTION avis_core_v2.validate_ledger_abiq_identifier() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE account avis_core_v2.ledger_accounts%ROWTYPE;
BEGIN
 SELECT * INTO account FROM avis_core_v2.ledger_accounts
  WHERE account_id=NEW.ledger_account_id FOR UPDATE;
 IF NOT FOUND OR account.network IS NOT NULL OR account.currency_code<>NEW.currency_code THEN
  RAISE EXCEPTION 'ABIQ_LEDGER_IDENTITY_MISMATCH';
 END IF;
 -- Serialize checks across the existing bridge/alias and additional-ledger namespaces.
 PERFORM pg_advisory_xact_lock(hashtextextended('abiq:serial:'||NEW.account_number,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('abiq:identifier:'||NEW.abiq_iban,0));
 IF EXISTS(SELECT 1 FROM avis_core_v2.abiq_routing_bridge
    WHERE account_number=NEW.account_number AND ledger_account_id<>NEW.ledger_account_id)
  OR EXISTS(SELECT 1 FROM avis_core_v2.abiq_identifier_routes r
    JOIN avis_core_v2.abiq_routing_bridge b USING(bridge_id)
    WHERE r.identifier=NEW.abiq_iban AND b.ledger_account_id<>NEW.ledger_account_id) THEN
  RAISE EXCEPTION 'ABIQ_IDENTIFIER_ALREADY_ASSIGNED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER validate_ledger_abiq_identifier BEFORE INSERT ON avis_core_v2.abiq_ledger_identifiers
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.validate_ledger_abiq_identifier();
CREATE TRIGGER ledger_abiq_identifier_immutable BEFORE UPDATE OR DELETE ON avis_core_v2.abiq_ledger_identifiers
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

-- A future primary bridge or historical alias cannot reuse another ledger's number.
CREATE FUNCTION avis_core_v2.protect_ledger_abiq_namespace() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE account_id uuid; identifier text;
BEGIN
 IF TG_TABLE_NAME='abiq_routing_bridge' THEN
  account_id:=NEW.ledger_account_id;identifier:=NEW.abiq_iban;
  IF TG_OP='UPDATE' AND NEW.ledger_account_id IS DISTINCT FROM OLD.ledger_account_id THEN
   RAISE EXCEPTION 'ABIQ_LEDGER_IDENTITY_MISMATCH';
  END IF;
  IF NEW.account_number IS NOT NULL THEN
   PERFORM pg_advisory_xact_lock(hashtextextended('abiq:serial:'||NEW.account_number,0));
   IF EXISTS(SELECT 1 FROM avis_core_v2.abiq_ledger_identifiers i
     WHERE i.account_number=NEW.account_number AND i.ledger_account_id<>account_id) THEN
    RAISE EXCEPTION 'ABIQ_IDENTIFIER_ALREADY_ASSIGNED';
   END IF;
  END IF;
 ELSE
  SELECT ledger_account_id INTO account_id FROM avis_core_v2.abiq_routing_bridge WHERE bridge_id=NEW.bridge_id;
  identifier:=NEW.identifier;
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('abiq:identifier:'||identifier,0));
 IF EXISTS(SELECT 1 FROM avis_core_v2.abiq_ledger_identifiers i
   WHERE i.abiq_iban=identifier AND i.ledger_account_id IS DISTINCT FROM account_id) THEN
  RAISE EXCEPTION 'ABIQ_IDENTIFIER_ALREADY_ASSIGNED';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_ledger_abiq_bridge_namespace
 BEFORE INSERT OR UPDATE OF ledger_account_id,abiq_iban,account_number ON avis_core_v2.abiq_routing_bridge
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.protect_ledger_abiq_namespace();
-- Fresh primaries may have no dependent aliases, routes or payments yet. Preserve
-- their identity too; the existing CLOSED status handles account closure.
CREATE TRIGGER preserve_primary_abiq_identifier BEFORE DELETE ON avis_core_v2.abiq_routing_bridge
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
CREATE TRIGGER protect_ledger_abiq_alias_namespace
 BEFORE INSERT OR UPDATE ON avis_core_v2.abiq_identifier_aliases
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.protect_ledger_abiq_namespace();

-- An existing unbridged funding ledger may receive its customer primary later.
-- Keep its previously issued serial identifier resolvable against the same account.
CREATE FUNCTION avis_core_v2.retain_ledger_abiq_alias() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO avis_core_v2.abiq_identifier_aliases(identifier,bridge_id)
  SELECT abiq_iban,NEW.bridge_id FROM avis_core_v2.abiq_ledger_identifiers
  WHERE ledger_account_id=NEW.ledger_account_id AND abiq_iban<>NEW.abiq_iban;
 RETURN NULL;
END $$;
CREATE TRIGGER retain_ledger_abiq_alias AFTER INSERT ON avis_core_v2.abiq_routing_bridge
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.retain_ledger_abiq_alias();

CREATE FUNCTION avis_core_v2.protect_numbered_ledger_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.owner_type,NEW.user_id,NEW.sub_account_code,NEW.currency_code,NEW.network,NEW.wallet_scope,NEW.account_category)
   IS DISTINCT FROM ROW(OLD.owner_type,OLD.user_id,OLD.sub_account_code,OLD.currency_code,OLD.network,OLD.wallet_scope,OLD.account_category)
  AND EXISTS(SELECT 1 FROM avis_core_v2.abiq_ledger_identifiers WHERE ledger_account_id=OLD.account_id) THEN
  RAISE EXCEPTION 'ABIQ_LEDGER_IDENTITY_MISMATCH';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER protect_numbered_ledger_identity
 BEFORE UPDATE OF owner_type,user_id,sub_account_code,currency_code,network,wallet_scope,account_category ON avis_core_v2.ledger_accounts
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.protect_numbered_ledger_identity();

CREATE FUNCTION avis_core_v2.ensure_ledger_abiq(ledger_id uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE account avis_core_v2.ledger_accounts%ROWTYPE;
 issuer avis_core_v2.abiq_issuers%ROWTYPE; partition_code text; identifier text; serial bigint;
BEGIN
 -- Account-level locking makes explicit calls, deferred triggers and retries agree.
 SELECT * INTO account FROM avis_core_v2.ledger_accounts WHERE account_id=ledger_id FOR UPDATE;
 IF NOT FOUND OR account.network IS NOT NULL THEN RETURN NULL; END IF;
 SELECT iso_numeric_partition INTO partition_code FROM avis_core_v2.abiq_currencies
  WHERE currency_code=account.currency_code;
 -- This excludes crypto wallets AND unnetworked crypto treasury/clearing buckets.
 IF NOT FOUND THEN RETURN NULL; END IF;
 SELECT abiq_iban INTO identifier FROM avis_core_v2.abiq_routing_bridge WHERE ledger_account_id=ledger_id;
 IF FOUND THEN RETURN identifier; END IF;
 SELECT abiq_iban INTO identifier FROM avis_core_v2.abiq_ledger_identifiers WHERE ledger_account_id=ledger_id;
 IF FOUND THEN RETURN identifier; END IF;
 SELECT i.* INTO issuer FROM avis_core_v2.abiq_issuers i
  JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
  WHERE i.participant_code='AVIP' AND i.country_code='TN' AND p.is_active AND p.abiq_bic=i.abiq_code
  FOR SHARE OF i,p;
 IF NOT FOUND THEN RAISE EXCEPTION 'ABIQ_PARTICIPANT_NOT_ACTIVE'; END IF;
 serial:=nextval('avis_core_v2.abiq_account_numbers');
 identifier:=avis_core_v2.issued_abiq_identifier(issuer.country_code,issuer.participant_code,right(partition_code,3),serial);
 INSERT INTO avis_core_v2.abiq_ledger_identifiers
  (ledger_account_id,participant_code,currency_code,iso_numeric_partition,account_number,abiq_iban)
  VALUES(ledger_id,issuer.participant_code,account.currency_code,partition_code,serial,identifier);
 RETURN identifier;
END $$;

CREATE FUNCTION avis_core_v2.ensure_new_ledger_abiq() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM avis_core_v2.ensure_ledger_abiq(NEW.account_id);
 RETURN NULL;
END $$;
-- Wait until the transaction has installed any customer bridge; do not allocate a
-- throwaway serial for an account that already receives its customer primary.
CREATE CONSTRAINT TRIGGER ensure_new_ledger_abiq
 AFTER INSERT OR UPDATE OF currency_code,network ON avis_core_v2.ledger_accounts
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.network IS NULL)
 EXECUTE FUNCTION avis_core_v2.ensure_new_ledger_abiq();

CREATE VIEW avis_core_v2.abiq_account_identifiers AS
 SELECT b.ledger_account_id,b.abiq_iban,b.participant_code,b.currency_code,b.status,
  b.account_number,'ROUTING_BRIDGE'::text AS identifier_source
 FROM avis_core_v2.abiq_routing_bridge b
 UNION ALL
 SELECT i.ledger_account_id,i.abiq_iban,i.participant_code,i.currency_code,
  CASE WHEN p.is_active AND p.abiq_bic=s.abiq_code THEN 'ACTIVE' ELSE 'SUSPENDED' END AS status,
  i.account_number,'LEDGER_REGISTRY'::text AS identifier_source
 FROM avis_core_v2.abiq_ledger_identifiers i
 JOIN avis_core_v2.abiq_issuers s USING(participant_code)
 JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
 WHERE NOT EXISTS(SELECT 1 FROM avis_core_v2.abiq_routing_bridge b WHERE b.ledger_account_id=i.ledger_account_id);

-- Metadata-only populated upgrade. No new ledgers, holders, positions or postings.
DO $$ DECLARE ledger_id uuid; BEGIN
 FOR ledger_id IN SELECT a.account_id FROM avis_core_v2.ledger_accounts a
  JOIN avis_core_v2.abiq_currencies c USING(currency_code)
  WHERE a.network IS NULL ORDER BY a.account_id LOOP
  PERFORM avis_core_v2.ensure_ledger_abiq(ledger_id);
 END LOOP;
END $$;
