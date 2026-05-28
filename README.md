# Proxmox Teams Tool

Microsoft-Teams-Tab, mit dem Lehrer Schülern Proxmox-VE-VMs aus Templates zur Verfügung stellen. Drei Rollen (Admin / Lehrer / Schüler), Klassen kommen aus M365-Groups, alle Proxmox-Metadaten leben als Tags in Proxmox selbst.

> **Status:** Funktionierender End-to-End-Flow vom Teams-Login über Bridge bis Proxmox. Auth zweischienig (Standard/EDU), Klassen-Filter über Proxmox-Tags, Templates-/VMs-/Klassen-Endpoints mit Rollen- und Klassen-Authz, Frontend rendert Live-Daten, **VNC-Console direkt im Browser** via Bridge-WebSocket-Proxy. Offen: Prod-Deployment via Tunnel, dedizierter Proxmox-User — siehe [Roadmap](#roadmap).

Mehr Details:
- **Setup-Anleitung (Onboarding):** [docs/setup.md](docs/setup.md)
- **Entra-App-Registrierung (Pflicht für Login):** [docs/entra-setup.md](docs/entra-setup.md)
- **Proxmox-Dev-Setup (Hyper-V) + API-Pointer:** [docs/proxmox-dev-setup.md](docs/proxmox-dev-setup.md)
- **Teams-App Sideload (lokales Testen als Tab):** [docs/teams-sideload.md](docs/teams-sideload.md)
- **Architektur:** [KONZEPT.md](KONZEPT.md)

---

## Komponenten

| | |
|---|---|
| **Frontend** | React 19 + TypeScript + Vite. Läuft als Teams-Tab. |
| **Bridge** ([bridge/](bridge/)) | Express-Backend im Proxmox-Netz, validiert Entra-JWTs, prüft Rollen + Klasse + Ownership, ruft die Proxmox-API. |
| **Auth** | Teams SSO via `@microsoft/teams-js`, MSAL, On-Behalf-Of zu Microsoft Graph. |
| **Proxmox-Anbindung** | `ProxmoxClient`-Interface in [bridge/proxmox/](bridge/proxmox/). Implementation folgt. |

---

## Schnellstart (lokal)

```bash
# Abhängigkeiten
npm install

# .env aus Vorlage anlegen — Werte können erstmal leer bleiben für die UI-Vorschau
cp .env.example .env

# Frontend (5173) + Bridge (3001) starten
npm run dev
```

Aufrufen: <http://localhost:5173>

> **Hinweis:** Ohne gültige Entra-App-Registrierung und Test-Tenant funktioniert der Login-Flow nicht. Für die reine UI-Vorschau gibt es einen Dev-Bypass — siehe unten.

---

## UI-Vorschau ohne Login

Solange wir keinen erreichbaren Test-Tenant haben, lässt sich die UI über einen URL-Parameter als beliebige Rolle ansehen. Wird einmal gesetzt, persistiert die Wahl in `localStorage`, bis explizit wieder abgeschaltet wird.

| URL | Effekt |
|---|---|
| `http://localhost:5173/?devauth=student` | als Schüler eingeloggt |
| `http://localhost:5173/?devauth=teacher` | als Lehrer eingeloggt |
| `http://localhost:5173/?devauth=admin` | als Admin eingeloggt |
| `http://localhost:5173/?devauth=off` | Dev-Modus aus, zurück zum echten Login-Flow |

Ist der Dev-Modus aktiv, erscheint oben ein gelber Banner mit Switch-Buttons zwischen den Rollen — dort lässt sich auch ein Klick-Logout/Switch auslösen.

Der Bypass greift **ausschließlich** wenn explizit aktiviert. Im Auslieferungszustand läuft der normale MSAL/Teams-SSO-Pfad. Implementation: [src/auth/DevFakeAuth.tsx](src/auth/DevFakeAuth.tsx).

---

## Docker (zwei Tiers, getrennt deploybar)

Beide Tiers sind containerisiert und in **zwei Compose-Dateien** aufgeteilt, plus eine Wurzel, die sie für den lokalen Full-Stack zusammensetzt:

| Datei | Services | Wofür |
|---|---|---|
| [docker-compose.backend.yml](docker-compose.backend.yml) | `bridge` (immer) + `cloudflared` (Profil `tunnel`) | Läuft auf der Proxmox-VM. |
| [docker-compose.frontend.yml](docker-compose.frontend.yml) | `frontend` (Vite-Build → nginx) | Nur falls das Frontend in Docker statt auf Azure SWA läuft. |
| [docker-compose.yml](docker-compose.yml) | `include:` beider | Lokaler Full-Stack (Tunnel aus). Braucht Compose **v2.20+**. |

```bash
# Lokal alles auf einem Host (ohne Tunnel):
docker compose up --build

# Backend auf der Proxmox-VM, mit Cloudflare-Tunnel (kein offener Inbound-Port):
docker compose -f docker-compose.backend.yml --profile tunnel up -d --build

# Frontend in Docker (nur ohne SWA):
docker compose -f docker-compose.frontend.yml up -d --build
```

- **Bridge** ([bridge/Dockerfile](bridge/Dockerfile), Multi-Stage Node-Build, läuft als `node`-User) auf Port **3001**, standardmäßig nur auf `127.0.0.1` veröffentlicht (`BRIDGE_BIND`) — der Tunnel ist der eigentliche Ingress.
- **Frontend** ([Dockerfile.frontend](Dockerfile.frontend)) auf Port **8080**. Vite bäckt `VITE_*` zur Build-Zeit ein — ein Entrypoint schreibt beim Container-Start zusätzlich `/config.js` aus den Env-Vars/Secrets (`window.__APP_CONFIG__`, Fallback auf `VITE_*`). So ist **ein Image für alle Umgebungen** zur Laufzeit konfigurierbar.

**Bridge-Origin (`API_BASE_URL`).** Das Frontend ruft die Bridge standardmäßig über **relative Pfade** auf (`/api/...`, `/ws/...`) — same-origin, lokal via Vite-Dev-Proxy bzw. hinter einem gemeinsamen Reverse-Proxy:

| Pfad | Ziel |
|---|---|
| `/` | Frontend/nginx |
| `/api/*` | Bridge (`bridge:3001`) |
| `/ws/*` | Bridge-WebSocket (`bridge:3001`) |

Liegen Frontend und Bridge auf **getrennten Origins** (Frontend auf Azure SWA, Bridge hinter Cloudflare-Tunnel), wird stattdessen eine absolute Basis gesetzt: `VITE_API_BASE_URL` (Build) bzw. `API_BASE_URL` (Container-Laufzeit) → z.B. `https://api.example.org`. Dann muss die Bridge die Frontend-Origin via `CORS_ALLOWED_ORIGINS` erlauben. Siehe [.env.example](.env.example).

**Cloudflare-Tunnel.** `cloudflared` (Token-/Remote-Managed-Modus) hängt am Profil `tunnel`, baut nur eine **ausgehende** Verbindung auf und braucht keine eingehenden Ports. Die Public-Hostname-Route (`api.example.org` → `http://bridge:3001`) wird im Cloudflare-Zero-Trust-Dashboard gesetzt, nicht in einer lokalen Config. Token als `CF_TUNNEL_TOKEN` in `.env`. WebSockets (VNC) laufen durch den Tunnel.

> **Azure Static Web Apps (Frontend).** SPA-Routing über [public/staticwebapp.config.json](public/staticwebapp.config.json) (`navigationFallback` → `/index.html`), wird von Vite nach `dist/` emittiert. `VITE_*` (inkl. `VITE_API_BASE_URL`) werden im SWA-Build eingebacken.

---

## Konfiguration

Alle Variablen leben in `.env` (siehe `.env.example`). Frontend-**Build**-Variablen tragen ein `VITE_`-Prefix; die übrigen liest die Bridge — Ausnahme: der Frontend-Container liest zur Laufzeit zusätzlich `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` und `API_BASE_URL` (ohne Prefix) und schreibt sie in `/config.js`.

| Variable | Wofür |
|---|---|
| `VITE_AZURE_CLIENT_ID` / `AZURE_CLIENT_ID` | Application (Client) ID der Entra-App |
| `VITE_AZURE_TENANT_ID` / `AZURE_TENANT_ID` | Tenant ID |
| `AZURE_CLIENT_SECRET` | Client Secret (Bridge-seitig für OBO-Token-Exchange) |
| `API_AUDIENCE` | Erwartete `aud` der eingehenden Tokens (default: `api://<AZURE_CLIENT_ID>`) |
| `AUTH_MODE` | `standard` / `edu` / `auto` (Default). Steuert, ob Rollen + Klassen aus App-Roles + `groups`-Claim (Standard) oder aus Microsoft Education Graph (EDU) kommen. Details: [docs/entra-setup.md](docs/entra-setup.md). |
| `PROXMOX_URL` / `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` | Proxmox-Anbindung. Wenn gesetzt: Bridge filtert die `classes`-Liste der Identity gegen die `tpl-class-<oid>`-Tags. Wenn leer: Filter aus (alle Group-Memberships passieren). |
| `PROXMOX_TLS_REJECT_UNAUTHORIZED` | `false` für Self-Signed-Cert (Dev). Default `true`. |
| `CF_TUNNEL_TOKEN` | Optional, wenn Cloudflare-Tunnel-Service in Compose aktiviert wird |

> **Env-Vars oder Secrets.** Jede Variable kann alternativ als `<NAME>_FILE` (Dateipfad, z.B. Docker-/Compose-Secret unter `/run/secrets/...`) gesetzt werden — gilt für Bridge **und** Frontend-Container. Die direkte Env-Var hat Vorrang. Beispiel-`secrets:`-Block (auskommentiert) in [docker-compose.yml](docker-compose.yml).

---

## Roadmap

1. ~~**`RealProxmoxClient`**~~ — erledigt. HTTP-Wrapper mit API-Token-Auth gegen Proxmox VE 8, Klassen-Filter via `tpl-class-<oid>`-Tags.
2. ~~**Erste Bridge-Endpoints**~~ — erledigt. `GET /api/templates`, `GET /api/vms`, `GET /api/classes`, `POST /api/vms/from-template/:id`, `POST /api/vms/:vmid/start|/stop`, `DELETE /api/vms/:vmid`. Authz pro Endpoint mit Rolle + Owner-/Klassen-Check.
3. ~~**Frontend-Wiring**~~ — erledigt. Templates-, MyVMs-, Klassen- und Admin-Page lesen live aus den Bridge-Endpoints und rendern Karten + Action-Buttons.
4. ~~**VM-Tagging beim Clone fertig**~~ — erledigt. Bridge feuert nach `cloneFromTemplate` einen Background-Task, der per Polling die Tags der neuen VM auf das VM-Schema umstellt (`pttool;vm-owner-<oid>;vm-tpl-<src>`).
5. ~~**VNC-Console im Frontend**~~ — erledigt. noVNC im Browser, Bridge proxied den WebSocket gegen Proxmox `vncwebsocket`. Single-use Session-Key + VNC-Ticket via `POST /api/vms/:vmid/vnc-session`. Kein direkter Proxmox-Login im Browser.
6. **Teams-Manifest aktualisieren** — auf die produktive Bridge-URL.
7. **Cloudflare-Tunnel-Deployment** der Bridge im Schulnetz.
8. **Dedizierter Proxmox-User** statt `root@pam` fuer die Bridge.
