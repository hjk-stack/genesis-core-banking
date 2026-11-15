# AVISPay crypto, rolling securities and trading

This implementation follows the supplied **CRYPTO PLATFORM Section** (two pages), **AVISGreen Rolling Trade-Loop Security Token & Omni-Chain Spec v3.0** (eight pages), and **AVISPay Addendum v5: Unified Exchange, HFT W-Effect and RWA Tokenization**. It updates the existing banking application; no Azure resource is created.

## Wallets and securities

The catalogue starts with 200 asset metadata records, including AG and AGi. Approval verifies a token's code/precision on its selected network. Address generation runs locally for EVM, TRON, XRPL, Solana and Bitcoin. Keys use authenticated encryption bound to holder and network; an existing address is never replaced or assigned a fabricated replacement key. A holder's currencies on the same blockchain share the receiving address and QR. Blockchain balance reads are observations, not arbitrary ledger credits.

Currency activation is one operation for the account holder and currency. The server provisions all of that currency's approved, verified supported networks atomically and reuses existing addresses, encrypted keys and ledger accounts. The Add currency form lists the included networks without requiring a separate creation request for each blockchain. Existing integrations may still request one explicit network.

The workspace groups a currency's network holdings into one tile per account holder and ledger scope. Its blockchain selector controls the exact balance and Send account. The Receive popup has the same network choice and shows that network's receiving address, QR code and transaction actions. Existing currencies can select a newly approved network without repeating the Add currency form. Funding and custody holdings keep their own scopes; selecting a chain never transfers or combines balances between chains. Slow responses from an earlier network selection cannot replace the currently selected address or QR.

The ten security cards are explicitly requested examples, with AVISPay PLC first. Example conversion changes no financial account. Real conversion selects registered institution inventory, reserves its underlying quantity and records its custody reference. The sequence is hub deployment, deterministic security deployment, custody cap, minting, then wallet booking after twelve canonical confirmations. Only the confirmed mint creates the institution's CUSTODY wallet balance and balancing asset entry. The source example CHF100m is not asserted as verified issuer inventory.

The v3 contract retains its dossier, registrar/master-hub/algorithm roles, AG/AGi settlement, KYC/exchange flags, margin locks, Stop & Hold N+1 settlement, parallel channels, gold redemption and journal events. Execution corrections are aggregate collateral across channels, immutable active-channel operator/asset/amount, no withdrawal of committed collateral, explicit final-leg close, asset-specific fees, custody issuance caps and bridge source-transaction replay protection. The deterministic factory is split to stay below EIP-170. Relayer authority still requires a verified external-chain event; deploying Solidity does not deploy a relayer on every blockchain.

Signed transactions are stored before broadcast. Recovery retries the same signed bytes and verifies the canonical receipt. REVIEW can be cancelled; SIGNED/SUBMITTED is reconciled. Locked security collateral and actual AG/AGi escrow/fee movements are booked against confirmed events. Treasury fee receipts are not labelled investment return.

### Ethereum Send and Receive

The payment wizard routes new external Ethereum wallet transfers through the durable blockchain action outbox. It also accepts registered Ethereum security holdings in CUSTODY. Review binds the owned account, approved token contract, exact quantity, destination and maximum ETH network fee. Confirmation reserves both the principal and maximum fee, persists one signed transaction, then broadcasts those bytes. A retry after an uncertain response reuses the same hash and nonce. Other existing payment routes retain their settlement process.

Settlement requires the canonical receipt, at least twelve confirmations and an Ethereum finalized head covering that receipt. ERC20 settlement verifies the actual contract, exact transfer and net sender/recipient movements. Only settlement charges actual gas and releases the unused fee reservation; a reverted transaction returns its principal and charges the gas actually used. A destination belonging to another AVISPay wallet receives its credit in the same balanced settlement. Pending receipts can be refreshed without submitting another transfer.

Receive offers explicit transaction-hash reconciliation for Ethereum funding wallets and registered security custody wallets. The server verifies account/address ownership, the approved currency mapping, canonical transaction and receipt, and finalization before crediting the wallet against CHAIN_CUSTODY. Native ETH requires a direct transfer to the ordinary receiving address; token receipts use the selected contract's net Transfer events. Reading a blockchain balance alone never posts a ledger entry.

