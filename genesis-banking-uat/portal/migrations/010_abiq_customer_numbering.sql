-- AVIP numbering: country/check/node + six-digit ISO block + series(5)/customer(7).
-- Currency series are permanent, independent of account-opening order.
ALTER TABLE avis_core_v2.abiq_currencies ADD COLUMN account_series integer UNIQUE
 CHECK (account_series BETWEEN 1 AND 99999);
UPDATE avis_core_v2.abiq_currencies c SET account_series=v.series FROM (VALUES
 ('EUR',1),('USD',2),('GBP',3),('CHF',4),('SEK',5),('NOK',6),('DKK',7),
 ('PLN',8),('CZK',9),('HUF',10),('RON',11),('AED',12),('SGD',13),('JPY',14)
) v(currency,series) WHERE c.currency_code=v.currency;
ALTER TABLE avis_core_v2.abiq_currencies ALTER COLUMN account_series SET NOT NULL;
ALTER TABLE avis_core_v2.abiq_currencies ADD UNIQUE(currency_code,account_series);

CREATE SEQUENCE avis_core_v2.abiq_customer_numbers_seq MINVALUE 1000101 MAXVALUE 9999999 NO CYCLE;
CREATE TABLE avis_core_v2.abiq_customer_numbers (
 user_id bigint PRIMARY KEY REFERENCES avis_core_v2.sovereign_users,
 customer_number integer NOT NULL UNIQUE DEFAULT nextval('avis_core_v2.abiq_customer_numbers_seq')
  CHECK (customer_number BETWEEN 1000101 AND 9999999),
 UNIQUE(user_id,customer_number)
);
INSERT INTO avis_core_v2.abiq_customer_numbers(user_id)
 SELECT DISTINCT user_id FROM avis_core_v2.abiq_routing_bridge
 WHERE participant_code='AVIP' ORDER BY user_id;

CREATE FUNCTION avis_core_v2.customer_abiq_identifier(country text,node text,iso_numeric text,series integer,customer_number integer)
RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE bban text;
BEGIN
 IF country !~ '^[A-Z]{2}$' OR node !~ '^[A-Z]{4}$' OR iso_numeric !~ '^[0-9]{3}$'
  OR series NOT BETWEEN 1 AND 99999 OR customer_number NOT BETWEEN 1000101 AND 9999999 THEN
  RAISE EXCEPTION 'ABIQ_INVALID_IDENTIFIER_COMPONENT';
 END IF;
 bban := node || '000' || iso_numeric || lpad(series::text,5,'0') || customer_number::text;
 RETURN country || lpad((98-avis_core_v2.abiq_mod97(bban || country || '00'))::text,2,'0') || bban;
END $$;

ALTER TABLE avis_core_v2.abiq_routing_bridge ADD COLUMN customer_number integer;
ALTER TABLE avis_core_v2.abiq_routing_bridge ADD COLUMN account_series integer;
ALTER TABLE avis_core_v2.abiq_routing_bridge ADD FOREIGN KEY(user_id,customer_number)
 REFERENCES avis_core_v2.abiq_customer_numbers(user_id,customer_number);
ALTER TABLE avis_core_v2.abiq_routing_bridge ADD FOREIGN KEY(currency_code,account_series)
 REFERENCES avis_core_v2.abiq_currencies(currency_code,account_series);
