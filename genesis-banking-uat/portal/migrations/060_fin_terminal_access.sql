-- The FinTerminal's 4-Eyes checker (specification v3, FinTerminal_Unified_NOSTRO_Crypto_System_v3; src/fin-access.mjs). The bank
-- owner: "4 Eyes is 2 pins ... the pin creation must be directly on the GUI for both PINs" - each PIN kept only scrypt-hashed,
-- with the name of the administrator holding it - and of its switch, "Not now for the test period": it starts off, and only the
-- owner switches it.
ALTER TABLE avis_core_v2.fin_terminal_mode
 ADD COLUMN four_eyes boolean NOT NULL DEFAULT false,
 ADD COLUMN four_eyes_changed_by text CHECK (char_length(four_eyes_changed_by) BETWEEN 1 AND 80),
 ADD COLUMN four_eyes_changed_at timestamptz;
CREATE TABLE avis_core_v2.fin_terminal_pins (
 slot smallint PRIMARY KEY CHECK (slot IN (1,2)),
 holder_principal text NOT NULL CHECK (char_length(holder_principal) BETWEEN 1 AND 300),
 holder_name text NOT NULL CHECK (char_length(holder_name) BETWEEN 1 AND 80),
 pin_hash text NOT NULL CHECK (pin_hash ~ '^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$'),
 failed_attempts integer NOT NULL DEFAULT 0 CHECK (failed_attempts BETWEEN 0 AND 5),
 locked_until timestamptz,
 set_at timestamptz NOT NULL DEFAULT now()
);
