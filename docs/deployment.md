# Deployment — Produktivbetrieb

Frontend auf **Azure Static Web Apps** (Free), Bridge auf einer **Docker-VM in der Proxmox-Installation**, erreichbar über einen **Cloudflare-Tunnel**. Kein offener Inbound-Port im Schulnetz.

> Diese Anleitung orchestriert das Gesamt-Deployment. Die Einzelthemen sind woanders detailliert: Entra → [entra-setup.md](entra-setup.md), Proxmox-Token → [setup.md §8](setup.md), Compose-Mechanik → [README → Docker](../README.md#docker-zwei-tiers-getrennt-deploybar), Teams-Sideload → [teams-sideload.md](teams-sideload.md).

```
  Teams-Tab (Browser im iframe)
        │  1) lädt SPA            2) MSAL-Login
        ▼                              ▼
  Azure Static Web Apps          Microsoft Entra ID
        │  3) fetch/ws an VITE_API_BASE_URL (Bearer-Token)
        ▼
  Cloudflare Edge ──Tunnel (nur ausgehend, QUIC/443)──►  cloudflared ──► bridge:3001 ──► Proxmox VE API
                                                          └──────── Docker-VM in Proxmox ────────┘
```

Frontend (SWA) und Bridge (Tunnel) liegen auf **getrennten Origins** — deshalb absolute `API_BASE_URL` + CORS statt der relativen Pfade des Single-Host-Betriebs. Hintergrund: [README → Bridge-Origin](../README.md#docker-zwei-tiers-getrennt-deploybar).

---

## Reihenfolge & Abhängigkeiten

Die Schritte hängen voneinander ab — diese Reihenfolge vermeidet Henne-Ei-Probleme:

1. **Entra-App** existiert (aus der Dev-Phase, [entra-setup.md](entra-setup.md)).
2. **Proxmox-Token** für die Bridge.
3. **Backend + Tunnel** hochziehen → liefert die **öffentliche API-URL** (Tunnel-Hostname).
4. **SWA** anlegen, mit `VITE_API_BASE_URL` = API-URL bauen → liefert den **SWA-Hostname**.
5. **CORS** der Bridge auf den SWA-Hostname setzen → Backend neu starten.
6. **Entra-Redirect-URI** = SWA-Hostname ergänzen.
7. **Teams-Manifest** mit `FRONTEND_HOST` = SWA-Hostname bauen + hochladen.
8. **Verifizieren** (Ende-zu-Ende).

Schritte 3 und 4 liefern je eine URL, die spätere Schritte brauchen — wer sie kennt (eigene Domains), kann vorziehen.

---

## 0. Voraussetzungen

- **Entra-App-Registration** fertig ([entra-setup.md](entra-setup.md)): Single-Tenant, `api://<client-id>`, Scope `access_as_user`, `requestedAccessTokenVersion: 2`, App-Roles, Client-Secret, ggf. Groups-Claim.
- **VM** in der Proxmox-Umgebung mit Docker + Docker Compose **v2.20+** (`docker compose version`) und ausgehendem 443 (für den Tunnel). Die VM muss die Proxmox-API erreichen (z. B. `https://<proxmox>:8006`).
- **Cloudflare-Account** mit einer Domain in einer Zone (für die `api.…`-Subdomain).
- **Azure-Account** (SWA Free genügt) und ein **GitHub-Repo** (für das SWA-Deployment via Action).

---

## 1. Entra: Produktiv-Redirect-URI vormerken

Die SPA-Redirect-URI muss die spätere SWA-Origin enthalten (Schritt 6 trägt sie ein). Single-Tenant + Token-v2 bleiben wie in [entra-setup.md](entra-setup.md). Für `edu`-Tenants zusätzlich `EduRoster.ReadBasic` + Admin-Consent.

## 2. Proxmox: Token für die Bridge

Im Proxmox-WebUI **Datacenter → Permissions → API Tokens → Add**. Für Prod ein **dedizierter User** (nicht `root@pam`) mit minimalen Rechten (`PVEVMAdmin` auf dem Resource-Pool). Token-ID (`user@realm!name`) + Secret notieren. Details + Dev-Variante: [setup.md §8](setup.md), [proxmox-dev-setup.md](proxmox-dev-setup.md).

## 3. Backend + Cloudflare-Tunnel auf der VM

Repo auf die VM klonen und `.env` anlegen:

```bash
git clone <repo> && cd LF12_Projekt_ProxmoxTeamsTool
cp .env.example .env
```

`.env` auf der VM (Frontend-`VITE_*` werden hier **nicht** gebraucht — das Frontend läuft auf SWA):

```env
AZURE_TENANT_ID=<directory-tenant-id>
AZURE_CLIENT_ID=<application-client-id>
AZURE_CLIENT_SECRET=<secret>
AUTH_MODE=auto

PROXMOX_URL=https://<proxmox>:8006
PROXMOX_TOKEN_ID=<user@realm!name>
PROXMOX_TOKEN_SECRET=<uuid>
# PROXMOX_TLS_REJECT_UNAUTHORIZED=false   # nur bei Self-Signed-Cert

# CORS + Tunnel erst in Schritt 4/5 fuellen:
# CORS_ALLOWED_ORIGINS=https://<swa-host>
# CF_TUNNEL_TOKEN=<token>
```

**Cloudflare-Tunnel anlegen:** Dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** → Connector-Typ **Cloudflared**. Den **Token** kopieren und als `CF_TUNNEL_TOKEN` in die `.env`.

**Public-Hostname-Route** (im selben Tunnel, Reiter *Public Hostname*):

| Feld | Wert |
|---|---|
| Subdomain + Domain | z. B. `api` . `example.org` |
| Service Type | `HTTP` |
| URL | `bridge:3001` |

> Die Route lebt im Dashboard, **nicht** in einer lokalen `config.yml` (Token-/Remote-Managed-Tunnel). `bridge` ist der Compose-Service-Name — cloudflared erreicht ihn über das interne Compose-Netz. WebSockets (VNC) gehen ohne Zusatzconfig durch.

Starten:

```bash
docker compose -f docker-compose.backend.yml --profile tunnel up -d --build
docker compose -f docker-compose.backend.yml ps          # bridge healthy, cloudflared up
docker compose -f docker-compose.backend.yml logs -f cloudflared
```

Smoke-Test: `https://api.example.org/api/health` muss `{"status":"ok",…}` liefern.

Die **API-URL** (`https://api.example.org`) ist ab jetzt der Wert für `VITE_API_BASE_URL` (Schritt 4).

## 4. Frontend auf Azure Static Web Apps

SWA-Ressource anlegen (Portal → *Static Web Apps → Create*, Plan **Free**), als Quelle das GitHub-Repo wählen. Build-Settings:

| Feld | Wert |
|---|---|
| App location | `/` |
| Output location | `dist` |
| API location | *(leer)* |

Das Frontend ruft die Bridge über `VITE_API_BASE_URL` auf, das **zur Build-Zeit** eingebacken wird (öffentlich, kein Secret). SPA-Routing kommt aus [public/staticwebapp.config.json](../public/staticwebapp.config.json) (Vite kopiert sie nach `dist/`).

Diese Repo enthält eine fertige Action: [.github/workflows/azure-static-web-apps.yml](../.github/workflows/azure-static-web-apps.yml). Nötige GitHub-Konfiguration:

- **Secret** `AZURE_STATIC_WEB_APPS_API_TOKEN` — der Deployment-Token aus der SWA-Ressource (*Overview → Manage deployment token*).
- **Repository Variables** (Settings → Secrets and variables → Actions → *Variables*; öffentlich, daher Variables, nicht Secrets):
  - `VITE_AZURE_CLIENT_ID` = Client-ID
  - `VITE_AZURE_TENANT_ID` = Tenant-GUID
  - `VITE_API_BASE_URL` = `https://api.example.org` (aus Schritt 3)

Push auf `main` → die Action baut (`npm ci && npm run build`) mit den `VITE_*`-Werten und deployt `dist/`. Der SWA-Hostname (`https://<name>.azurestaticapps.net`) steht danach im Portal.

> Eigene Domain: in SWA unter *Custom domains* hinterlegen. Dann diese Domain überall dort verwenden, wo unten `<swa-host>` steht.

## 5. CORS der Bridge öffnen

Auf der VM in der `.env`:

```env
CORS_ALLOWED_ORIGINS=https://<swa-host>
```

Mehrere Origins (z. B. `*.azurestaticapps.net` **und** Custom Domain) kommagetrennt. Backend neu starten:

```bash
docker compose -f docker-compose.backend.yml --profile tunnel up -d
```

Im Log erscheint `[bridge] CORS restricted to: https://<swa-host>`. Ohne diesen Schritt blockt der Browser jeden API-Call mit einem CORS-Fehler.

## 6. Entra: SWA-Origin als Redirect-URI

Entra → App-Registration → **Authentication → Single-page application → Add URI**: `https://<swa-host>` (und ggf. die Custom Domain). Der MSAL-`redirectUri` ist `window.location.origin` ([src/config/authConfig.ts](../src/config/authConfig.ts)) — fehlt die URI, dreht der Login eine Endlosschleife bzw. `AADSTS50011 redirect_uri mismatch`.

## 7. Teams-Manifest bauen + hochladen

```bash
FRONTEND_HOST=<swa-host-ohne-https> AZURE_CLIENT_ID=<client-id> bash appPackage/build.sh
```

Erzeugt `appPackage/pttool-teams-app.zip` mit `contentUrl`/`validDomains` = SWA-Host ([appPackage/manifest.json](../appPackage/manifest.json)). In Teams hochladen (org-weit über die Teams Admin Console oder per Sideload, [teams-sideload.md](teams-sideload.md)). Bei Updates die `version` in der `manifest.json` erhöhen.

## 8. Verifikation (Ende-zu-Ende)

- [ ] `https://api.example.org/api/health` → `200`.
- [ ] SWA-URL im Browser → Login-Screen, „Mit Microsoft anmelden" führt zurück auf die SWA-URL (kein Loop).
- [ ] Nach Login: rollenabhängige UI; im DevTools-Network gehen `/api/*`-Calls an `https://api.example.org` und liefern `200` (kein CORS-Fehler in der Konsole).
- [ ] Eine VM öffnen → **VNC-Console** verbindet (WebSocket `wss://api.example.org/ws/vnc/…`).
- [ ] In Teams: App als Tab → identisches Verhalten im iframe.

## Troubleshooting

| Symptom | Ursache / Fix |
|---|---|
| Browser-Konsole: `CORS policy … No 'Access-Control-Allow-Origin'` | Schritt 5: `CORS_ALLOWED_ORIGINS` fehlt/falsch (Schema + Host exakt, ohne Trailing-Slash). Backend neu starten. |
| Tunnel liefert `502`/`error 1033` | cloudflared erreicht `bridge:3001` nicht: Bridge nicht `healthy`, falscher Service-Name/Port in der Public-Hostname-Route, oder `bridge` nicht im selben Compose-Projekt. `docker compose -f docker-compose.backend.yml ps`. |
| `cloudflared` startet nicht / unhealthy | `CF_TUNNEL_TOKEN` fehlt bei aktivem `--profile tunnel`. Logs: `… logs cloudflared`. |
| Login-Loop / `AADSTS50011` | Schritt 6: SWA-Origin fehlt als SPA-Redirect-URI in Entra. |
| Bridge-Log `FATAL … multi-tenant authority` | `AZURE_TENANT_ID` ist `common`/`organizations`/`consumers` — konkrete GUID eintragen ([entra-setup.md](entra-setup.md)). |
| `403 wrong_tenant` / `not_provisioned` | Token aus fremdem Tenant bzw. OBO-/Graph-Call scheitert (Admin-Consent, Zuweisung) — [entra-setup.md → Smoke-Test](entra-setup.md#smoke-test). |
| VNC bricht nach Leerlauf ab | Cloudflare schließt idle WebSockets; bei aktiver Nutzung unkritisch ([README → Cloudflare-Tunnel](../README.md#docker-zwei-tiers-getrennt-deploybar)). |
| API-Calls gehen an die SWA-Origin statt an die API | `VITE_API_BASE_URL` war beim SWA-Build leer/falsch → neu bauen (Repo-Variable prüfen, Action erneut laufen lassen). |

## Härtung (optional, empfohlen)

- Secrets als Datei statt Klartext-`.env`: `<NAME>_FILE` + Compose-`secrets` (auskommentierte Blöcke in [docker-compose.backend.yml](../docker-compose.backend.yml)).
- `BRIDGE_BIND` auf Loopback lassen (Default) — der Tunnel ist der einzige Ingress.
- cloudflared-Image auf ein datiertes Tag pinnen statt `:latest`.
- Dedizierter Proxmox-User statt `root@pam` (Schritt 2).
