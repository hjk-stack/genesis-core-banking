#!/usr/bin/env bash
# Mounts the GENESIS banking UAT stack into Azure Container Apps:
#   - genesis-fineract-uat     Apache Fineract 1.15.0, internal ingress only
#   - genesis-mifos-uat        Mifos X web app + same-origin proxy to Fineract (only public endpoint)
#   - genesis-iso-sandbox-uat  ISO 20022 syntax-check gateway, internal ingress only
#   - a dedicated PostgreSQL Flexible Server for the Fineract UAT tenant
#   - genesis-fineract-migrate  Container Apps job running Fineract's database migrations
#     (liquibase-only profile) with no health probes, so a long first migration is
#     never killed half-way; the app itself starts with migrations disabled.
#
# Idempotent: every run creates what is missing and updates what exists.
# Passwords are generated here, held only as Container App secrets and never
# printed or committed. The seed Fineract administrator password is replaced
# before the web app is opened to anyone but this runner.
#
# Required env: RG, ENV_NAME, ACR_NAME, PG_SERVER, FINERACT_IMAGE, MIFOS_IMAGE,
# GATEWAY_IMAGE (images already pushed to the registry). Optional: ALLOWED_IPS
# (comma-separated CIDRs that keep the web app restricted after setup),
# RESET_FINERACT_DB=true (drop and recreate the UAT Fineract databases first).
set -euo pipefail

FINERACT_APP=genesis-fineract-uat
MIGRATE_JOB=genesis-fineract-migrate
MIFOS_APP=genesis-mifos-uat
GATEWAY_APP=genesis-iso-sandbox-uat
PULL_IDENTITY=genesis-banking-uat-pull
PG_ADMIN=genesisadmin
PG_RUNNER_RULE=deploy-runner
TENANT_TIMEZONE=${TENANT_TIMEZONE:-Europe/Vienna}
WORK=$(mktemp -d)
PG_RULE_ADDED=false
cleanup() {
  rm -rf "$WORK"
  if [ "$PG_RULE_ADDED" = true ]; then
    az postgres flexible-server firewall-rule delete -g "$RG" -s "$PG_SERVER" -n "$PG_RUNNER_RULE" --yes -o none || true
  fi
}
trap cleanup EXIT

log() { printf '\n==> %s\n' "$*"; }
exists() { az containerapp show -g "$RG" -n "$1" --query name -o tsv >/dev/null 2>&1; }
job_exists() { az containerapp job show -g "$RG" -n "$1" --query name -o tsv >/dev/null 2>&1; }
secret_value() { az containerapp secret show -g "$RG" -n "$1" --secret-name "$2" --query value -o tsv 2>/dev/null || true; }
# Fineract secrets live on the app and on the migration job, so either one can be recreated.
fineract_secret() {
  local v
  v=$(secret_value "$FINERACT_APP" "$1")
  [ -n "$v" ] || v=$(az containerapp job secret show -g "$RG" -n "$MIGRATE_JOB" --secret-name "$1" --query value -o tsv 2>/dev/null || true)
  printf '%s' "$v"
}
# Upper, lower and digit guaranteed; 34 characters; no shell or URL special characters.
new_password() { printf 'G%sa7' "$(openssl rand -base64 64 | tr -dc 'A-Za-z0-9' | head -c 32)"; }
# Fineract's administrator policy: 12-50 characters, upper, lower, digit, special, no space.
admin_password() { printf '%s@' "$(new_password)"; }
admin_password_valid() {
  local p=$1
  [ "${#p}" -ge 12 ] && [ "${#p}" -le 50 ] && [[ $p =~ [[:upper:]] ]] && [[ $p =~ [[:lower:]] ]] &&
    [[ $p =~ [[:digit:]] ]] && [[ $p =~ [^[:alnum:]] ]] && ! [[ $p =~ [[:space:]] ]]
}

LOCATION=$(az group show -n "$RG" --query location -o tsv)
log "Resource group $RG ($LOCATION)"

# ---------------------------------------------------------------- registry
ACR_ID=$(az acr show -n "$ACR_NAME" -g "$RG" --query id -o tsv)
LOGIN_SERVER=$(az acr show -n "$ACR_NAME" -g "$RG" --query loginServer -o tsv)

