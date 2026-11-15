# Security token and trading liquidity audit

Audit date: **2026-11-15 UTC**. Scope: the existing banking contracts, their compiled artifacts, wallet/ledger integration, AVIS order execution and deployment verification. This audit made no production changes, signed transactions, orders, approvals, transfers, or provider purchases. The only live requests were public Ethereum state reads.

## Finding

`AVISGreenRollingSecurityToken` implements restricted security-token issuance, collateral locking and fully cash-funded rolling escrow. It does **not** itself supply executable AMM liquidity, lend settlement cash against the collateral, create buy/sell orders, or execute a trade at an external venue.

The existing AVIS order book is a separate executable trading mechanism. Its liquidity comes from funded BUY orders and reserved SELL lots. A collateral value, minted token supply, cash escrow balance and executable order-book depth are different quantities and must remain separate in the administrator's view.

## What the existing contracts actually do

| Mechanism | Source evidence | Financial meaning |
| --- | --- | --- |
| Registered issuance and custody cap | `contracts/AVISOmniChainMasterHub.sol`, lines 37–51 | The factory registers a token by ISIN; issuance cannot exceed the configured custody cap, including bridged-out supply. This does not fund a market. |
| Security collateral lock | `contracts/AVISGreenRollingSecuritySystem.sol`, lines 66–82 | Security tokens transfer to the contract. Available trading power is a calculation from locked quantity, configured face value, haircut and existing commitments. |
| Each rolling leg | Same contract, lines 96–122 | The operator supplies the **full AG/AGi gross amount** through `safeTransferFrom` before the previous leg is repaid. A rollover needs fresh available settlement cash in addition to the already held leg. |
| Close and fee attribution | Same contract, lines 124–138 | Closing returns the held principal less the configured fee. `treasuryCashPool` is a fee-recipient address, not an AMM implementation. |
| Approved venue flag | Same contract, lines 145–158 | The flag permits token transfers involving an address. It does not deploy, fund, quote or call that venue. |
| Backing and ledger booking | `src/crypto/rolling-ledger.mjs`, lines 7–28 | LOCK reserves security CUSTODY; ROLL/BATCH reserves the full AG/AGi amount from FUNDING. Confirmed events move cash between user liability, escrow backing and fee revenue. No cash credit is created from the collateral calculation. |

Neither bundled contract artifact has a swap, liquidity provision/withdrawal, borrowing, repayment, reserve-pricing or oracle function. A repository search of the available contracts, application source and Azure deployment code found no AMM adapter or pool deployment path.

The application constructs the hub with the institution wallet as treasury, registrar and bridge signer (`src/crypto-chain-actions.mjs`, line 23). When that wallet is also the rolling operator, the fee returns to the same on-chain wallet and is allocated as ledger revenue. With a separate treasury, the operator loses the fee. Neither case represents external trading profit.

### Valuation and units

`prepareRealSecurity` derives face value from the source portfolio value and currency (`src/crypto-workspace.mjs`, lines 73–82). The contract then compares that nominal value directly with AG/AGi gross settlement units. There is no FX conversion, market oracle or cash-provider commitment in this calculation. Display it as configured collateral capacity with its source currency; do not present it as spendable AG/AGi cash.

Security token quantities, custody caps and collateral quantities use 18 decimals. Settlement escrow and fees are denominated in their individual settlement tokens. Use `accumulatedCashBenefitByToken(token)` for fee reporting: `totalAccumulatedCashBenefit` adds raw AG and AGi quantities without currency conversion.

## Exact asset and deployment evidence

Migration `migrations/016_crypto_workspace.sql`, lines 22–43, creates ten example security cards. The first is AVISPay PLC / `aAVISP`, initially `mode='DEMO'`, with no security ID, source position, hub address or token contract address. Its example face value and issuance amount are not proof of a live asset or funded pool.

