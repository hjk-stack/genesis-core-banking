# Payment Server

**GENESIS Core Banking / AVISPay — correspondent connectivity and FIN payment messages**

Payment Server is the dedicated interface between GENESIS Core Banking and its authenticated correspondent-bank accounts and IP-to-IP payment hosts. It is not a replacement for the card-acquiring, POS, crypto, or other payment modules.

## Responsibilities

- Maintain a registry of configured correspondent relationships and account references, with encrypted private connection configuration and bank-approved endpoint identities.
- Inbound and outbound IP-to-IP payment session management, authenticated transport, replay protection, timeouts, delivery acknowledgements and durable message capture.
- Accept and route **SWIFT FIN MT103 and MT202 COV** where supported by the contracted host, plus appropriately validated ISO 20022 payment messages through separately approved adapters.
- Correlate acknowledgements, account/statement notifications, exceptions, reconciliation, correspondent suspense postings and banking ledger entries without crediting funds from a received message alone.
- Provide administrator visibility into configuration, message receipt, validation, queue, delivery, reconciliation, error and audit status.

## Existing implementation boundary

The main Azure App Service currently provides read-only diagnostics and FIN/ISO message templates. The `src/message-adapters.js` library normalizes limited message content but does **not** authenticate a correspondent, validate complete FIN network envelopes or ISO 20022 XML, transmit a payment, post a ledger entry or demonstrate settlement.

`payment_server` in `src/capabilities.js` is a separate registered capability with `stage: adapter_required`, `operations: false`. The existing customer accounts, general ledger, card acquiring and financial instructions remain unchanged.

## Live activation requirements

1. Confirm contracted correspondent institution, host endpoints, FIN transport specifications, supported formats, network access and authenticated bank credentials via secret storage.
2. Implement a dedicated inbound/outbound transport adapter, message authentication and correlation, durable inbox/outbox with idempotency, audited exception handling and least-privilege account mapping. Never accept raw unauthenticated network messages as proof of funds.
3. Integrate with approved PostgreSQL migrations and the core ledger's double-entry validation, with pending/suspense handling and independent reconciliation to actual correspondent statements.
4. Complete interoperability and security acceptance, including positive/negative responses, retransmission, duplicate messages, timeouts, partials, reversals, all supported currencies and remote counterpart errors.
5. Deploy privately, then verify live connectivity and actual confirmed settlement before setting `operations: true`. Existing diagnostic `/healthz` cannot establish a payment rail is live.

**This specification does not itself deploy or activate a correspondent network connection.**
