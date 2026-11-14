-- ABIQ v8.1 account foundation on the existing database. No external IBAN minting.
CREATE TABLE avis_core_v2.abiq_currencies (
 currency_code VARCHAR(3) PRIMARY KEY,
 iso_numeric_partition VARCHAR(4) UNIQUE NOT NULL CHECK (iso_numeric_partition ~ '^0[0-9]{3}$'),
 UNIQUE(currency_code, iso_numeric_partition)
);
INSERT INTO avis_core_v2.abiq_currencies VALUES
 ('EUR','0978'),('GBP','0826'),('CHF','0756'),('SEK','0752'),('NOK','0578'),
 ('DKK','0208'),('PLN','0985'),('CZK','0203'),('HUF','0348'),('RON','0946'),
 ('USD','0840'),('AED','0784'),('SGD','0702'),('JPY','0392');

CREATE FUNCTION avis_core_v2.abiq_mod97(value TEXT) RETURNS INTEGER
LANGUAGE plpgsql IMMUTABLE STRICT AS $fn$
DECLARE remainder INTEGER := 0; ch TEXT; code INTEGER;
BEGIN
 IF value !~ '^[A-Z0-9]+$' THEN RAISE EXCEPTION 'ABIQ_INVALID_CHARACTERS'; END IF;
 FOR i IN 1..length(value) LOOP
  ch := substr(value,i,1); code := ascii(ch);
  IF code BETWEEN 48 AND 57 THEN remainder := (remainder * 10 + code - 48) % 97;
  ELSE remainder := (remainder * 100 + code - 55) % 97; END IF;
 END LOOP;
 RETURN remainder;
END $fn$;