log "Registry pull identity"
PULL_ID=$(az identity create -g "$RG" -n "$PULL_IDENTITY" -l "$LOCATION" --query id -o tsv)
PULL_PRINCIPAL=$(az identity show --ids "$PULL_ID" --query principalId -o tsv)
REGISTRY_MODE="identity"
if [ -z "$(az role assignment list --assignee "$PULL_PRINCIPAL" --scope "$ACR_ID" --role AcrPull --query '[0].id' -o tsv 2>/dev/null)" ]; then
  if ! az role assignment create --assignee-object-id "$PULL_PRINCIPAL" --assignee-principal-type ServicePrincipal \
      --role AcrPull --scope "$ACR_ID" -o none 2>"$WORK/role.err"; then
    echo "::warning::Could not grant AcrPull to $PULL_IDENTITY ($(head -c 300 "$WORK/role.err")). Falling back to registry admin credentials."
    REGISTRY_MODE="admin"
  fi
fi
if [ "$REGISTRY_MODE" = admin ]; then
  az acr update -n "$ACR_NAME" -g "$RG" --admin-enabled true -o none
  export ACR_USER ACR_PASSWORD
  ACR_USER=$(az acr credential show -n "$ACR_NAME" -g "$RG" --query username -o tsv)
  ACR_PASSWORD=$(az acr credential show -n "$ACR_NAME" -g "$RG" --query 'passwords[0].value' -o tsv)
  echo "::add-mask::$ACR_PASSWORD"
fi

# ------------------------------------------------------- Container Apps env
log "Container Apps environment $ENV_NAME"
if ! az containerapp env show -g "$RG" -n "$ENV_NAME" --query name -o tsv >/dev/null 2>&1; then
  az containerapp env create -g "$RG" -n "$ENV_NAME" -l "$LOCATION" --logs-destination none -o none
fi
ENV_ID=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query id -o tsv)
ENV_DOMAIN=$(az containerapp env show -g "$RG" -n "$ENV_NAME" --query properties.defaultDomain -o tsv)
MIFOS_FQDN="$MIFOS_APP.$ENV_DOMAIN"

# ------------------------------------------------------------- PostgreSQL
export DB_PASSWORD MASTER_PASSWORD
DB_PASSWORD=$(fineract_secret db-password)
MASTER_PASSWORD=$(fineract_secret master-password)
SET_DB_PASSWORD=false
if [ -z "$DB_PASSWORD" ]; then DB_PASSWORD=$(new_password); SET_DB_PASSWORD=true; fi
if [ -z "$MASTER_PASSWORD" ]; then MASTER_PASSWORD=$(new_password); fi
echo "::add-mask::$DB_PASSWORD"
echo "::add-mask::$MASTER_PASSWORD"

log "PostgreSQL Flexible Server $PG_SERVER"
if ! az postgres flexible-server show -g "$RG" -n "$PG_SERVER" --query name -o tsv >/dev/null 2>&1; then
  created=false
  for version in 17 16; do
    if az postgres flexible-server create -g "$RG" -n "$PG_SERVER" -l "$LOCATION" --version "$version" \
        --tier Burstable --sku-name Standard_B1ms --storage-size 32 --backup-retention 7 \
        --admin-user "$PG_ADMIN" --admin-password "$DB_PASSWORD" \
        --public-access 0.0.0.0 --yes -o none; then
      created=true; break
    fi
    echo "::warning::PostgreSQL $version could not be created here, trying the next version."
  done
  [ "$created" = true ] || { echo "::error::PostgreSQL server could not be created."; exit 1; }
elif [ "$SET_DB_PASSWORD" = true ]; then
  az postgres flexible-server update -g "$RG" -n "$PG_SERVER" --admin-password "$DB_PASSWORD" -o none
fi
# Azure services only (0.0.0.0); TLS stays mandatory (require_secure_transport default on).
az postgres flexible-server firewall-rule create -g "$RG" -s "$PG_SERVER" -n AllowAzureServices \
  --start-ip-address 0.0.0.0 --end-ip-address 0.0.0.0 -o none
for db in fineract_tenants fineract_default; do
  if ! az postgres flexible-server db show -g "$RG" -s "$PG_SERVER" -n "$db" --query name -o tsv >/dev/null 2>&1; then
    az postgres flexible-server db create -g "$RG" -s "$PG_SERVER" -n "$db" -o none
  fi
