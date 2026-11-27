-- The FinTerminal's session messages with peer banks' servers (src/fin-peer.mjs): what the bank sent to a peer through its IP-to-IP
-- bank connector - an ISO 20022 system event notification under its business application header - and the peer's answer as it
-- came, or why none came. Nothing is entered here that a peer did not send.
CREATE TABLE avis_core_v2.fin_terminal_peer_messages (
 message_id uuid PRIMARY KEY,
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 profile_id varchar(35) NOT NULL REFERENCES avis_core_v2.bank_connector_profiles,
 direction text NOT NULL CHECK (direction IN ('OUT','IN')),
 answer_to uuid UNIQUE REFERENCES avis_core_v2.fin_terminal_peer_messages,
 message_type text,
 business_message_id varchar(35),
 event_code varchar(35),
 event_parameters text[] NOT NULL DEFAULT '{}',
 event_text text,
 status text NOT NULL CHECK (status IN ('SENDING','DELIVERED','FAILED','ACK','NAK','UNREAD')),
 error_code varchar(64),
 content text CHECK (octet_length(content)<=65535),
 created_by text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((direction='OUT')=(status IN ('SENDING','DELIVERED','FAILED')))
);
CREATE INDEX fin_terminal_peer_stream ON avis_core_v2.fin_terminal_peer_messages(profile_id,sequence DESC);
