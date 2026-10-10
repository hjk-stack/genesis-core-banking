#!/usr/bin/env bash
set -euo pipefail
curl --fail -sS http://127.0.0.1:8090/healthz
printf '\n'
curl --fail -sS -X POST http://127.0.0.1:8090/validate -H 'Content-Type: application/xml' --data '<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pacs.008.001.08"><FIToFICstmrCdtTrf/></Document>'
printf '\n'
