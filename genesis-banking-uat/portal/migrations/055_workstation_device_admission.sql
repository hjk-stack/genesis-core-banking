-- Signed application-access handoffs. No account, balance, or gateway changes.
-- Certificate-backed sessions retain their existing columns and policy.
CREATE TABLE avis_core_v2.workstation_device_handoffs (
 state_hash char(64) PRIMARY KEY,
 code_challenge varchar(43) NOT NULL,
 code_hash char(64),
 admission_grant jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 CHECK (admission_grant IS NULL OR jsonb_typeof(admission_grant)='object'),
 CHECK ((code_hash IS NULL)=(admission_grant IS NULL))
);
CREATE INDEX workstation_device_handoff_expiry
 ON avis_core_v2.workstation_device_handoffs(expires_at);

CREATE TABLE avis_core_v2.workstation_device_admissions (
 admission_id uuid PRIMARY KEY,
 token_hash char(64) UNIQUE NOT NULL,
 admission_grant jsonb NOT NULL CHECK (jsonb_typeof(admission_grant)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL
);
CREATE INDEX workstation_device_admission_expiry
 ON avis_core_v2.workstation_device_admissions(expires_at);

ALTER TABLE avis_core_v2.operator_sessions
 ADD COLUMN workstation_admission_id uuid
 REFERENCES avis_core_v2.workstation_device_admissions(admission_id);
