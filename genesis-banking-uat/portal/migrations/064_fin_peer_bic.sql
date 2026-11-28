-- The FinTerminal's peer register without a NOSTRO (src/fin-peer.mjs, register). The bank owner: "Remove from the Peer register the
-- NOSTRO account as the nostro account is the job of the incoming transfer registration", and "attention could be received many
-- other currencies": a peer server is its bank, by its BIC, its address and its login. The NOSTRO a transfer settles through is
-- chosen with the transfer in the composer, or named by the peer's own message (its settlement account). Peers registered before
-- keep the NOSTRO they were registered with.
ALTER TABLE avis_core_v2.bank_connector_profiles ALTER COLUMN cash_account_id DROP NOT NULL;