done
# Azure only lets users create allow-listed extensions; Fineract's migrations need uuid-ossp.
pg_extensions=$(az postgres flexible-server parameter show -g "$RG" -s "$PG_SERVER" -n azure.extensions --query value -o tsv)
if ! grep -qix 'uuid-ossp' <<<"${pg_extensions//,/$'\n'}"; then
  az postgres flexible-server parameter set -g "$RG" -s "$PG_SERVER" -n azure.extensions \
    --value "${pg_extensions:+$pg_extensions,}UUID-OSSP" -o none
fi
export PG_HOST
PG_HOST=$(az postgres flexible-server show -g "$RG" -n "$PG_SERVER" --query fullyQualifiedDomainName -o tsv)

# ------------------------------------------------------------ app manifests
export LOCATION ENV_ID LOGIN_SERVER PULL_ID REGISTRY_MODE PG_ADMIN TENANT_TIMEZONE MIFOS_FQDN
export FINERACT_APP MIGRATE_JOB MIFOS_APP GATEWAY_APP FINERACT_IMAGE MIFOS_IMAGE GATEWAY_IMAGE

# render <app|job> <file> [runner-ip]: writes the Container Apps manifest for one app or the migration job.
render() {
  python3 - "$@" <<'PY'
import json, os, sys

app, out = sys.argv[1], sys.argv[2]
runner_ip = sys.argv[3] if len(sys.argv) > 3 else ""
e = os.environ
secrets, registry, identity = [], {"server": e["LOGIN_SERVER"]}, None
if e["REGISTRY_MODE"] == "identity":
    registry["identity"] = e["PULL_ID"]
    identity = {"type": "UserAssigned", "userAssignedIdentities": {e["PULL_ID"]: {}}}
else:
    registry["username"] = e["ACR_USER"]
    registry["passwordSecretRef"] = "acr-password"
    secrets.append({"name": "acr-password", "value": e["ACR_PASSWORD"]})

def probe(kind, path, port, period, failures, delay=0):
    return {"type": kind, "httpGet": {"path": path, "port": port}, "initialDelaySeconds": delay,
            "periodSeconds": period, "failureThreshold": failures, "timeoutSeconds": 5}

def fineract_env(extra):
    pg = e["PG_HOST"]
    env = {
        "FINERACT_NODE_ID": "1",
        "FINERACT_SERVER_PORT": "8080",
        "FINERACT_SERVER_SSL_ENABLED": "false",
        "FINERACT_HIKARI_DRIVER_SOURCE_CLASS_NAME": "org.postgresql.Driver",
        "FINERACT_HIKARI_JDBC_URL": f"jdbc:postgresql://{pg}:5432/fineract_tenants?sslmode=require",
        "FINERACT_HIKARI_USERNAME": e["PG_ADMIN"],
        "FINERACT_HIKARI_MINIMUM_IDLE": "3",
        "FINERACT_HIKARI_MAXIMUM_POOL_SIZE": "10",
        "FINERACT_HIKARI_TEST_QUERY": "SELECT 1",
        "FINERACT_DEFAULT_TENANTDB_HOSTNAME": pg,
        "FINERACT_DEFAULT_TENANTDB_PORT": "5432",
        "FINERACT_DEFAULT_TENANTDB_UID": e["PG_ADMIN"],
        "FINERACT_DEFAULT_TENANTDB_CONN_PARAMS": "sslmode=require",
        "FINERACT_DEFAULT_TENANTDB_TIMEZONE": e["TENANT_TIMEZONE"],
        "FINERACT_DEFAULT_TENANTDB_IDENTIFIER": "default",
        "FINERACT_DEFAULT_TENANTDB_NAME": "fineract_default",
        "FINERACT_DEFAULT_TENANTDB_DESCRIPTION": "GENESIS UAT tenant",
        "FINERACT_MANAGEMENT_ENDPOINT_WEB_EXPOSURE_INCLUDE": "health,info",
        "FINERACT_INSECURE_HTTP_CLIENT": "false",
        "FINERACT_CONTENT_FILESYSTEM_ROOT_FOLDER": "/tmp/fineract",
        "JAVA_TOOL_OPTIONS": "-XX:MaxRAMPercentage=75 -XX:+UseContainerSupport",
    }
    env.update(extra)
    env_list = [{"name": k, "value": v} for k, v in env.items()]
    env_list += [{"name": "FINERACT_HIKARI_PASSWORD", "secretRef": "db-password"},
                 {"name": "FINERACT_DEFAULT_TENANTDB_PWD", "secretRef": "db-password"},
                 {"name": "FINERACT_DEFAULT_TENANTDB_MASTER_PASSWORD", "secretRef": "master-password"},
                 {"name": "FINERACT_DEFAULT_MASTER_PASSWORD", "secretRef": "master-password"}]
    return env_list

if app in (e["FINERACT_APP"], e["MIGRATE_JOB"]):
    secrets += [{"name": "db-password", "value": e["DB_PASSWORD"]},
                {"name": "master-password", "value": e["MASTER_PASSWORD"]}]

if app == e["MIGRATE_JOB"]:
    # Runs every pending Liquibase changeset, then exits. No probes, so nothing kills it
    # while it holds the migration lock; replicaTimeout bounds it instead.
    container = {"name": "fineract-migrate", "image": e["FINERACT_IMAGE"],
                 "env": fineract_env({"SPRING_PROFILES_ACTIVE": "liquibase-only"}),
                 "resources": {"cpu": 2.0, "memory": "4Gi"}}
    doc = {"location": e["LOCATION"],
           "properties": {"environmentId": e["ENV_ID"],
                          "configuration": {"triggerType": "Manual", "replicaTimeout": 5400,
                                            "replicaRetryLimit": 0,
                                            "manualTriggerConfig": {"parallelism": 1,
                                                                    "replicaCompletionCount": 1},
                                            "secrets": secrets, "registries": [registry]},
                          "template": {"containers": [container]}}}
    if identity:
        doc["identity"] = identity
    with open(out, "w") as f:
        json.dump(doc, f, indent=2)
    sys.exit(0)

if app == e["FINERACT_APP"]:
    health = "/fineract-provider/actuator/health"
    # Migrations run in the migration job, so the app only starts against a ready schema.
    container = {"name": "fineract", "image": e["FINERACT_IMAGE"],
                 "env": fineract_env({"FINERACT_LIQUIBASE_ENABLED": "false"}),
                 "resources": {"cpu": 1.0, "memory": "2Gi"},
                 "probes": [probe("Startup", health, 8080, 30, 10, 60),
                            probe("Liveness", health + "/liveness", 8080, 30, 5),
                            probe("Readiness", health + "/readiness", 8080, 15, 3)]}
    # allowInsecure: the Mifos proxy calls http://genesis-fineract-uat inside the environment.
    ingress = {"external": False, "targetPort": 8080, "transport": "http", "allowInsecure": True}
elif app == e["MIFOS_APP"]:
    url = "https://" + e["MIFOS_FQDN"]
    env_list = [{"name": "FINERACT_UPSTREAM", "value": "http://" + e["FINERACT_FQDN"]},
                {"name": "FINERACT_API_URLS", "value": url},
                {"name": "FINERACT_API_URL", "value": url}]
    container = {"name": "mifos", "image": e["MIFOS_IMAGE"], "env": env_list,
                 "resources": {"cpu": 0.25, "memory": "0.5Gi"},
                 "probes": [probe("Liveness", "/healthz", 80, 30, 3)]}
    ingress = {"external": True, "targetPort": 80, "transport": "auto", "allowInsecure": False}
    # Not read by the container; kept here so every manifest update carries them forward.
    secrets.append({"name": "admin-password", "value": e["ADMIN_PASSWORD"]})
    if e.get("ADMIN_ROTATED") == "yes":
        secrets.append({"name": "admin-rotated", "value": "yes"})
    if runner_ip:
        # Setup phase: nobody but this runner until the seed password is replaced.
        rules = [{"name": "setup-runner", "ipAddressRange": runner_ip + "/32", "action": "Allow"}]
    else:
        cidrs = filter(None, (c.strip() for c in e.get("ALLOWED_IPS", "").split(",")))
        rules = [{"name": f"allowed-{i + 1}", "ipAddressRange": cidr, "action": "Allow"}
                 for i, cidr in enumerate(cidrs)]
    ingress["ipSecurityRestrictions"] = rules
elif app == e["GATEWAY_APP"]:
    container = {"name": "iso-sandbox", "image": e["GATEWAY_IMAGE"],
                 "resources": {"cpu": 0.25, "memory": "0.5Gi"},
                 "probes": [probe("Liveness", "/healthz", 8090, 30, 3)]}
    ingress = {"external": False, "targetPort": 8090, "transport": "http", "allowInsecure": True}
else:
    sys.exit("unknown app " + app)

doc = {"location": e["LOCATION"],
       "properties": {"environmentId": e["ENV_ID"],
                      "configuration": {"activeRevisionsMode": "Single", "ingress": ingress,
                                        "secrets": secrets, "registries": [registry]},
                      "template": {"containers": [container],
                                   "scale": {"minReplicas": 1, "maxReplicas": 1}}}}
if identity:
    doc["identity"] = identity
with open(out, "w") as f:
    json.dump(doc, f, indent=2)  # JSON is valid YAML for --yaml
PY
}

