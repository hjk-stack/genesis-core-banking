-- Preserve all existing IP request records and their fingerprints.
-- Bank-provided network/port notation belongs to the registration record;
-- the authenticated payment connector validates its actual transport settings.
ALTER TABLE avis_core_v2.checkout_ip_requests
  ALTER COLUMN sender_ip TYPE varchar(256) USING sender_ip::text,
  ALTER COLUMN sender_ip DROP NOT NULL,
  ADD COLUMN connection_method varchar(8) NOT NULL DEFAULT 'IP',
  ADD COLUMN wts_server_id varchar(128),
  ADD COLUMN wts_terminal_id varchar(160),
  ADD COLUMN reported_ports varchar(256);
ALTER TABLE avis_core_v2.checkout_ip_requests
  ADD CONSTRAINT checkout_ip_connection_route CHECK (
   (connection_method='IP' AND NULLIF(trim(sender_ip),'') IS NOT NULL AND wts_server_id IS NULL)
   OR (connection_method='WTS' AND NULLIF(trim(wts_server_id),'') IS NOT NULL)
  );
COMMENT ON COLUMN avis_core_v2.checkout_ip_requests.sender_ip IS
 'Raw bank-reported IP/network notation; not an authenticated network ACL';
COMMENT ON COLUMN avis_core_v2.checkout_ip_requests.wts_server_id IS
 'Bank-reported WTS identifier, not a secret credential or validated session endpoint';
