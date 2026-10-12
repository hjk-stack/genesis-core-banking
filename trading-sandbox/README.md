# GENESIS Digital Markets | Trading Sandbox

Independent, localhost-only **paper-trading** platform. Start with Node.js 22+: `cd trading-sandbox && npm test && npm start`; open http://127.0.0.1:8091.

Contains a visual trading terminal, four synthetic instruments, risk-limited demo orders, simulated executions, order cancellations, holdings, an audit-style event display and risk exception monitoring. Every balance and market mark is invented. State resets when restarted.

This implementation does **not** connect to any payment gateway, broker, exchange, live data, custody service, banking account or GENESIS Bond. No real orders, payments, card transactions or settlement occur. Do not publish this server on the Internet: it has no identity/access system and deliberately binds to 127.0.0.1.

Production work remains: private identity-controlled Azure UAT, authenticated API, durable append-only ledger/events, regulated broker/venue onboarding, authenticated FIX/REST adapters, market data, risk and compliance monitoring, actual reconciliation, security/operational reviews and separate release approval. Nothing in the main banking service is modified. This branch is for review, not deployment.
