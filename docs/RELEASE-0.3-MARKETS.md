# GENESIS 0.3: Markets, Custody, Crypto and Derivatives (development only)

Internal components: customer-linked custody account requests, draft equity/bond/options/futures orders, derivative-contract validation, immutable-source position snapshot schema, draft cryptocurrency transfers, crypto-asset precision registry, and a disabled FIX/REST/ISO 20022 adapter.

These components do NOT execute a real trade, transmit an order, open a real custodian account, move securities, settle a derivative, custody crypto private keys, or broadcast blockchain transactions. Existing public app remains diagnostic-only. No database migration is executed automatically.

Before operating: provision Entra-managed least-privilege identities, complete approved migrations in a development DB, customer authorization, maker-checker, portfolio and margin/risk services, tick/lot/precision rules, market surveillance, reporting, custody segregation, reconciliation, licensed venue/clearing partners, signed exchange connectivity and certified processor sandboxes.

Do not place exchange API keys, customer account details, card data or crypto signing keys in this public repository. Maintain independent controls for security and legal/regulatory requirements.