Real preparation binds a registered institutional position, reserves the underlying quantity and records its custody reference. The on-chain lifecycle is HUB → DEPLOY → CAP → MINT; only confirmed mint booking creates the CUSTODY balance (`src/crypto-chain-actions.mjs`, lines 23–26 and 61–90). Example conversion does not perform these transactions (`src/crypto-workspace.mjs`, line 68).

The seed includes two **settlement-token** Ethereum addresses (`migrations/016_crypto_workspace.sql`, lines 637–640). The following read-only observations were obtained from the existing public RPC fallback in `src/crypto/networks.mjs`:

| Asset | Ethereum contract | Observed symbol | Decimals | Observed total supply |
| --- | --- | --- | ---: | ---: |
| AG | `0x713d3a1785219aeb37e52260ff8f96660851842b` | AG | 18 | 10,000,000,000 |
| AGi | `0x0482213c1e5a9fefdee36d9b01c044938403a9af` | AGi | 18 | 10,000,000,000 |

Observation completed **2026-11-15T21:19:10.741Z**, using `https://ethereum-rpc.publicnode.com`. Ethereum chain ID was `1`. The finalized block was **26,422,979** (`0x1932ec3`), timestamp **2026-11-15T21:04:23Z**, hash:

`0x76a398de7e6d68a68ae315a1f3c8c171c4abb4b1821b7b4eeeca85807a27fbed`

All token calls were pinned to that block number, and its canonical hash was re-read and matched. Both addresses returned 6,039 bytes of contract code and the name `AVIS Greens`. Both runtime code hashes were:

`0x3d37d7dc6ebace33211bc6ea26eeeac9d34454310fee7bf3063b32f3ce05dcd4`

These observations establish settlement-token code, identity fields and supply at that block. They do not establish the institution's holdings, collateral value, a funded liquidity pool, or a deployed `aAVISP` rolling-security contract. No live private balances or credentials are included here. No actual `aAVISP` deployment address or transaction receipt was established from the tracked seed/deployment evidence in this audit.

## Existing executable AVIS liquidity

Use exact identifiers:

- Robot → security: `trading_robots.security_id` → `portfolio_securities.security_id`.
- Related rolling card: `crypto_security_cards.security_id` and matching `user_id`, with `mode='REAL'`. Preserve the exact `card_id`, `position_id`, `network` and `contract_address`; do not infer identity from ticker or name.
- Operator address: `crypto_security_cards.wallet_address_id` → `user_deposit_addresses.public_address`, with matching holder and network. This is the wallet signed by the current contract-action path.

`reserveOrder` funds BUY `cash_hold_id` accounts and reserves the seller's portfolio quantity (`src/securities-portfolio.mjs`, lines 169–182). `executePair` performs delivery versus payment atomically (lines 186–198). The W robot consumes eligible **whole maker lots**, excluding its own holder, and cancels any unfilled IOC remainder (`src/trading-robot.mjs`, lines 74–83).

An order-book observation should therefore contain best bid/ask, quantities at those prices, full-side depth, individual lot sizes, OPEN order counts and quote-currency notionals. Exclude the robot's own orders. Sum each order's stored/recomputed `total`; for percentage-quoted securities, use `securityValue(quantity, denomination, price, quote_basis, currency)` rather than multiplying displayed quantity and price. Aggregated depth alone is not a promise that an arbitrary requested size can execute: a maker lot larger than the remaining requested quantity is skipped.

Source holdings already reserved for tokenization cannot also be reserved for new sell orders. A security CUSTODY account is not accepted as an order funding source (`src/securities-portfolio.mjs`, lines 119–121). Do not count the same underlying holding again as cash or book liquidity.

## Tests and artifact verification performed

