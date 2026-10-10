# GENESIS Banking UAT — push-ready integration bundle

This is a **test-only integration starter**, not complete licensed/production bank software. Live settlement, SWIFT connectivity, Visa/Mastercard issuing, acquiring and real customer data are NOT enabled.

## Software components

- **Apache Fineract + Mifos X**: the upstream, maintained core-banking and authenticated web-app stack; install using its official `openMF/web-app` Docker Compose file. This bundle does not redistribute, fork, or change its banking implementation.
- **GENESIS tile launcher**: local responsive navigational interface at http://localhost:8088 (not an authentication boundary; keep only on private localhost/VPN).
- **ISO 20022 sandbox gateway**: validates XML syntax, rejects DTD/entities, identifies known payment-message root names, returns a test acknowledgement. **It does not book, settle or transmit funds**. localhost:8090.
- **Card issuing, POS and web POS**: integration placeholders. Issuing requires a processor/scheme sponsor and PCI scope; acquiring requires a licensed acquirer/processor and terminal certification.

## Start local UAT (Docker + Git prerequisites)

1. `cp .env.example .env` and review variables. Do NOT commit .env or credentials.
2. `bash setup-upstream.sh` to clone the official Mifos Web App and start its upstream Compose stack. Review the upstream Compose file and pin an approved upstream revision before promoting beyond UAT.
3. `docker compose up -d --build` in this directory for the GENESIS launcher and ISO sandbox gateway.
4. Open http://localhost:8088 for GENESIS tiles; http://localhost:4200 for the Mifos interface; the Fineract API endpoint depends on the official upstream Compose configuration.
5. `curl http://localhost:8090/healthz` and `bash smoke-test.sh` to test the gateway.

**Important:** Upstream Mifos development Compose environments use test configurations and possibly published ports. Run in an isolated development environment only. Do not expose Docker ports to the internet; establish secrets, MFA, TLS, network isolation and audit before any real financial data or operation. Existing Azure App Service (`genesis-core-banking-app`) is not a Docker Compose host. Azure Container Apps, AKS or a dedicated secured VM is required for multi-container deployment, with managed PostgreSQL integration and migration controls.

## Push to GitHub

Unzip, review and commit to an appropriate **private** infrastructure repository. Do not overwrite the existing banking service, and never push `.env`, card credentials, API keys, payment messages containing personal data, or live secrets. Example:

```bash
git checkout -b feat/genesis-banking-uat
cp -R /path/to/genesis-banking-uat ./deploy/uat
git add deploy/uat
git commit -m 'Add GENESIS banking UAT integration stack'
git push -u origin feat/genesis-banking-uat
```

## Promotion gates

Fineract ledger configuration and double-entry accounting validation, account/beneficiary data model, idempotency and reconciliation; payment-scheme-certified ISO mappings, external network access, maker/checker, sanctions/fraud controls, card-token vault and secure issuing-processing arrangement, PCI DSS/PCI PIN scope, independent penetration tests, backups and recovery drills. No non-test transfer action in this bundle.

Source documentation:
- https://github.com/openMF/web-app
- https://github.com/apache/fineract
- https://github.com/openMF/ph-ee-env-labs
- https://github.com/juspay/hyperswitch