apply() { # apply <app> <manifest>
  if exists "$1"; then
    az containerapp update -g "$RG" -n "$1" --yaml "$2" -o none
  else
    az containerapp create -g "$RG" -n "$1" --yaml "$2" -o none
  fi
}

apply_job() { # apply_job <job> <manifest>
  if job_exists "$1"; then
    az containerapp job update -g "$RG" -n "$1" --yaml "$2" -o none
  else
    az containerapp job create -g "$RG" -n "$1" --yaml "$2" -o none
  fi
}

# psql_each_db <sql>: runs one statement in both Fineract databases from this runner.
psql_each_db() {
  command -v psql >/dev/null || { sudo apt-get update -qq && sudo apt-get install -y -qq postgresql-client >/dev/null; }
  if [ "$PG_RULE_ADDED" != true ]; then
    local ip
    ip=$(curl -fsS https://api.ipify.org)
    az postgres flexible-server firewall-rule create -g "$RG" -s "$PG_SERVER" -n "$PG_RUNNER_RULE" \
      --start-ip-address "$ip" --end-ip-address "$ip" -o none
    PG_RULE_ADDED=true
  fi
  local db attempt
  for db in fineract_tenants fineract_default; do
    for attempt in 1 2 3 4 5 6; do
      if PGPASSWORD="$DB_PASSWORD" psql "host=$PG_HOST port=5432 dbname=$db user=$PG_ADMIN sslmode=require connect_timeout=20" \
          -v ON_ERROR_STOP=1 -qAt -c "$1"; then
        break
      fi
      [ "$attempt" = 6 ] && { echo "::error::Could not reach $db from the runner."; exit 1; }
      sleep 10   # firewall rule propagation
    done
  done
}

# Executions still Running or Processing (anything not yet terminal) may be migrating.
active_migrations() {
  job_exists "$MIGRATE_JOB" || { echo 0; return; }
  az containerapp job execution list -g "$RG" -n "$MIGRATE_JOB" \
    --query "length([?properties.status=='Running' || properties.status=='Processing'])" -o tsv
}
require_no_active_migration() {
  if [ "$(active_migrations)" != 0 ]; then
    echo "::error::A Fineract migration execution is still active (for example from a cancelled run); not touching the databases. Rerun once it has finished."
    exit 1
  fi
}

# Checked before any database change (reset, lock release or a new migration).
require_no_active_migration

if [ "${RESET_FINERACT_DB:-false}" = true ]; then
  log "Resetting the UAT Fineract databases (requested)"
  exists "$FINERACT_APP" && az containerapp delete -g "$RG" -n "$FINERACT_APP" --yes -o none
  for db in fineract_tenants fineract_default; do
    az postgres flexible-server db delete -g "$RG" -s "$PG_SERVER" -n "$db" --yes -o none || true
    az postgres flexible-server db create -g "$RG" -s "$PG_SERVER" -n "$db" -o none
  done
  # A fresh database brings back the seed administrator, so lock the web app again.
  az containerapp secret remove -g "$RG" -n "$MIFOS_APP" --secret-names admin-rotated -o none 2>/dev/null || true
fi

log "Fineract database migrations ($MIGRATE_JOB)"
render "$MIGRATE_JOB" "$WORK/migrate.yaml"
apply_job "$MIGRATE_JOB" "$WORK/migrate.yaml"
# An app from an earlier version of this script migrates on its own start and can be killed
# by its health probes while holding the migration lock; replace it with the migration-free app.
if exists "$FINERACT_APP" && [ "$(az containerapp show -g "$RG" -n "$FINERACT_APP" \
    --query "properties.template.containers[0].env[?name=='FINERACT_LIQUIBASE_ENABLED'].value | [0]" -o tsv)" != false ]; then
  echo "Removing the self-migrating Fineract app; it is recreated after the migration."
  az containerapp delete -g "$RG" -n "$FINERACT_APP" --yes -o none
fi
require_no_active_migration
# Nothing can hold the lock legitimately now: release one left by a killed migration.
psql_each_db "DO \$\$ BEGIN IF to_regclass('public.databasechangeloglock') IS NOT NULL THEN
  UPDATE databasechangeloglock SET locked = false, lockgranted = NULL, lockedby = NULL WHERE locked; END IF; END \$\$;"
EXECUTION=$(az containerapp job start -g "$RG" -n "$MIGRATE_JOB" --query name -o tsv)
echo "Started migration execution $EXECUTION"
status=""
for _ in $(seq 1 180); do
  status=$(az containerapp job execution show -g "$RG" -n "$MIGRATE_JOB" --job-execution-name "$EXECUTION" \
    --query properties.status -o tsv 2>/dev/null || true)
  case "$status" in
    Succeeded) break ;;
    Failed|Stopped|Degraded) break ;;
  esac
  sleep 30
