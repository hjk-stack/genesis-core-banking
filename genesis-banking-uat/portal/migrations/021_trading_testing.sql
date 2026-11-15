CREATE TABLE avis_core_v2.trading_test_runs (
 run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 robot_id uuid REFERENCES avis_core_v2.trading_robots,
 profile_name varchar(100) NOT NULL,
 mode varchar(10) NOT NULL CHECK(mode IN ('ACCEPTANCE','REPLAY')),
 configuration jsonb NOT NULL,
 configuration_hash varchar(64) NOT NULL,
 engine_fingerprint varchar(64) NOT NULL,
 dataset_hash varchar(64) NOT NULL,
 input jsonb NOT NULL,
 status varchar(8) NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','PASSED','FAILED')),
 report jsonb,
 error_code varchar(64),
 runner_token uuid,
 lease_expires_at timestamptz,
 created_by varchar(180) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 completed_at timestamptz
);
CREATE UNIQUE INDEX trading_test_one_running ON avis_core_v2.trading_test_runs((true)) WHERE status='RUNNING';
CREATE INDEX trading_test_queue ON avis_core_v2.trading_test_runs(created_at) WHERE status='QUEUED';
CREATE INDEX trading_test_history ON avis_core_v2.trading_test_runs(created_at DESC);

CREATE FUNCTION avis_core_v2.guard_trading_test_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'TRADING_TEST_HISTORY_IMMUTABLE' USING ERRCODE='55000'; END IF;
 IF (to_jsonb(NEW)-ARRAY['status','report','error_code','runner_token','lease_expires_at','started_at','completed_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','report','error_code','runner_token','lease_expires_at','started_at','completed_at'])
    OR OLD.status IN ('PASSED','FAILED')
    OR NOT ((OLD.status='QUEUED' AND NEW.status IN ('RUNNING','FAILED'))
         OR (OLD.status='RUNNING' AND NEW.status IN ('PASSED','FAILED'))) THEN
  RAISE EXCEPTION 'TRADING_TEST_HISTORY_IMMUTABLE' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER trading_test_run_history BEFORE UPDATE OR DELETE ON avis_core_v2.trading_test_runs
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.guard_trading_test_run();

CREATE TABLE avis_core_v2.trading_test_reviews (
 run_id uuid PRIMARY KEY REFERENCES avis_core_v2.trading_test_runs,
 robot_id uuid NOT NULL REFERENCES avis_core_v2.trading_robots,
 configuration_hash varchar(64) NOT NULL,
 engine_fingerprint varchar(64) NOT NULL,
 report_hash varchar(64) NOT NULL,
 reviewed_by varchar(180) NOT NULL,
 reviewed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trading_test_current_review ON avis_core_v2.trading_test_reviews(robot_id,configuration_hash,engine_fingerprint);
CREATE TRIGGER trading_test_reviews_immutable BEFORE UPDATE OR DELETE ON avis_core_v2.trading_test_reviews
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();

-- Existing entry flags predate test review. Pause new entries once so a future
-- review cannot silently resume an old flag. Positions, stops and orders remain.
UPDATE avis_core_v2.trading_robots SET enabled=false,version=version+1 WHERE enabled;
