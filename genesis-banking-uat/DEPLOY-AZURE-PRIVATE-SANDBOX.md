# GENESIS private ISO sandbox deployment (UAT only)

This deploys **only** the existing non-posting XML syntax-check gateway as a separate **internal-ingress** Azure Container App. It does not deploy Apache Fineract/Mifos, connect PostgreSQL, create accounts, or activate payments. Do not deploy a financial ledger or confidential data via this procedure.

The public `banking.avis.exchange` tile launcher remains unchanged. The Azure Container Apps environment's public network setting does **not** make an internal-ingress app public. Nevertheless, verify access boundaries before using test data.

## Preconditions

- Cloud Shell Bash signed into the intended subscription.
- Resource group `genesis-banking-rg`, Container Apps environment `genesis-banking-uat-env`, Azure Container Registry `genesisbankingacr` already exist.
- Repo cloned locally, from repository root.
- Privileged Azure access to build an image, create an app, and assign only the needed `AcrPull` role.
- No financial data, customer data, production keys, or real payment instructions in this test.

## Review and deploy (Azure Cloud Shell Bash)

```bash
set -euo pipefail
RG=genesis-banking-rg
ENV=genesis-banking-uat-env
ACR=genesisbankingacr
APP=genesis-iso-sandbox-uat
IMAGE=genesis-iso-sandbox:uat-1

az account show --query '{subscription:id,tenant:tenantId}' -o json
az containerapp env show -g "$RG" -n "$ENV" --query '{name:name,provisioningState:properties.provisioningState}' -o json
az acr show -g "$RG" -n "$ACR" --query '{name:name,loginServer:loginServer,id:id}' -o json
test -f genesis-banking-uat/gateway/Dockerfile
test -f genesis-banking-uat/gateway/server.py

# Build the image in the existing registry.
az acr build --registry "$ACR" --image "$IMAGE" --file genesis-banking-uat/gateway/Dockerfile genesis-banking-uat/gateway

LOGIN_SERVER="$(az acr show -n "$ACR" -g "$RG" --query loginServer -o tsv)"
REGISTRY_ID="$(az acr show -n "$ACR" -g "$RG" --query id -o tsv)"

# The new app has NO external ingress and scales to one replica for bounded UAT spending.
az containerapp create \
  --name "$APP" --resource-group "$RG" --environment "$ENV" \
  --image "$LOGIN_SERVER/$IMAGE" \
  --registry-server "$LOGIN_SERVER" \
  --system-assigned \
  --ingress internal --target-port 8090 \
  --cpu 0.25 --memory 0.5Gi \
  --min-replicas 1 --max-replicas 1

# Check whether an AcrPull role assignment was already created by Azure.
APP_PRINCIPAL="$(az containerapp show -n "$APP" -g "$RG" --query identity.principalId -o tsv)"
ASSIGNED="$(az role assignment list --assignee "$APP_PRINCIPAL" --scope "$REGISTRY_ID" --query "[?roleDefinitionName=='AcrPull']|length(@)" -o tsv)"
if [ "$ASSIGNED" = "0" ]; then
  az role assignment create --assignee-object-id "$APP_PRINCIPAL" --assignee-principal-type ServicePrincipal \
    --role AcrPull --scope "$REGISTRY_ID"
fi

# Registry access might need an app revision restart after role-assignment propagation.
az containerapp registry set -n "$APP" -g "$RG" --server "$LOGIN_SERVER" --identity system
az containerapp revision restart -n "$APP" -g "$RG" \
  --revision "$(az containerapp revision list -n "$APP" -g "$RG" --query '[0].name' -o tsv)"

az containerapp show -n "$APP" -g "$RG" \
  --query '{state:properties.provisioningState,ingressExternal:properties.configuration.ingress.external,fqdn:properties.configuration.ingress.fqdn,identity:identity.type}' -o json
```

**Deployment is not complete merely because the creation command succeeds.** Check revision health/logs and verify that `ingressExternal` is `false` (some internal apps can be accessed from other apps in the same environment). If you see an image-pull error, wait for role propagation, then restart the latest revision. Do not enable external ingress as a workaround.

## Test within the environment

Run a container-app console session or a temporary *internal* test client, then request `http://<internal-fqdn>/healthz` and expect `financialPosting: false`. The gateway's `/validate` endpoint performs a **basic XML family/syntax check only**, not XSD schema validation. Keep it internal.

## Further work (not included)

- Independently deploy reviewed Apache Fineract and Mifos services on private ingress; inspect upstream release pinning, database compatibility, migration and secret management first.
- Connect PostgreSQL with least privilege through the existing private endpoint; no database passwords in git or CLI history.
- Add GENESIS-owned authentication, role permissions, audit logging, double-entry controls and maker-checker before connecting any banking backends to the public launcher.
- Implement COMMON/suspense accounts and ISO 20022 booking as separately reviewed work; no live financial posting, correspondence, card issuing or settlement is enabled here.