CREATE FUNCTION avis_core_v2.abiq_identifier(node TEXT, partition_code TEXT, customer_id BIGINT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE STRICT AS $fn$
DECLARE bban TEXT;
BEGIN
 IF node !~ '^[A-Z0-9]{4}$' OR partition_code !~ '^0[0-9]{3}$'
    OR customer_id NOT BETWEEN 1 AND 99999999999999 THEN
  RAISE EXCEPTION 'ABIQ_INVALID_IDENTIFIER_COMPONENT';
 END IF;
 bban := node || partition_code || lpad(customer_id::text,14,'0');
 RETURN 'AQ' || lpad((98 - avis_core_v2.abiq_mod97(bban || 'AQ00'))::text,2,'0') || bban;
END $fn$;

CREATE TABLE avis_core_v2.abiq_network_participants (
 participant_code VARCHAR(4) PRIMARY KEY CHECK (participant_code ~ '^[A-Z0-9]{4}$'),
 institution_name VARCHAR(150) NOT NULL CHECK (length(trim(institution_name)) > 0),
 abiq_bic VARCHAR(11) UNIQUE NOT NULL CHECK (abiq_bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
 is_active BOOLEAN NOT NULL DEFAULT FALSE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE avis_core_v2.ledger_accounts ADD COLUMN abiq_eligible BOOLEAN
 GENERATED ALWAYS AS (owner_type = 'USER' AND wallet_scope = 'FUNDING'
 AND account_category = 'LIABILITY' AND network IS NULL) STORED;
ALTER TABLE avis_core_v2.ledger_accounts ADD CONSTRAINT abiq_ledger_identity
 UNIQUE(account_id,user_id,currency_code,abiq_eligible);

CREATE TABLE avis_core_v2.abiq_routing_bridge (
 bridge_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 user_id BIGINT NOT NULL REFERENCES avis_core_v2.sovereign_users,
 participant_code VARCHAR(4) NOT NULL REFERENCES avis_core_v2.abiq_network_participants,
 currency_code VARCHAR(3) NOT NULL,
 iso_numeric_partition VARCHAR(4) NOT NULL,
 ledger_account_id UUID UNIQUE NOT NULL,
 abiq_eligible BOOLEAN NOT NULL DEFAULT TRUE CHECK (abiq_eligible),
 abiq_iban VARCHAR(26) UNIQUE NOT NULL,
 status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','CLOSED')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(user_id,participant_code,currency_code),
 UNIQUE(bridge_id,currency_code),
 FOREIGN KEY(currency_code,iso_numeric_partition) REFERENCES avis_core_v2.abiq_currencies(currency_code,iso_numeric_partition),
 FOREIGN KEY(ledger_account_id,user_id,currency_code,abiq_eligible)
  REFERENCES avis_core_v2.ledger_accounts(account_id,user_id,currency_code,abiq_eligible),
 CHECK (abiq_iban = avis_core_v2.abiq_identifier(participant_code,iso_numeric_partition,user_id))
);

CREATE TABLE avis_core_v2.abiq_provision_requests (
 user_id BIGINT NOT NULL REFERENCES avis_core_v2.sovereign_users,
 participant_code VARCHAR(4) NOT NULL REFERENCES avis_core_v2.abiq_network_participants,
 idempotency_key VARCHAR(128) NOT NULL CHECK (length(trim(idempotency_key)) > 0),
 currencies TEXT[] NOT NULL,
 response JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,participant_code,idempotency_key)
);

-- Records returned by a configured bank connector; not generated from a bank prefix.
-- Local-account routing covers currencies/countries without a national IBAN format.
CREATE TABLE avis_core_v2.abiq_bank_routes (
 bridge_id UUID PRIMARY KEY,
 currency_code VARCHAR(3) NOT NULL,
 connector_code VARCHAR(35) NOT NULL REFERENCES avis_core_v2.platform_connectors,
 provider_account_id VARCHAR(128) NOT NULL CHECK (length(trim(provider_account_id)) > 0),
 account_type VARCHAR(8) NOT NULL CHECK (account_type IN ('IBAN','LOCAL')),
 account_number VARCHAR(128) NOT NULL CHECK (length(trim(account_number)) > 0),
 country_code VARCHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
 bank_bic VARCHAR(11) CHECK (bank_bic ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
 local_routing_code VARCHAR(35),
 provider_reference VARCHAR(128) NOT NULL CHECK (length(trim(provider_reference)) > 0),
 linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(bridge_id,currency_code) REFERENCES avis_core_v2.abiq_routing_bridge(bridge_id,currency_code),
 UNIQUE(connector_code,provider_account_id),
 UNIQUE(country_code,account_type,account_number),
 CHECK (account_type <> 'IBAN' OR (country_code <> 'AQ' AND
   account_number ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$' AND
   left(account_number,2) = country_code AND
   avis_core_v2.abiq_mod97(substr(account_number,5) || left(account_number,4)) = 1)),
 CHECK (account_type <> 'LOCAL' OR (local_routing_code IS NOT NULL AND length(trim(local_routing_code)) > 0))
);

CREATE FUNCTION avis_core_v2.provision_abiq_accounts(
 customer_id BIGINT, node TEXT, requested_currencies TEXT[], request_key TEXT
) RETURNS JSONB LANGUAGE plpgsql AS $fn$
DECLARE currencies TEXT[]; previous avis_core_v2.abiq_provision_requests%ROWTYPE;
 curr TEXT; part TEXT; ledger_id UUID; route avis_core_v2.abiq_routing_bridge%ROWTYPE;
 result JSONB := '[]'::jsonb; account_identifier TEXT;
BEGIN
 IF customer_id IS NULL OR customer_id NOT BETWEEN 1 AND 99999999999999
    OR node IS NULL OR node !~ '^[A-Z0-9]{4}$'
    OR request_key IS NULL OR length(trim(request_key)) NOT BETWEEN 1 AND 128
    OR requested_currencies IS NULL OR cardinality(requested_currencies) NOT BETWEEN 1 AND 14
    OR array_position(requested_currencies,NULL) IS NOT NULL THEN
  RAISE EXCEPTION 'ABIQ_INVALID_PROVISION_REQUEST';
 END IF;
 SELECT array_agg(DISTINCT c ORDER BY c) INTO currencies FROM unnest(requested_currencies) c;
 IF EXISTS (SELECT 1 FROM unnest(currencies) c WHERE NOT EXISTS
   (SELECT 1 FROM avis_core_v2.abiq_currencies s WHERE s.currency_code=c)) THEN
  RAISE EXCEPTION 'ABIQ_UNSUPPORTED_CURRENCY';
 END IF;
 -- One transaction/lock for the complete suite, including retries and other keys.
 PERFORM pg_advisory_xact_lock(hashtextextended('abiq:' || customer_id || ':' || node,0));
 PERFORM 1 FROM avis_core_v2.sovereign_users WHERE user_id=customer_id FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ABIQ_CUSTOMER_NOT_FOUND'; END IF;
 PERFORM 1 FROM avis_core_v2.abiq_network_participants WHERE participant_code=node AND is_active FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'ABIQ_PARTICIPANT_NOT_ACTIVE'; END IF;
 SELECT * INTO previous FROM avis_core_v2.abiq_provision_requests
  WHERE user_id=customer_id AND participant_code=node AND idempotency_key=request_key;
 IF FOUND THEN
  IF previous.currencies IS DISTINCT FROM currencies THEN RAISE EXCEPTION 'ABIQ_IDEMPOTENCY_CONFLICT'; END IF;
  RETURN previous.response;
 END IF;
 FOREACH curr IN ARRAY currencies LOOP
  SELECT * INTO route FROM avis_core_v2.abiq_routing_bridge
   WHERE user_id=customer_id AND participant_code=node AND currency_code=curr;
  IF NOT FOUND THEN
   SELECT iso_numeric_partition INTO part FROM avis_core_v2.abiq_currencies WHERE currency_code=curr;
   account_identifier := avis_core_v2.abiq_identifier(node,part,customer_id);
   INSERT INTO avis_core_v2.ledger_accounts(owner_type,user_id,sub_account_code,currency_code,wallet_scope,account_category)
    VALUES('USER',customer_id,'ABIQ:' || node,curr,'FUNDING','LIABILITY') ON CONFLICT DO NOTHING;
   SELECT account_id INTO STRICT ledger_id FROM avis_core_v2.ledger_accounts
    WHERE owner_type='USER' AND user_id=customer_id AND sub_account_code='ABIQ:' || node
    AND currency_code=curr AND abiq_eligible;
   INSERT INTO avis_core_v2.abiq_routing_bridge(user_id,participant_code,currency_code,iso_numeric_partition,ledger_account_id,abiq_iban)
    VALUES(customer_id,node,curr,part,ledger_id,account_identifier) RETURNING * INTO route;
  END IF;
  result := result || jsonb_build_array(jsonb_build_object('bridgeId',route.bridge_id,'accountId',route.ledger_account_id,
   'abiqIban',route.abiq_iban,'currency',route.currency_code));
 END LOOP;
 INSERT INTO avis_core_v2.abiq_provision_requests(user_id,participant_code,idempotency_key,currencies,response)
  VALUES(customer_id,node,request_key,currencies,result);
 RETURN result;
END $fn$;

-- No participants, bank accounts, balances or endpoints are seeded here.
