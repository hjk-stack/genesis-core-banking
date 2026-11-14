-- Current issuer instruction + fit.INTELECT v1 §§3,5.2,6.2.
-- Preserve historical AQ identifiers, routes, ledger IDs, balances and connectors.
CREATE TABLE avis_core_v2.abiq_issuers (
 participant_code varchar(4) PRIMARY KEY REFERENCES avis_core_v2.abiq_network_participants,
 abiq_code varchar(11) UNIQUE NOT NULL,
 country_code varchar(2) NOT NULL,
 CHECK (abiq_code ~ '^[A-Z]{6}[0-9]{2}[A-Z0-9]{3}$'),
 CHECK (left(abiq_code,4)=participant_code AND substr(abiq_code,5,2)=country_code)
);
INSERT INTO avis_core_v2.abiq_network_participants(participant_code,institution_name,abiq_bic,is_active)
 VALUES('AVIP','AVISPay PLC','AVIPTN64XXX',true);
INSERT INTO avis_core_v2.abiq_issuers VALUES('AVIP','AVIPTN64XXX','TN');
CREATE SEQUENCE avis_core_v2.abiq_account_numbers MAXVALUE 99999999999999 NO CYCLE;
CREATE FUNCTION avis_core_v2.issued_abiq_identifier(country text,node text,iso_numeric text,account_number bigint)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE bban text;
BEGIN
 IF country !~ '^[A-Z]{2}$' OR node !~ '^[A-Z]{4}$' OR iso_numeric !~ '^[0-9]{3}$'
  OR account_number NOT BETWEEN 1 AND 99999999999999 THEN
  RAISE EXCEPTION 'ABIQ_INVALID_IDENTIFIER_COMPONENT';
 END IF;
 bban := node || iso_numeric || lpad(account_number::text,14,'0');
 RETURN country || lpad((98-avis_core_v2.abiq_mod97(bban || country || '00'))::text,2,'0') || bban;
END $$;
ALTER TABLE avis_core_v2.abiq_routing_bridge ADD COLUMN account_number bigint UNIQUE
 CHECK (account_number BETWEEN 1 AND 99999999999999);
