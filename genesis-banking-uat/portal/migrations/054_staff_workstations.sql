ALTER TABLE avis_core_v2.operator_sessions
  ADD COLUMN IF NOT EXISTS workstation_sha256 text,
  ADD COLUMN IF NOT EXISTS workstation_approval uuid;
