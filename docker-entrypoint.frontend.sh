#!/bin/sh
set -e
# Schreibt die Laufzeit-Config der SPA nach /config.js — aus Environment-Vars
# ODER, falls <NAME>_FILE gesetzt ist, aus der Datei (Compose-/Docker-Secrets).
# Laeuft beim Container-Start (nginx fuehrt /docker-entrypoint.d/*.sh aus).

val() {
  eval "v=\${$1:-}"
  if [ -z "$v" ]; then
    eval "f=\${$1_FILE:-}"
    if [ -n "$f" ] && [ -f "$f" ]; then
      v="$(cat "$f")"
    fi
  fi
  printf '%s' "$v"
}

CID="$(val AZURE_CLIENT_ID)"
TID="$(val AZURE_TENANT_ID)"
API="$(val API_BASE_URL)"

cat > /usr/share/nginx/html/config.js <<EOF
window.__APP_CONFIG__ = {
  AZURE_CLIENT_ID: "${CID}",
  AZURE_TENANT_ID: "${TID}",
  API_BASE_URL: "${API}"
};
EOF

echo "[frontend] /config.js generiert (client=${CID:+gesetzt} tenant=${TID:+gesetzt} api=${API:-<same-origin>})"