Each incoming claim is unique by network, transaction, receiving address and asset contract, with block identity and transaction-relative event proofs. Repeated requests return the existing booking. Transactions already owned by a managed action cannot create a second deposit. A changed canonical proof is retained in reconciliation diagnostics for review; it does not silently change account balances. Migrations 018 and 019 add the transfer link and deposit claims without replacing existing wallets, keys or ledger history.

## W-effect engine and Press INDEX

The separate Python process imports the unmodified, pinned NautilusTrader 1.231.0 package. Its typed QuoteTick and IOC LimitOrder objects are used by `WEffectStrategy`. AVIS owns durable order routing and reconciliation. This is a custom integration of Nautilus's strategy and order primitives, not its complete TradingNode brokerage stack.

The strategy requires all 250 ticks, chronological L1 / neckline / L2, L1 z-score below -2.2 with elevated selling, L2 within 0.35% and no lower than 99.8% of L1 with lower selling, 0.4% minimum depth, breakout with positive momentum, bid/ask size ratio at least 1.65 and spread at most 0.35%. Fresh instrument-specific Press evidence is an additional entry condition. Stops protect actual acquired quantities independently of news freshness. Configured order/daily/loss limits replace the source's unspecified Kelly-sizing placeholder. No trading starts simply because the software is deployed.

The existing AVIS book has all-or-none maker lots. Robot IOC orders consume eligible whole lots at their actual prices and cancel the unfilled remainder. Venue IOC orders may partially fill; Binance execution responses and commissions determine the robot's actual position. A network timeout leaves the durable order for query/reconciliation and never triggers an unconditional second POST. External-venue positions are recorded separately from on-chain wallet balances; API fills do not fabricate a blockchain receipt.

Public Binance book/trade streams provide market data; the trading robot never fetches publisher news. The public, read-only `https://avis.land/press/api/index` carries the Press producer, schema, timestamp, evidence, source count, score, confidence and expiry. The Press repository owns the feed collector and learning loop. An INDEX cannot substitute for the W-pattern.

## Configuration

- Existing `AVIS_WALLET_ENCRYPTION_KEY` or the existing transfer/offline encryption secret protects generated wallet keys.
- `AVIS_RPC_<NETWORK>` optionally overrides each HTTPS node endpoint; `ALCHEMY_API_KEY` supports Ethereum. No hosted wallet provider is required.
- Trading credentials use `TRADING_<NAME>_KEY` and `TRADING_<NAME>_SECRET` environment secrets. The UI stores the reference `TRADING_<NAME>`, never the secrets.
- Paid Press APIs use `PRESS_NEWSAPI_KEY`, `PRESS_FINNHUB_KEY`, `PRESS_MARKETAUX_KEY`, or publisher-specific `PRESS_*_KEY` references. Adding an entry does not buy a subscription.

## Validation

`npm test` exercises the ledger, wallet ownership, catalogue, contract transaction lifecycle, rolling escrow, fees, replay protection, native exchange fills and external venue reconciliation. Ganache tests deploy and execute the compiled Solidity. `python -m unittest discover -s trading -p 'test_*.py'` exercises W conditions, stale/negative INDEX, typed IOC creation, partial-position stops and evaluator throughput. The throughput test measures local pattern evaluation only, not exchange or network latency. `node --test test-browser/*.mjs` checks desktop/tablet/mobile layouts and interaction continuity. CI recompiles contracts and rejects artifact drift, builds the combined Node/Python container, and updates only the existing UAT application.

## Existing provider validation

The administrator's Validate CoinAPI & Alchemy action probes CoinAPI EMS balances and the separately configured Alchemy/CoinAPI Ethereum nodes without placing an order. It reports only account identifiers, chain ID and observed block, never keys. This first engine release routes trading through AVIS or the configured Binance adapter; the existing CoinAPI EMS account is validated for the next execution adapter. Alchemy supplies blockchain RPC and signed-transaction transport, not a second strategy engine.

Deployment reuses the named provider settings from the existing AVIS App Service only when absent in UAT, preserving existing UAT secrets. `CRYPTO_RPC_ETHEREUM`, `COINAPI_NAAS_API_KEY`, `COINAPI_API_KEY`, and `APIBRICKS_COINAPI_KEY` are recognised alongside `ALCHEMY_API_KEY` and the `AVIS_RPC_*` overrides. CoinAPI node credentials are sent only to its node origin. Market rankings refresh every two minutes with actual observation timestamps.
