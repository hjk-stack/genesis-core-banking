#!/usr/bin/env bash
set -euo pipefail
command -v docker >/dev/null || { echo 'Docker required' >&2; exit 1; }
command -v git >/dev/null || { echo 'git required' >&2; exit 1; }
if [ ! -d upstream-mifos/.git ]; then
  git clone https://github.com/openMF/web-app.git upstream-mifos
fi
cd upstream-mifos
printf 'Using Mifos commit: '; git rev-parse HEAD
printf 'REVIEW upstream docker-compose.yml and env configuration before running.\n'
if [[ "${GENESIS_CONFIRM_UAT:-}" != 'YES' ]]; then
  echo 'Set GENESIS_CONFIRM_UAT=YES to start the upstream UAT stack.'
  exit 0
fi
docker compose up -d
