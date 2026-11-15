CREATE TABLE avis_core_v2.index_analysis_policies (
 version integer PRIMARY KEY CHECK(version>0),
 policy_hash varchar(64) NOT NULL,
 instructions text NOT NULL,
 created_by varchar(180) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER index_analysis_policies_immutable BEFORE UPDATE OR DELETE ON avis_core_v2.index_analysis_policies
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

CREATE TABLE avis_core_v2.index_event_batches (
 batch_id varchar(64) PRIMARY KEY,
 content_hash varchar(64) NOT NULL,
 policy_version integer NOT NULL CHECK(policy_version>=0),
 policy_hash varchar(64) NOT NULL,
 auth_method varchar(20) NOT NULL CHECK(auth_method IN ('ED25519_JWS','BEARER')),
 generated_at timestamptz NOT NULL,
 receipt jsonb NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER index_event_batches_immutable BEFORE UPDATE OR DELETE ON avis_core_v2.index_event_batches
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

CREATE TABLE avis_core_v2.index_event_candidates (
 signal_id varchar(128) PRIMARY KEY,
 event_id varchar(128) NOT NULL,
 event_version integer NOT NULL CHECK(event_version>0),
 instrument_id varchar(200),
 instrument_key varchar(64) NOT NULL,
 event_key varchar(64) UNIQUE NOT NULL,
 batch_id varchar(64) NOT NULL REFERENCES avis_core_v2.index_event_batches,
 policy_version integer NOT NULL CHECK(policy_version>=0),
 policy_hash varchar(64) NOT NULL,
 proposed_action varchar(5) NOT NULL CHECK(proposed_action IN ('BUY','SELL','SHORT','COVER','HOLD','WATCH')),
 state varchar(12) NOT NULL CHECK(state IN ('ACTIVE','SUPERSEDED','CANCELLED')),
 content_hash varchar(64) NOT NULL,
 payload jsonb NOT NULL,
 resolution jsonb NOT NULL,
 supersedes_signal_id varchar(128) REFERENCES avis_core_v2.index_event_candidates,
 analysed_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX index_event_candidates_current ON avis_core_v2.index_event_candidates(event_id,instrument_key,event_version DESC);
CREATE INDEX index_event_candidates_expiry ON avis_core_v2.index_event_candidates(expires_at) WHERE state='ACTIVE';
CREATE FUNCTION avis_core_v2.guard_index_candidate_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INDEX_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
    OR (NEW.state<>OLD.state AND NEW.state<>'SUPERSEDED') THEN
  RAISE EXCEPTION 'INDEX_HISTORY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER index_event_candidates_history BEFORE UPDATE OR DELETE ON avis_core_v2.index_event_candidates
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.guard_index_candidate_history();
ALTER TABLE avis_core_v2.trading_robots ADD COLUMN last_event_advice jsonb NOT NULL DEFAULT '[]';

CREATE TABLE avis_core_v2.index_service_nonces (
 issuer varchar(200) NOT NULL,
 nonce varchar(64) NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(issuer,nonce)
);
CREATE INDEX index_service_nonces_expiry ON avis_core_v2.index_service_nonces(expires_at);
