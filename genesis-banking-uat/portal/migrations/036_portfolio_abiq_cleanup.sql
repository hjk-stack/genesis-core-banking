-- Portfolio accounts are denominated in the custody code. Security prices retain their currencies.
CREATE TABLE avis_core_v2.portfolio_abiq_accounts (
 user_id bigint PRIMARY KEY REFERENCES avis_core_v2.sovereign_users,
 identifier text NOT NULL UNIQUE REFERENCES avis_core_v2.abiq_generated_numbers(identifier)
);

CREATE FUNCTION avis_core_v2.ensure_portfolio_abiq(owner_id bigint) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('portfolio-abiq:'||owner_id,0));
 IF NOT EXISTS (SELECT FROM avis_core_v2.portfolio_abiq_accounts WHERE user_id=owner_id) THEN
  INSERT INTO avis_core_v2.portfolio_abiq_accounts VALUES
   (owner_id,avis_core_v2.issue_abiq_number('TN','AVIP','579',NULL,'system:portfolio'));
 END IF;
END $$;

CREATE FUNCTION avis_core_v2.number_security_portfolio() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_TABLE_NAME='treasury_opening_positions' THEN
  IF NEW.asset_class='SECURITY' THEN PERFORM avis_core_v2.ensure_portfolio_abiq(NEW.owner_user_id); END IF;
 ELSIF EXISTS (SELECT FROM avis_core_v2.portfolio_securities WHERE security_id=NEW.security_id AND kind NOT IN ('token','crypto')) THEN
  PERFORM avis_core_v2.ensure_portfolio_abiq(NEW.user_id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER number_security_position AFTER INSERT OR UPDATE OF user_id,security_id ON avis_core_v2.portfolio_positions
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.number_security_portfolio();
CREATE TRIGGER number_treasury_security AFTER INSERT ON avis_core_v2.treasury_opening_positions
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.number_security_portfolio();
CREATE FUNCTION avis_core_v2.number_reclassified_portfolios() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM avis_core_v2.ensure_portfolio_abiq(p.user_id) FROM avis_core_v2.portfolio_positions p
 WHERE p.security_id=NEW.security_id ORDER BY p.user_id;
 RETURN NEW;
END $$;
CREATE TRIGGER number_reclassified_portfolios AFTER UPDATE OF kind ON avis_core_v2.portfolio_securities
 FOR EACH ROW WHEN (OLD.kind IN ('token','crypto') AND NEW.kind NOT IN ('token','crypto'))
 EXECUTE FUNCTION avis_core_v2.number_reclassified_portfolios();
SELECT avis_core_v2.ensure_portfolio_abiq(owner_id) FROM (
 SELECT p.user_id AS owner_id FROM avis_core_v2.portfolio_positions p JOIN avis_core_v2.portfolio_securities s USING(security_id)
 WHERE s.kind NOT IN ('token','crypto')
 UNION SELECT owner_user_id FROM avis_core_v2.treasury_opening_positions WHERE asset_class='SECURITY'
) owners ORDER BY owner_id;

CREATE TABLE avis_core_v2.legacy_account_cleanup (
 account_id uuid PRIMARY KEY, action text NOT NULL CHECK(action IN ('DELETE','RENUMBER')),
 former_identifier text NOT NULL, replacement_identifier text, ledger_snapshot jsonb NOT NULL,
 registry_snapshot jsonb NOT NULL, actor text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER preserve_legacy_cleanup BEFORE UPDATE OR DELETE ON avis_core_v2.legacy_account_cleanup
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

-- Check every declared ledger reference, including historical entries, orders, holds and aliases.
CREATE FUNCTION avis_core_v2.legacy_ledger_referenced(target uuid) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE link record; present boolean;
BEGIN
 FOR link IN
  SELECT DISTINCT c.conrelid::regclass AS relation,a.attname AS column_name
  FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey,c.confkey) AS k(local_col,foreign_col)
  JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.local_col
  JOIN pg_attribute f ON f.attrelid=c.confrelid AND f.attnum=k.foreign_col
  WHERE c.contype='f' AND c.confrelid='avis_core_v2.ledger_accounts'::regclass
   AND f.attname='account_id' AND c.conrelid<>'avis_core_v2.abiq_ledger_identifiers'::regclass
 LOOP
  EXECUTE format('SELECT EXISTS(SELECT FROM %s WHERE %I=$1)',link.relation,link.column_name) INTO present USING target;
  IF present THEN RETURN true; END IF;
 END LOOP;
 RETURN false;
END $$;

CREATE VIEW avis_core_v2.legacy_account_review AS
 SELECT a.account_id,a.user_id,h.full_name,a.wallet_scope,a.currency_code,i.abiq_iban AS former_identifier,
 CASE WHEN a.available_balance<>0 OR a.locked_balance<>0 OR avis_core_v2.legacy_ledger_referenced(a.account_id)
 OR (a.wallet_scope='CUSTODY' AND EXISTS(
   SELECT FROM avis_core_v2.portfolio_positions p JOIN avis_core_v2.portfolio_securities s USING(security_id)
   JOIN avis_core_v2.holder_identities ph ON ph.record_user_id=p.user_id
   WHERE ph.user_id=h.user_id AND s.currency_code=a.currency_code AND s.kind NOT IN ('token','crypto')
     AND (p.quantity<>0 OR p.reserved_quantity<>0)))
 THEN 'RENUMBER' ELSE 'DELETE' END AS action
 FROM avis_core_v2.ledger_accounts a
 JOIN avis_core_v2.holder_identities h ON h.record_user_id=a.user_id
 JOIN avis_core_v2.abiq_ledger_identifiers i ON i.ledger_account_id=a.account_id
 JOIN avis_core_v2.abiq_account_identifiers current_id ON current_id.ledger_account_id=a.account_id AND current_id.abiq_iban=i.abiq_iban
 WHERE a.owner_type='USER' AND a.network IS NULL AND current_id.identifier_source='LEDGER_REGISTRY'
 AND i.abiq_iban ~ '^TN[0-9]{2}AVIP[0-9]{17}$';

-- Ordinary registry mutations remain append-only. Only release a serial whose exact record was archived.
CREATE FUNCTION avis_core_v2.preserve_legacy_serial() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' AND EXISTS (SELECT FROM avis_core_v2.legacy_account_cleanup
  WHERE account_id=OLD.ledger_account_id AND action='DELETE' AND registry_snapshot=to_jsonb(OLD)) THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'APPEND_ONLY_RECORD';