done
if [ "$status" != Succeeded ]; then
  echo "::error::Fineract migration ended with status '${status:-unknown}'."
  az containerapp job logs show -g "$RG" -n "$MIGRATE_JOB" --execution "$EXECUTION" \
    --container fineract-migrate --tail 300 --format text 2>/dev/null | tail -300 || true
  exit 1
fi
echo "Migrations finished."

log "Fineract ($FINERACT_IMAGE)"
render "$FINERACT_APP" "$WORK/fineract.yaml"
apply "$FINERACT_APP" "$WORK/fineract.yaml"
# The web app proxies to Fineract's environment-internal FQDN rather than the bare app name.
FINERACT_FQDN=$(az containerapp show -g "$RG" -n "$FINERACT_APP" --query properties.configuration.ingress.fqdn -o tsv)
[ -n "$FINERACT_FQDN" ] || { echo "::error::Fineract has no internal ingress address."; exit 1; }
export FINERACT_FQDN
echo "Fineract internal address: $FINERACT_FQDN"

log "ISO 20022 sandbox gateway ($GATEWAY_IMAGE)"
render "$GATEWAY_APP" "$WORK/gateway.yaml"
apply "$GATEWAY_APP" "$WORK/gateway.yaml"

# ---------------------------------------------------- Mifos + admin rotation
export ADMIN_PASSWORD ADMIN_ROTATED
ADMIN_PASSWORD=$(secret_value "$MIFOS_APP" admin-password)
ADMIN_ROTATED=$(secret_value "$MIFOS_APP" admin-rotated)
# Stored with the app before Fineract is changed, so a failed run can always finish the rotation.
# A stored password Fineract's policy rejects was never applied, so it is safe to replace.
if [ "$ADMIN_ROTATED" != yes ] && ! admin_password_valid "$ADMIN_PASSWORD"; then ADMIN_PASSWORD=""; fi
[ -n "$ADMIN_PASSWORD" ] || ADMIN_PASSWORD=$(admin_password)
echo "::add-mask::$ADMIN_PASSWORD"
export ALLOWED_IPS
if [ "${ALLOWED_IPS_FROM_INPUT:-false}" != true ] && exists "$MIFOS_APP"; then
  # No operator input on this run (e.g. a push): keep the restrictions already on the app.
  ALLOWED_IPS=$(az containerapp show -g "$RG" -n "$MIFOS_APP" \
    --query "join(',', properties.configuration.ingress.ipSecurityRestrictions[?name!='setup-runner'].ipAddressRange || \`[]\`)" -o tsv)
