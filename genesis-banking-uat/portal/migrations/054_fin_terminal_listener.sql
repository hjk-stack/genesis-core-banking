-- FinTerminal step 5 (src/fin-listener.mjs): the connector's listening port, open for a chosen time to the IP addresses whitelisted
-- for each peer bank; while it is open the terminal does not connect out. A peer's own session message, read and answered by the
-- bank, is kept as RECEIVED.
CREATE TABLE avis_core_v2.fin_terminal_peer_addresses (
 profile_id varchar(35) NOT NULL REFERENCES avis_core_v2.bank_connector_profiles,
 address inet NOT NULL CHECK (masklen(address)=CASE WHEN family(address)=4 THEN 32 ELSE 128 END),
 created_by text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (profile_id,address)
);
CREATE TABLE avis_core_v2.fin_terminal_listener (
 listener_id smallint PRIMARY KEY CHECK (listener_id=1),
 open_until timestamptz,
 changed_by text NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE avis_core_v2.fin_terminal_peer_messages DROP CONSTRAINT fin_terminal_peer_messages_status_check;
ALTER TABLE avis_core_v2.fin_terminal_peer_messages ADD CONSTRAINT fin_terminal_peer_messages_status_check
 CHECK (status IN ('SENDING','DELIVERED','FAILED','ACK','NAK','UNREAD','RECEIVED'));
