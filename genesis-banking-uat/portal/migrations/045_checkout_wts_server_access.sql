-- Permit a bank-provided WTS server access identifier instead of an IP address
-- for checkout registration. Registration alone does not establish a banking session.
ALTER TABLE avis_core_v2.checkout_ip_requests
  ALTER COLUMN sender_ip DROP NOT NULL,
  ADD COLUMN connection_method varchar(8) NOT NULL DEFAULT 'IP',
  ADD COLUMN wts_server_id varchar(128),
  ADD COLUMN wts_terminal_id varchar(160);
ALTER TABLE avis_core_v2.checkout_ip_requests
  ADD CONSTRAINT checkout_ip_connection_route CHECK(
    (connection_method='IP' AND sender_ip IS NOT NULL AND wts_server_id IS NULL AND wts_terminal_id IS NULL)
    OR (connection_method='WTS' AND sender_ip IS NULL AND wts_server_id IS NOT NULL)
  );
COMMENT ON COLUMN avis_core_v2.checkout_ip_requests.wts_server_id IS
  'Bank-supplied WTS identifier, not an authenticated network endpoint or authorization credential';
