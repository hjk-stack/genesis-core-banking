CREATE TABLE avis_core_v2.trading_robot_instructions (
 robot_id uuid NOT NULL REFERENCES avis_core_v2.trading_robots,
 version bigint NOT NULL CHECK(version > 0),
 policy_hash varchar(64) NOT NULL,
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 created_by varchar(180) NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(robot_id,version)
);
CREATE TRIGGER trading_robot_instructions_immutable
 BEFORE UPDATE OR DELETE ON avis_core_v2.trading_robot_instructions
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.immutable_record();