fi
RUNNER_IP=""
if [ "$ADMIN_ROTATED" != yes ]; then
  # The seed administrator password may still be active: only this runner may reach the web app.
  RUNNER_IP=$(curl -fsS https://api.ipify.org)
fi
log "Mifos X web app ($MIFOS_IMAGE)"
render "$MIFOS_APP" "$WORK/mifos.yaml" "$RUNNER_IP"
apply "$MIFOS_APP" "$WORK/mifos.yaml"

BASE="https://$MIFOS_FQDN/fineract-provider"
log "Waiting for Fineract behind $BASE (first start runs all database migrations)"
up=false
code=""
for attempt in $(seq 1 80); do
  code=$(curl -sS -o "$WORK/health.out" -w '%{http_code}' -m 10 "$BASE/actuator/health" 2>"$WORK/health.err" || true)
  health=$(cat "$WORK/health.out" 2>/dev/null || true)
  if [ "$code" = 200 ] && grep -q '"status":"UP"' <<<"$health"; then up=true; break; fi
  # Every 2 minutes, show what the web app actually answers.
  if [ $((attempt % 8)) = 1 ]; then
    echo "Not up yet: HTTP ${code:-none} $(head -c 200 "$WORK/health.out" 2>/dev/null) $(head -c 200 "$WORK/health.err")"
  fi
  sleep 15
done
if [ "$up" != true ]; then
  echo "::error::Fineract did not report UP through the web app within 20 minutes (last answer: HTTP ${code:-none})."
  for app in "$FINERACT_APP" "$MIFOS_APP"; do
    echo "--- $app revisions"
    az containerapp revision list -g "$RG" -n "$app" \
      --query '[].{revision:name,active:properties.active,running:properties.runningState,health:properties.healthState,replicas:properties.replicas}' -o table || true
  done
  echo "--- $MIFOS_APP log (nginx)"
  az containerapp logs show -g "$RG" -n "$MIFOS_APP" --tail 60 --format text 2>/dev/null | tail -60 || true
  echo "--- $FINERACT_APP log"
  az containerapp logs show -g "$RG" -n "$FINERACT_APP" --tail 60 --format text 2>/dev/null | tail -60 || true
  exit 1
fi

auth() { # auth <password>: 0 when mifos/<password> signs in
  local code
  code=$(python3 - "$1" <<'PY' | curl -sS -o /dev/null -w '%{http_code}' -m 30 -X POST "$BASE/api/v1/authentication" \
      -H 'Content-Type: application/json' -H 'Fineract-Platform-TenantId: default' --data @- || true
import json, sys
print(json.dumps({"username": "mifos", "password": sys.argv[1]}))
PY
)
  [ "$code" = 200 ]
}

log "Fineract administrator password"
if auth "$ADMIN_PASSWORD"; then
  echo "Administrator password already replaced."
elif auth password; then
  python3 - <<'PY' > "$WORK/pw.json"
import json, os
p = os.environ["ADMIN_PASSWORD"]
print(json.dumps({"password": p, "repeatPassword": p}))
PY
  code=$(curl -sS -o "$WORK/pw.out" -w '%{http_code}' -m 30 -X PUT "$BASE/api/v1/users/1" \
    -u "mifos:password" -H 'Content-Type: application/json' -H 'Fineract-Platform-TenantId: default' \
    --data @"$WORK/pw.json")
  rm -f "$WORK/pw.json"
  [ "$code" = 200 ] || { echo "::error::Password change returned HTTP $code: $(head -c 400 "$WORK/pw.out")"; exit 1; }
  auth "$ADMIN_PASSWORD" || { echo "::error::New administrator password does not sign in."; exit 1; }
  echo "Seed administrator password replaced."
else
  echo "::error::Neither the stored nor the seed administrator password signs in."
  exit 1
fi

if [ -n "$RUNNER_IP" ]; then
  # Only now: drop the runner-only rule and apply the configured CIDRs (or none = open).
  log "Opening the web app"
  ADMIN_ROTATED=yes
  render "$MIFOS_APP" "$WORK/mifos.yaml"
  apply "$MIFOS_APP" "$WORK/mifos.yaml"
fi

# ------------------------------------------------------------------ report
log "Status"
for app in "$FINERACT_APP" "$MIFOS_APP" "$GATEWAY_APP"; do
  az containerapp show -g "$RG" -n "$app" \
    --query '{app:name,state:properties.runningStatus,provisioning:properties.provisioningState,external:properties.configuration.ingress.external,fqdn:properties.configuration.ingress.fqdn,image:properties.template.containers[0].image}' -o json
done
{
  echo "## GENESIS banking UAT"
  echo ""
  echo "| Component | Address | Access |"
  echo "|---|---|---|"
  echo "| Mifos X web app | https://$MIFOS_FQDN | public, Fineract sign-in (user \`mifos\`, tenant \`default\`) |"
  echo "| Apache Fineract 1.15.0 API | http://$FINERACT_FQDN (inside environment) | internal only, proxied by the web app |"
  echo "| ISO 20022 sandbox gateway | http://$GATEWAY_APP (inside environment) | internal only |"
  echo "| PostgreSQL | $PG_HOST | Azure services only, TLS required |"
  echo ""
  echo "Administrator password: \`az containerapp secret show -g $RG -n $MIFOS_APP --secret-name admin-password --query value -o tsv\`"
} >> "${GITHUB_STEP_SUMMARY:-/dev/stdout}"
