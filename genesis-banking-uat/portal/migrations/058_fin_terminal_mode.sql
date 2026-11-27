-- The FinTerminal's mode (specification v3, FinTerminal_Unified_NOSTRO_Crypto_System_v3): ROBOTIC STP, an incoming credit taken
-- and booked by the bank at once, or MANUAL INTERVENTION, held for a bank administrator. The bank owner: "All Nostro we control
-- manually not automatically" - it starts manual.
CREATE TABLE avis_core_v2.fin_terminal_mode (
 mode_id smallint PRIMARY KEY CHECK (mode_id=1),
 robotic_stp boolean NOT NULL,
 changed_by text NOT NULL,
 changed_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO avis_core_v2.fin_terminal_mode(mode_id,robotic_stp,changed_by) VALUES(1,false,'migration:058');
