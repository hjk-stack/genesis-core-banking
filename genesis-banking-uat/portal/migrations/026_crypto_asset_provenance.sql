-- Historical source metadata is separate from generated signing keys and ledger balances.
CREATE TABLE avis_core_v2.crypto_asset_provenance (
 user_id bigint NOT NULL REFERENCES avis_core_v2.sovereign_users,
 asset_id text NOT NULL, network varchar(32) NOT NULL,
 contract_address varchar(256) NOT NULL,
 historical_wallet_address varchar(256) NOT NULL,
 transaction_hash varchar(128) NOT NULL,
 recorded_transfer_at timestamptz,
 source_url text NOT NULL, source_record text NOT NULL,
 PRIMARY KEY (user_id,asset_id,network),
 FOREIGN KEY (asset_id,network) REFERENCES avis_core_v2.crypto_asset_networks
);
ALTER TABLE avis_core_v2.user_deposit_addresses
 ADD COLUMN is_primary boolean NOT NULL DEFAULT true;
ALTER TABLE avis_core_v2.user_deposit_addresses
 DROP CONSTRAINT user_deposit_addresses_user_id_network_key;
CREATE UNIQUE INDEX user_deposit_primary_network
 ON avis_core_v2.user_deposit_addresses(user_id,network) WHERE is_primary;
ALTER TABLE avis_core_v2.user_deposit_addresses
 ADD CONSTRAINT deposit_address_owner_network UNIQUE(address_id,user_id,network);
CREATE TABLE avis_core_v2.crypto_asset_wallet_routes (
 user_id bigint NOT NULL, asset_id text NOT NULL, network varchar(32) NOT NULL,
 address_id bigint NOT NULL,
 PRIMARY KEY(user_id,asset_id,network),
 FOREIGN KEY(asset_id,network) REFERENCES avis_core_v2.crypto_asset_networks,
 FOREIGN KEY(address_id,user_id,network)
  REFERENCES avis_core_v2.user_deposit_addresses(address_id,user_id,network)
);
-- Only attach the owner-supplied historical records to the already-booked
-- AVISPay PLC treasury inventory. No holdings or keys are seeded on new installs.
INSERT INTO avis_core_v2.crypto_asset_provenance
 (user_id,asset_id,network,contract_address,historical_wallet_address,transaction_hash,recorded_transfer_at,source_url,source_record)
SELECT p.owner_user_id,v.asset_id,'ETHEREUM',n.contract_address,
 '0x5e30240f7a56ebc15ba28dd8e8ba94aeaa9be692',v.tx_hash,v.transfer_at::timestamptz,
 'https://etherscan.io/token/'||n.contract_address||'?a=0x5e30240f7a56ebc15ba28dd8e8ba94aeaa9be692#transactions',
 v.source_record
FROM (VALUES
 ('AG','avis-green','AVIS-GREENS-AG-REGISTERED','0x713d3a1785219aeb37e52260ff8f96660851842b','0xadd149161a4c18f2f2813409407556d7ec29cdcd029336ed735a8998468ab5bb','2023-01-23 17:48:47+02','Owner-supplied AG Ethplorer record, page 2, captured 2026-10-11'),
 ('AGi','avis-green-investment','AVIS-GREENS-AGI-REGISTERED','0x0482213c1e5a9fefdee36d9b01c044938403a9af','0x260a6faf8c950659a39b49d4c1db01ea899f1e546e26a8210b6925962a0e6902','2023-01-23 17:48:11+02','Owner-supplied AGi Ethplorer record, page 2, captured 2026-10-11')
) AS v(code,asset_id,source_reference,contract_address,tx_hash,transfer_at,source_record)
JOIN avis_core_v2.treasury_opening_positions p ON p.asset_code=v.code
 AND p.source_reference=v.source_reference AND p.asset_class='CRYPTO'
JOIN avis_core_v2.sovereign_users u ON u.user_id=p.owner_user_id
 AND u.full_name='AVISPay PLC' AND u.account_role='INSTITUTION'
JOIN avis_core_v2.crypto_asset_networks n ON n.asset_id=v.asset_id
 AND n.network='ETHEREUM' AND lower(n.contract_address)=v.contract_address;
-- Preserve the original generated primary address, encrypted key and all references.
-- The historical receiver gets its own address record; no signing key is invented.
INSERT INTO avis_core_v2.user_deposit_addresses(user_id,network,public_address,is_primary)
SELECT DISTINCT p.user_id,p.network,p.historical_wallet_address,false
 FROM avis_core_v2.crypto_asset_provenance p
 WHERE NOT EXISTS (SELECT 1 FROM avis_core_v2.user_deposit_addresses d
  WHERE d.network=p.network AND lower(d.public_address)=lower(p.historical_wallet_address))
ON CONFLICT DO NOTHING;
INSERT INTO avis_core_v2.crypto_asset_wallet_routes(user_id,asset_id,network,address_id)
SELECT p.user_id,p.asset_id,p.network,d.address_id
 FROM avis_core_v2.crypto_asset_provenance p
 JOIN avis_core_v2.user_deposit_addresses d ON d.user_id=p.user_id AND d.network=p.network
  AND lower(d.public_address)=lower(p.historical_wallet_address);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM avis_core_v2.crypto_asset_provenance p
  LEFT JOIN avis_core_v2.crypto_asset_wallet_routes r USING(user_id,asset_id,network)
  WHERE r.address_id IS NULL) THEN
  RAISE EXCEPTION 'HISTORICAL_ASSET_ROUTE_OWNER_MISMATCH';
 END IF;
END $$;
