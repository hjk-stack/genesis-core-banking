# GENESIS Core Banking - Release 0.1.0

Private development foundation for the GENESIS banking program. **No banking, wallet, card, crypto or trading transactions are implemented or enabled.**

## Endpoints

- `GET /healthz` - non-sensitive process liveness
- `GET /` - safe deployment status, with no customer financial data

## Azure target

- Resource group: `genesis-banking-rg`
- App: `genesis-core-banking-app`
- Linux Node.js 22; PostgreSQL Flexible Server 17 over private VNet

## First deployment

1. Create a **private** GitHub repository `hjk-stack/genesis-core-banking`.
2. Upload these source files to GitHub. Keep `.env` and credentials out of Git.
3. From Azure Cloud Shell clone the repository after authenticating GitHub, or upload the provided ZIP into Cloud Shell.
4. Deploy the ZIP artifact using:
   `az webapp deploy --resource-group genesis-banking-rg --name genesis-core-banking-app --src-path genesis-core-banking.zip --type zip`
5. Set `SCM_DO_BUILD_DURING_DEPLOYMENT=true` through Azure app settings if Azure has not installed dependencies; redeploy.
6. Check `https://genesis-core-banking-app.azurewebsites.net/healthz`.

## Security requirements before connecting PostgreSQL

Use Azure Key Vault references or managed identity, TLS CA validation, a least-privileged DB role, private network egress, and disable anonymous banking routes. `/healthz` is intentionally database-independent. Add authenticated database readiness only after secrets are configured. Do not expose detailed database errors publicly.

This project is not production banking software.
