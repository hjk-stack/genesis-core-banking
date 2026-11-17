#!/usr/bin/env bash
set -euo pipefail
command -v az >/dev/null || { echo 'Azure CLI is required' >&2; exit 2; }
az account show --query name -o tsv >/dev/null
RG=${RG:-genesis-banking-rg}
[ "$(az group exists --name "$RG")" = true ] || { echo 'Resource group not found' >&2; exit 3; }
echo '## PostgreSQL backup / HA inventory'
az postgres flexible-server list -g "$RG" --query '[].{name:name,location:location,retention:backup.backupRetentionDays,geo:backup.geoRedundantBackup,ha:highAvailability.mode,state:state}' -o table
echo '## App Services'
az webapp list -g "$RG" --query '[].{name:name,location:location,state:state}' -o table
echo '## Container Apps'
az containerapp list -g "$RG" --query '[].{name:name,location:location,provisioningState:properties.provisioningState}' -o table
echo '## Storage redundancy'
az storage account list -g "$RG" --query '[].{name:name,location:location,replication:sku.name}' -o table
echo 'Read-only inventory complete. Nothing deployed or changed.'