-- Replace only the historical format check, retaining every ownership/currency FK.
DO $$ DECLARE constraint_name text; BEGIN
 SELECT conname INTO STRICT constraint_name FROM pg_constraint
 WHERE conrelid='avis_core_v2.abiq_routing_bridge'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%abiq_identifier(%';
 EXECUTE format('ALTER TABLE avis_core_v2.abiq_routing_bridge DROP CONSTRAINT %I',constraint_name);
END $$;
ALTER TABLE avis_core_v2.abiq_routing_bridge ADD CONSTRAINT abiq_identifier_format CHECK (
 (account_number IS NULL AND abiq_iban=avis_core_v2.abiq_identifier(participant_code,iso_numeric_partition,user_id))
 OR (account_number IS NOT NULL AND participant_code='AVIP'
  AND abiq_iban=avis_core_v2.issued_abiq_identifier('TN',participant_code,right(iso_numeric_partition,3),account_number))
);
ALTER FUNCTION avis_core_v2.provision_abiq_accounts(bigint,text,text[],text) RENAME TO provision_legacy_abiq_accounts;
CREATE FUNCTION avis_core_v2.provision_abiq_accounts(customer_id bigint,node text,requested_currencies text[],request_key text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE currencies text[]; previous avis_core_v2.abiq_provision_requests%ROWTYPE;
 issuer avis_core_v2.abiq_issuers%ROWTYPE; route avis_core_v2.abiq_routing_bridge%ROWTYPE;
 curr text; part text; ledger_id uuid; serial bigint; result jsonb := '[]'::jsonb;
BEGIN
 IF node IS DISTINCT FROM 'AVIP' THEN
  RETURN avis_core_v2.provision_legacy_abiq_accounts(customer_id,node,requested_currencies,request_key);
 END IF;
 IF customer_id IS NULL OR customer_id NOT BETWEEN 1 AND 99999999999999
  OR request_key IS NULL OR length(trim(request_key)) NOT BETWEEN 1 AND 128
  OR requested_currencies IS NULL OR cardinality(requested_currencies) NOT BETWEEN 1 AND 14
  OR array_position(requested_currencies,NULL) IS NOT NULL THEN RAISE EXCEPTION 'ABIQ_INVALID_PROVISION_REQUEST'; END IF;
 SELECT array_agg(DISTINCT c ORDER BY c) INTO currencies FROM unnest(requested_currencies) c;
 IF EXISTS (SELECT 1 FROM unnest(currencies) c WHERE NOT EXISTS
  (SELECT 1 FROM avis_core_v2.abiq_currencies s WHERE s.currency_code=c)) THEN RAISE EXCEPTION 'ABIQ_UNSUPPORTED_CURRENCY'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('abiq:' || customer_id || ':' || node,0));
 PERFORM 1 FROM avis_core_v2.sovereign_users WHERE user_id=customer_id FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ABIQ_CUSTOMER_NOT_FOUND'; END IF;
 SELECT i.* INTO issuer FROM avis_core_v2.abiq_issuers i
 JOIN avis_core_v2.abiq_network_participants p USING(participant_code)
 WHERE i.participant_code=node AND p.is_active AND p.abiq_bic=i.abiq_code FOR SHARE OF i,p;
 IF NOT FOUND THEN RAISE EXCEPTION 'ABIQ_PARTICIPANT_NOT_ACTIVE'; END IF;
 SELECT * INTO previous FROM avis_core_v2.abiq_provision_requests
 WHERE user_id=customer_id AND participant_code=node AND idempotency_key=request_key;
 IF FOUND THEN
  IF previous.currencies IS DISTINCT FROM currencies THEN RAISE EXCEPTION 'ABIQ_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN previous.response;
 END IF;
 FOREACH curr IN ARRAY currencies LOOP
  SELECT * INTO route FROM avis_core_v2.abiq_routing_bridge WHERE user_id=customer_id AND participant_code=node AND currency_code=curr;
  IF FOUND AND route.status<>'ACTIVE' THEN RAISE EXCEPTION 'ABIQ_ACCOUNT_NOT_ACTIVE'; END IF;
  IF NOT FOUND THEN
   SELECT iso_numeric_partition INTO part FROM avis_core_v2.abiq_currencies WHERE currency_code=curr;
   serial := nextval('avis_core_v2.abiq_account_numbers');
   INSERT INTO avis_core_v2.ledger_accounts(owner_type,user_id,sub_account_code,currency_code,wallet_scope,account_category)
    VALUES('USER',customer_id,'ABIQ:' || node,curr,'FUNDING','LIABILITY') ON CONFLICT DO NOTHING;
   SELECT account_id INTO STRICT ledger_id FROM avis_core_v2.ledger_accounts
    WHERE owner_type='USER' AND user_id=customer_id AND sub_account_code='ABIQ:' || node AND currency_code=curr AND abiq_eligible;
   INSERT INTO avis_core_v2.abiq_routing_bridge(user_id,participant_code,currency_code,iso_numeric_partition,ledger_account_id,abiq_iban,account_number)
    VALUES(customer_id,node,curr,part,ledger_id,avis_core_v2.issued_abiq_identifier(issuer.country_code,node,right(part,3),serial),serial) RETURNING * INTO route;
  END IF;
  INSERT INTO avis_core_v2.ledger_accounts(owner_type,user_id,sub_account_code,currency_code,wallet_scope,account_category)
   SELECT 'USER',customer_id,'ABIQ:' || node,curr,scope,'LIABILITY' FROM unnest(ARRAY['MARGIN','CUSTODY']) scope ON CONFLICT DO NOTHING;
  result := result || jsonb_build_array(jsonb_build_object('bridgeId',route.bridge_id,'accountId',route.ledger_account_id,
   'abiqIban',route.abiq_iban,'abiqCode',issuer.abiq_code,'accountNumber',lpad(route.account_number::text,14,'0'),'currency',route.currency_code));
 END LOOP;
 INSERT INTO avis_core_v2.abiq_provision_requests(user_id,participant_code,idempotency_key,currencies,response)
 VALUES(customer_id,node,request_key,currencies,result);
 RETURN result;
END $$;
ALTER TABLE avis_core_v2.sovereign_users ADD COLUMN account_role text NOT NULL DEFAULT 'CUSTOMER'
 CHECK(account_role IN ('INSTITUTION','CUSTOMER'));
-- Explicit UAT identities. Fail atomically rather than renaming an existing owner.
DO $$ DECLARE n bigint; holder text; kind text; role_name text; accounts jsonb; BEGIN
 FOR n,holder,kind,role_name IN VALUES (1::bigint,'AVISPay PLC','BUSINESS','INSTITUTION'),(2::bigint,'Frontend user','PERSONAL','CUSTOMER') LOOP
  IF EXISTS (SELECT 1 FROM avis_core_v2.sovereign_users WHERE user_id=n AND (full_name<>holder OR account_type<>kind)) THEN
   RAISE EXCEPTION 'ABIQ_BOOTSTRAP_IDENTITY_CONFLICT: %',n;
  END IF;
  INSERT INTO avis_core_v2.sovereign_users(user_id,avis_account_no,full_name,account_type,account_role)
   VALUES(n,'AVIP-' || lpad(n::text,14,'0'),holder,kind,role_name) ON CONFLICT DO NOTHING;
  accounts := avis_core_v2.provision_abiq_accounts(n,'AVIP',ARRAY['EUR','USD','GBP'],'issuer-bootstrap-v1');
  UPDATE avis_core_v2.sovereign_users SET avis_account_no=accounts->0->>'abiqIban',account_role=role_name
   WHERE user_id=n AND avis_account_no='AVIP-' || lpad(n::text,14,'0');
  INSERT INTO avis_core_v2.user_external_connectors(user_id,connector_code)
   SELECT n,connector_code FROM avis_core_v2.platform_connectors WHERE is_enabled AND auto_provision ON CONFLICT DO NOTHING;
  INSERT INTO avis_core_v2.connector_outbox(user_id,connector_code,event_type,payload)
   SELECT n,connector_code,'CUSTOMER_CREATED',jsonb_build_object('userId',n::text)
   FROM avis_core_v2.platform_connectors WHERE is_enabled AND auto_provision ON CONFLICT DO NOTHING;
  INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id) VALUES('migration:008','ABIQ_BOOTSTRAP',n::text);
 END LOOP;
 -- Preserve any already allocated customer IDs, including gaps after rollbacks.
 PERFORM setval('avis_core_v2.sovereign_user_ids',greatest(
  (SELECT max(user_id)+1 FROM avis_core_v2.sovereign_users),
  (SELECT last_value+CASE WHEN is_called THEN 1 ELSE 0 END FROM avis_core_v2.sovereign_user_ids)),false);
END $$;
