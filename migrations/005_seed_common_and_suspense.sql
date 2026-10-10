-- Seed disabled COMMON and suspense account registers from the approved software catalog.
-- No balances, beneficiary rights, payment mandates, transfers, or active accounts.
-- Requires 004_common_accounts_suspense.sql and PostgreSQL with gen_random_uuid().
BEGIN;
INSERT INTO banking.common_product_types(code,name) VALUES
 ('FIAT_CASH','Cash and safeguarded funds'),
 ('BANK_DEPOSITS','Deposits and bank cash claims'),
 ('BONDS_NOTES','Bonds, notes and debt securities'),
 ('EQUITIES','Shares and equity securities'),
 ('INVESTMENT_FUNDS','Fund units and investment vehicles'),
 ('MONEY_MARKET','Money market instruments'),
 ('FOREIGN_EXCHANGE','Foreign exchange claims and settlements'),
 ('CRYPTO_ASSETS','Cryptocurrency custody positions'),
 ('TOKENIZED_ASSETS','Tokenized financial assets'),
 ('STABLECOINS','Stablecoin custody positions'),
 ('DERIVATIVES','Derivatives and margin interests'),
 ('PRECIOUS_METALS','Allocated and unallocated metal interests'),
 ('COMMODITIES','Commodity warehouse interests'),
 ('PHYSICAL_ASSETS','Documented valuables and physical assets'),
 ('COLLATERAL','Pledged and security-held collateral'),
 ('TRADE_FINANCE','Trade finance instruments'),
 ('CARD_SETTLEMENT','Card and merchant settlement proceeds'),
 ('PAYMENT_CLEARING','Customer payment clearing'),
 ('CORRESPONDENT_TRANSIT','Correspondent cover and settlement transit'),
 ('OTHER_CUSTODY','Other custody and deposit products')
ON CONFLICT(code) DO NOTHING;
INSERT INTO banking.common_accounts(id,account_code,product_code,status)
 SELECT gen_random_uuid(), 'COM-'+lpad(n::text,4,'0'),p.code,'disabled'
 FROM (VALUES ('FIAT_CASH',1),('BANK_DEPOSITS',2),('BONDS_NOTES',3),('EQUITIES',4),('INVESTMENT_FUNDS',5),('MONEY_MARKET',6),('FOREIGN_EXCHANGE',7),('CRYPTO_ASSETS',8),('TOKENIZED_ASSETS',9),('STABLECOINS',10),('DERIVATIVES',11),('PRECIOUS_METALS',12),('COMMODITIES',13),('PHYSICAL_ASSETS',14),('COLLATERAL',15),('TRADE_FINANCE',16),('CARD_SETTLEMENT',17),('PAYMENT_CLEARING',18),('CORRESPONDENT_TRANSIT',19),('OTHER_CUSTODY',20)) AS p(code,n)
ON CONFLICT(account_code) DO NOTHING;
INSERT INTO banking.suspense_accounts(id,account_code,common_account_id,purpose,status)
 SELECT gen_random_uuid(), 'SUS-'+substring(c.account_code from 5)+'-'+lpad(s.n::text,2,'0'),c.id,s.purpose,'disabled'
 FROM banking.common_accounts c
 JOIN (VALUES
 ('UNMATCHED_BENEFICIARY',1),('SETTLEMENT_UNCONFIRMED',2),
 ('COVER_UNMATCHED',3),('CORRESPONDENT_BREAK',4),
 ('COMPLIANCE_HOLD',5),('RETURN_REPAIR',6)) AS s(purpose,n) ON true
 WHERE c.account_code LIKE 'COM-%'
ON CONFLICT(account_code) DO NOTHING;
COMMIT;
