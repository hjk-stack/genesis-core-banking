-- Link an existing immutable Treasury opening to its Portfolio representation.
-- Metadata only: no positions, balances, keys, journals or securities are seeded.
ALTER TABLE avis_core_v2.portfolio_positions
 ADD COLUMN treasury_booking_id uuid UNIQUE
 REFERENCES avis_core_v2.treasury_opening_positions(booking_id);
