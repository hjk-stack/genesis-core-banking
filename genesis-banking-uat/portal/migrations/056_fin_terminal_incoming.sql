-- The FinTerminal composer's direction (src/fin-terminal.mjs). Requested by the bank owner: "We now register an incoming transfer
-- so AVISPay PLC is the receiver". An incoming transfer, once registered, keeps the journal that booked it on the bank's inbound
-- suspense until the NOSTRO statement confirms it, and is not changed any more.
ALTER TABLE avis_core_v2.fin_terminal_drafts
 ADD COLUMN direction text NOT NULL DEFAULT 'OUTGOING' CHECK (direction IN ('OUTGOING','INCOMING')),
 ADD COLUMN registered_journal_id uuid UNIQUE REFERENCES avis_core_v2.ledger_journals(journal_id),
 ADD COLUMN registered_at timestamptz,
 ADD COLUMN registered_by text,
 ADD CONSTRAINT fin_terminal_registered_incoming CHECK (registered_journal_id IS NULL OR (direction='INCOMING' AND schema_valid
  AND registered_at IS NOT NULL AND registered_by IS NOT NULL AND booking_account_id IS NOT NULL AND nostro_cash_account_id IS NOT NULL));
CREATE FUNCTION avis_core_v2.fin_terminal_registered_kept() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.registered_journal_id IS NOT NULL THEN RAISE EXCEPTION 'FIN_DRAFT_REGISTERED'; END IF;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER fin_terminal_registered_kept BEFORE UPDATE OR DELETE ON avis_core_v2.fin_terminal_drafts
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.fin_terminal_registered_kept();
