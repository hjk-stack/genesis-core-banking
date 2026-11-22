-- Convert existing Common and Suspense FIAT accounts from the original 25-character
-- serial to the 26-character currency/series ABIQ account number.
-- The ledger account ID, old identifier registry, money, bookings and histories
-- remain unchanged. The old serial stays resolvable as a historical identifier.
CREATE TABLE avis_core_v2.backoffice_abiq_number_repairs (
 ledger_account_id uuid PRIMARY KEY REFERENCES avis_core_v2.ledger_accounts(account_id),
 previous_identifier varchar(25) NOT NULL UNIQUE REFERENCES avis_core_v2.abiq_ledger_identifiers(abiq_iban),
 replacement_identifier text NOT NULL UNIQUE REFERENCES avis_core_v2.abiq_generated_numbers(identifier),
 owner_type text NOT NULL CHECK(owner_type IN ('COMMON_POOL','SUSPENSE_INBOUND','SUSPENSE_OUTBOUND','SUSPENSE_CARD_FX')),
 currency_code varchar(3) NOT NULL,
 applied_by text NOT NULL,
 applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER preserve_backoffice_abiq_number_repairs
 BEFORE UPDATE OR DELETE ON avis_core_v2.backoffice_abiq_number_repairs
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

DO $$
DECLARE account record; issued text; number_code text;
BEGIN
 FOR account IN
  SELECT a.account_id,a.owner_type,a.currency_code,a.wallet_scope,i.abiq_iban AS previous_identifier
  FROM avis_core_v2.ledger_accounts a
  JOIN avis_core_v2.abiq_currencies c USING(currency_code)
  JOIN avis_core_v2.abiq_ledger_identifiers i ON i.ledger_account_id=a.account_id
  WHERE a.owner_type IN ('COMMON_POOL','SUSPENSE_INBOUND','SUSPENSE_OUTBOUND','SUSPENSE_CARD_FX')
   AND a.network IS NULL
   AND i.abiq_iban ~ '^TN[0-9]{2}AVIP[0-9]{17}$'
   AND NOT EXISTS(
    SELECT FROM avis_core_v2.abiq_number_bindings b
    WHERE b.ledger_account_id=a.account_id AND b.primary_for_ledger
   )
  ORDER BY a.account_id
  FOR UPDATE OF a
 LOOP
  -- Backoffice accounts must never be converted into customer payment bridges.
  IF EXISTS(SELECT FROM avis_core_v2.abiq_routing_bridge WHERE ledger_account_id=account.account_id) THEN
   RAISE EXCEPTION 'BACKOFFICE_ABIQ_ROUTE_CONFLICT: %',account.account_id;
  END IF;
  number_code:=CASE WHEN account.wallet_scope='CUSTODY' THEN '579' ELSE account.currency_code END;
  issued:=avis_core_v2.issue_abiq_number('TN','AVIP',number_code,NULL,'system:backoffice-abiq-repair');
  INSERT INTO avis_core_v2.abiq_number_bindings(identifier,currency_code,ledger_account_id,primary_for_ledger)
   VALUES(issued,number_code,account.account_id,true);
  INSERT INTO avis_core_v2.backoffice_abiq_number_repairs
   (ledger_account_id,previous_identifier,replacement_identifier,owner_type,currency_code,applied_by)
   VALUES(account.account_id,account.previous_identifier,issued,account.owner_type,account.currency_code,
    'system:backoffice-abiq-repair');
 END LOOP;
END $$;

-- A successful migration must leave no eligible Common/Suspense bank account with
-- a legacy serial as its displayed primary number.
DO $$
BEGIN
 IF EXISTS(
  SELECT FROM avis_core_v2.ledger_accounts a
  JOIN avis_core_v2.abiq_currencies c USING(currency_code)
  JOIN avis_core_v2.abiq_account_identifiers i ON i.ledger_account_id=a.account_id
  WHERE a.owner_type IN ('COMMON_POOL','SUSPENSE_INBOUND','SUSPENSE_OUTBOUND','SUSPENSE_CARD_FX')
   AND a.network IS NULL AND (i.abiq_iban !~ '^TN[0-9]{2}AVIP000[0-9]{15}$'
    OR i.identifier_source<>'LEDGER_REGISTRY')
 ) THEN RAISE EXCEPTION 'BACKOFFICE_ABIQ_MIGRATION_INCOMPLETE'; END IF;
END $$;