1. `node --test test/rolling-contracts.test.mjs`: **5 passed, 0 failed**, 15.131 seconds. These executed the actual compiled contracts on an isolated in-memory Ganache chain; no real assets or external execution were involved.
2. Read-only in-memory compilation using the existing `scripts/compile-contracts.mjs` export: both contracts' ABI, creation bytecode and runtime bytecode exactly matched the checked-in artifacts. No artifacts were rewritten. Runtime sizes were 13,159 bytes for the security token and 8,416 bytes for the hub.
3. The rolling cash-conservation regression explicitly funds the operator first. With a separate treasury, two 1,000-AG legs leave escrow at 1,000 until close, then return the operator's starting cash minus two 1-AG fees (`test/rolling-contracts.test.mjs`, lines 30–35). This demonstrates escrow and fees, not investment return.
4. Inspected, but not rerun for this audit: `test/crypto-chain-actions.test.mjs`, lines 26–32. This integration fixture separately mints/books 1,000 AG before rolling a 90-AG leg. Its assertions are funding balances 910, 909.91, then 999.82 after close, with 0.18 fee revenue. The fixture does not obtain funding from the locked security.

## Remaining live proof and minimal engineering work

The existing deployment verifier already authenticates and reads the following routes (`../azure/deploy-sovereign.py`, lines 339–350). The present checks validate readable arrays, catalogue count and ten example cards; they do not establish real contract deployment or liquidity.

| Existing administrator read | Required evidence |
| --- | --- |
| `/api/views/cryptosecurities` | REAL card, exact source security/position, network, hub and token addresses, wallet binding and booked journal. |
| `/api/views/cryptoactions` | Confirmed HUB/DEPLOY/CAP/MINT and any LOCK/ROLL/CLOSE receipts, hashes and journals. This view returns only the latest 100 actions; absence in that window is not proof that an older deployment never occurred. |
| `/api/views/cryptorobots` | Rolling channel identifiers, gross amounts, sequence and state. These are separate from W robots. |
| `/api/views/cryptowallets` and `/api/views/cryptocatalogue` | Exact owned address/account and approved settlement-token mapping/precision. Private balances remain in administrator diagnostics. |
| `/api/views/tradingrobots`, `/api/views/securitypositions`, `/api/views/securityorders`, `/api/views/exchangebook` | Exact W security mapping, held funding, reserved security inventory and actual current maker lots. The public/aggregate book alone is insufficient to prove every backing reservation. |

For a REAL card, a bounded read-only observation at one finalized block should verify contract code, `hub.securityByIsin(dossier.isin)`, on-chain dossier identity, `custodyCap(token)`, token supply, and the selected operator's locked collateral, committed security, committed capacity and available capacity. Report per-token escrow, operator/contract cash balances and allowances separately. Record the block number/hash and observation time. Any actual AMM claim additionally needs the **exact pool address, token pair, funded reserves and a quantity-specific executable quote**; none follows from ERC-20 supply or an allowed-venue flag.

The immediate correction is accurate administrator measurement and exact identity binding, keeping collateral, escrow, account funding and executable book depth separate. If the intended product is cash financing against the security, the missing implementation is an explicit funded cash-provider/credit route with valuation and repayment controls. If the intended product is an AMM, the missing implementation is a funded two-asset pool plus execution and accounting integration. Neither should be represented as already delivered by the current rolling contract. Test that selected mechanism in isolation before enabling real-asset execution; this audit did not activate it.

## Primary technical references

- [Ethereum JSON-RPC documentation](https://ethereum.org/developers/docs/apis/json-rpc/): `eth_getCode` reads deployed code; `eth_call` executes a local call without creating a blockchain transaction; state queries support a finalized block parameter. Public RPC reads here used those methods, not transaction submission.
- [ERC-20 specification](https://eips.ethereum.org/EIPS/eip-20): `totalSupply`, `balanceOf`, `decimals` and allowance/transfer interfaces describe token accounting, not market liquidity or price.
- [Uniswap v2 pool documentation](https://developers.uniswap.org/docs/protocols/v2/concepts/pools): an AMM pool is a separate pair trading venue requiring deposited assets. This reference distinguishes the mechanism; it is not evidence that an AVIS pool exists or a recommendation to deploy one.