CREATE TABLE avis_core_v2.abiq_identifier_aliases (
 identifier varchar(25) PRIMARY KEY CHECK (identifier ~ '^TN[0-9]{2}AVIP[0-9]{17}$'
  AND avis_core_v2.abiq_mod97(substr(identifier,5) || left(identifier,4))=1),
 bridge_id uuid NOT NULL REFERENCES avis_core_v2.abiq_routing_bridge,
 created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO avis_core_v2.abiq_identifier_aliases(identifier,bridge_id)
 SELECT abiq_iban,bridge_id FROM avis_core_v2.abiq_routing_bridge WHERE account_number IS NOT NULL;

ALTER TABLE avis_core_v2.abiq_routing_bridge DROP CONSTRAINT abiq_identifier_format;
UPDATE avis_core_v2.abiq_routing_bridge b SET customer_number=n.customer_number,account_series=c.account_series,
 abiq_iban=avis_core_v2.customer_abiq_identifier('TN',b.participant_code,right(b.iso_numeric_partition,3),c.account_series,n.customer_number)
 FROM avis_core_v2.abiq_customer_numbers n,avis_core_v2.abiq_currencies c
 WHERE b.account_number IS NOT NULL AND b.user_id=n.user_id AND b.currency_code=c.currency_code;
ALTER TABLE avis_core_v2.abiq_routing_bridge ADD CONSTRAINT abiq_identifier_format CHECK (
 (account_number IS NULL AND customer_number IS NULL AND account_series IS NULL
  AND abiq_iban=avis_core_v2.abiq_identifier(participant_code,iso_numeric_partition,user_id))
 OR (account_number IS NOT NULL AND participant_code='AVIP' AND customer_number IS NOT NULL AND account_series IS NOT NULL
  AND abiq_iban=avis_core_v2.customer_abiq_identifier('TN',participant_code,right(iso_numeric_partition,3),account_series,customer_number))
);
-- Only replace a primary reference if it was exactly the previous issued identifier.
-- Arbitrary existing corporate/customer references remain untouched.
UPDATE avis_core_v2.sovereign_users u SET avis_account_no=b.abiq_iban
 FROM avis_core_v2.abiq_identifier_aliases a JOIN avis_core_v2.abiq_routing_bridge b USING(bridge_id)
 WHERE u.user_id=b.user_id AND u.avis_account_no=a.identifier;
INSERT INTO avis_core_v2.operation_audit(actor_id,operation,resource_id)
 SELECT 'migration:010','ABIQ_NUMBERING',bridge_id::text FROM avis_core_v2.abiq_identifier_aliases;

CREATE VIEW avis_core_v2.abiq_identifier_routes AS
 SELECT abiq_iban AS identifier,bridge_id FROM avis_core_v2.abiq_routing_bridge
 UNION ALL SELECT identifier,bridge_id FROM avis_core_v2.abiq_identifier_aliases;

CREATE OR REPLACE FUNCTION avis_core_v2.provision_abiq_accounts(customer_id bigint,node text,requested_currencies text[],request_key text)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE currencies text[]; previous avis_core_v2.abiq_provision_requests%ROWTYPE;
 issuer avis_core_v2.abiq_issuers%ROWTYPE; route avis_core_v2.abiq_routing_bridge%ROWTYPE;
 curr text; part text; ledger_id uuid; serial bigint; customer_ref integer; currency_series integer; result jsonb := '[]'::jsonb;
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
 SELECT customer_number INTO customer_ref FROM avis_core_v2.abiq_customer_numbers WHERE user_id=customer_id;
 IF NOT FOUND THEN
  INSERT INTO avis_core_v2.abiq_customer_numbers(user_id) VALUES(customer_id) RETURNING customer_number INTO customer_ref;
 END IF;
 FOREACH curr IN ARRAY currencies LOOP
  SELECT * INTO route FROM avis_core_v2.abiq_routing_bridge WHERE user_id=customer_id AND participant_code=node AND currency_code=curr;
  IF FOUND AND route.status<>'ACTIVE' THEN RAISE EXCEPTION 'ABIQ_ACCOUNT_NOT_ACTIVE'; END IF;
  IF NOT FOUND THEN
   SELECT iso_numeric_partition,account_series INTO part,currency_series FROM avis_core_v2.abiq_currencies WHERE currency_code=curr;
   serial := nextval('avis_core_v2.abiq_account_numbers');
   INSERT INTO avis_core_v2.ledger_accounts(owner_type,user_id,sub_account_code,currency_code,wallet_scope,account_category)
    VALUES('USER',customer_id,'ABIQ:' || node,curr,'FUNDING','LIABILITY') ON CONFLICT DO NOTHING;
   SELECT account_id INTO STRICT ledger_id FROM avis_core_v2.ledger_accounts
    WHERE owner_type='USER' AND user_id=customer_id AND sub_account_code='ABIQ:' || node AND currency_code=curr AND abiq_eligible;
   INSERT INTO avis_core_v2.abiq_routing_bridge(user_id,participant_code,currency_code,iso_numeric_partition,ledger_account_id,abiq_iban,account_number,customer_number,account_series)
    VALUES(customer_id,node,curr,part,ledger_id,avis_core_v2.customer_abiq_identifier(issuer.country_code,node,right(part,3),currency_series,customer_ref),serial,customer_ref,currency_series) RETURNING * INTO route;
  END IF;
  INSERT INTO avis_core_v2.ledger_accounts(owner_type,user_id,sub_account_code,currency_code,wallet_scope,account_category)
   SELECT 'USER',customer_id,'ABIQ:' || node,curr,scope,'LIABILITY' FROM unnest(ARRAY['MARGIN','CUSTODY']) scope ON CONFLICT DO NOTHING;
  result := result || jsonb_build_array(jsonb_build_object('bridgeId',route.bridge_id,'accountId',route.ledger_account_id,
   'abiqIban',route.abiq_iban,'abiqCode',issuer.abiq_code,'accountNumber',lpad(route.account_series::text,5,'0') || route.customer_number::text,'customerNumber',route.customer_number::text,'accountSeries',lpad(route.account_series::text,5,'0'),'currency',route.currency_code));
 END LOOP;
 INSERT INTO avis_core_v2.abiq_provision_requests(user_id,participant_code,idempotency_key,currencies,response)
 VALUES(customer_id,node,request_key,currencies,result);
 RETURN result;
END $$;
