-- Screen 1's Transact (src/fin-peer.mjs, transact). The bank owner: "When the transaction is filled, then add a button for press
-- Transact for the transaction executed ... Multiple pressing are not generating duplicated a transaction". An outgoing message,
-- once transacted, keeps the journal that reserved its money for its wire (fin_terminal_wires.reserve_journal_id) and, as a
-- registered incoming transfer does, is not changed any more (fin_terminal_registered_kept).
ALTER TABLE avis_core_v2.fin_terminal_drafts
 DROP CONSTRAINT fin_terminal_registered_incoming,
 ADD CONSTRAINT fin_terminal_registered CHECK (registered_journal_id IS NULL OR (schema_valid
  AND registered_at IS NOT NULL AND registered_by IS NOT NULL AND booking_account_id IS NOT NULL AND nostro_cash_account_id IS NOT NULL));