END $$;
DROP TRIGGER ledger_abiq_identifier_immutable ON avis_core_v2.abiq_ledger_identifiers;
CREATE TRIGGER ledger_abiq_identifier_immutable BEFORE UPDATE OR DELETE ON avis_core_v2.abiq_ledger_identifiers
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.preserve_legacy_serial();

CREATE FUNCTION avis_core_v2.repair_legacy_account(target uuid,expected_action text,operator_id text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE candidate record; code text; replacement text;
BEGIN
 PERFORM 1 FROM avis_core_v2.ledger_accounts WHERE account_id=target FOR UPDATE;
 SELECT * INTO candidate FROM avis_core_v2.legacy_account_review WHERE account_id=target;
 IF NOT FOUND OR candidate.action IS DISTINCT FROM expected_action THEN RAISE EXCEPTION 'ACCOUNT_REVIEW_CHANGED'; END IF;
 IF candidate.action='RENUMBER' THEN
  code:=CASE WHEN candidate.wallet_scope='CUSTODY' THEN '579' ELSE candidate.currency_code END;
  replacement:=avis_core_v2.issue_abiq_number('TN','AVIP',code,NULL,operator_id);
 END IF;
 INSERT INTO avis_core_v2.legacy_account_cleanup(account_id,action,former_identifier,replacement_identifier,ledger_snapshot,registry_snapshot,actor)
  SELECT target,candidate.action,candidate.former_identifier,replacement,to_jsonb(a),to_jsonb(i),operator_id
  FROM avis_core_v2.ledger_accounts a JOIN avis_core_v2.abiq_ledger_identifiers i ON i.ledger_account_id=a.account_id
  WHERE a.account_id=target;
 IF candidate.action='DELETE' THEN
  DELETE FROM avis_core_v2.abiq_ledger_identifiers WHERE ledger_account_id=target;
  DELETE FROM avis_core_v2.ledger_accounts WHERE account_id=target;
 ELSE
  INSERT INTO avis_core_v2.abiq_number_bindings VALUES(replacement,code,target,true);
 END IF;
 RETURN replacement;
END $$;

-- Correct retained accounts immediately. The separate review lists empty accounts for deletion.
LOCK TABLE avis_core_v2.portfolio_positions,avis_core_v2.portfolio_securities IN SHARE MODE;
DO $$ DECLARE candidate record;
BEGIN
 FOR candidate IN SELECT account_id FROM avis_core_v2.legacy_account_review WHERE action='RENUMBER' ORDER BY account_id LOOP
  PERFORM avis_core_v2.repair_legacy_account(candidate.account_id,'RENUMBER','system:legacy-account-repair');
 END LOOP;
END $$;
