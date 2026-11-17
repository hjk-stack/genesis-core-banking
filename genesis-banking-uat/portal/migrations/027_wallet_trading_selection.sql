-- A selection does not allocate or release money. It references the original
-- wallet account and its existing, authenticated trading consent records.
CREATE TABLE avis_core_v2.wallet_trading_selections (
 account_id uuid PRIMARY KEY REFERENCES avis_core_v2.ledger_accounts(account_id),
 enabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION avis_core_v2.reset_released_wallet_selection() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state <> 'ACTIVE' AND OLD.state = 'ACTIVE' THEN
  UPDATE avis_core_v2.wallet_trading_selections s
   SET enabled=false,version=version+1,updated_at=now(),updated_by='allowance-release'
   WHERE s.account_id=NEW.account_id AND s.enabled
    AND NOT EXISTS (SELECT 1 FROM avis_core_v2.wallet_trading_delegations d
                    WHERE d.account_id=NEW.account_id AND d.state='ACTIVE');
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER reset_released_wallet_selection
 AFTER UPDATE OF state ON avis_core_v2.wallet_trading_delegations
 FOR EACH ROW EXECUTE FUNCTION avis_core_v2.reset_released_wallet_selection();
