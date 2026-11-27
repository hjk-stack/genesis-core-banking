-- The bank owner: "remove that behaviour as we do not connect currently. All Nostro we control manually not automatically", and
-- the FinTerminal specification v3: an incoming transfer is booked at once on the NOSTRO and on the core banking account
-- ("CORE_BANKING_&_NOSTRO", ACSC). Registered from now on, it is booked so (src/fin-terminal.mjs); one registered before on the
-- bank's inbound suspense is booked so here: what the suspense expected at the NOSTRO is now on the NOSTRO, what it owed is now
-- on AVISPay PLC's chosen account. Its draft then points to the journal that booked it, as one registered from now on does; the
-- journal that registered it on the suspense stays in the ledger under its own key, 'fin-incoming:' and its UETR (review finding).
ALTER TABLE avis_core_v2.fin_terminal_drafts DISABLE TRIGGER fin_terminal_registered_kept;
DO $$
DECLARE r record; nostro uuid; expected uuid; owed uuid; booked uuid;
BEGIN
 FOR r IN SELECT d.draft_id,d.uetr,d.form,d.nostro_cash_account_id,d.booking_account_id FROM avis_core_v2.fin_terminal_drafts d
  JOIN avis_core_v2.ledger_journals j ON j.journal_id=d.registered_journal_id
  WHERE j.event_type='FIN_INCOMING_REGISTERED' ORDER BY d.registered_at,d.draft_id LOOP
  SELECT ledger_account_id INTO STRICT nostro FROM avis_core_v2.external_cash_accounts WHERE cash_account_id=r.nostro_cash_account_id;
  SELECT account_id INTO STRICT expected FROM avis_core_v2.ledger_accounts WHERE owner_type='SUSPENSE_INBOUND' AND network IS NULL
   AND wallet_scope='FUNDING' AND sub_account_code='FIN_EXPECTED:'||r.nostro_cash_account_id AND currency_code=r.form->>'currency';
  SELECT account_id INTO STRICT owed FROM avis_core_v2.ledger_accounts WHERE owner_type='SUSPENSE_INBOUND' AND network IS NULL
   AND wallet_scope='FUNDING' AND sub_account_code='FIN_INCOMING:'||r.nostro_cash_account_id AND currency_code=r.form->>'currency';
  booked:=avis_core_v2.post_journal('fin-incoming-booked:'||r.uetr,'FIN_INCOMING_BOOKED',r.form->>'businessMessageId','migration:057',
   jsonb_build_array(jsonb_build_object('accountId',nostro,'direction','DEBIT','amount',r.form->>'amount'),
    jsonb_build_object('accountId',expected,'direction','CREDIT','amount',r.form->>'amount'),
    jsonb_build_object('accountId',owed,'direction','DEBIT','amount',r.form->>'amount'),
    jsonb_build_object('accountId',r.booking_account_id,'direction','CREDIT','amount',r.form->>'amount')));
  UPDATE avis_core_v2.fin_terminal_drafts SET registered_journal_id=booked WHERE draft_id=r.draft_id;
 END LOOP;
END $$;
ALTER TABLE avis_core_v2.fin_terminal_drafts ENABLE TRIGGER fin_terminal_registered_kept;
