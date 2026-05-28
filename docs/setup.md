# Setup — vom frisch geklonten Repo zum laufenden Login

Reihenfolge zählt: die Bridge braucht funktionierende Entra-Werte in der `.env`, das Frontend kommt ohne valide Entra-App-Registration nicht über den Login hinaus. Wer nur an der UI klickt, kann Schritt 3 überspringen und den Dev-Bypass nutzen (siehe unten).

## TL;DR

```bash
git clone <repo> && cd LF12_Projekt_ProxmoxTeamsTool
npm install
cp .env.example .env                       # Werte aus Schritt 3 eintragen
npm run dev                                # Frontend :5173 + Bridge :3001
```

Aufrufen: <http://localhost:5173>

Damit der Login durchgeht, müssen vorher die Entra-Schritte gemacht sein (Schritt 3). Ohne die landet man im AAD-Redirect mit `AADSTS500011`.

---

## 1. Voraussetzungen

- **Node ≥ 20** (Vite 8 + TypeScript 6).
- **npm** (`package-lock.json` ist eingecheckt — bitte kein pnpm/yarn-Mix).
- **Git**.
- *Optional, für Proxmox-Anbindung:* Windows mit Hyper-V (macOS reicht nicht für die Dev-Proxmox-VM) — Details in [proxmox-dev-setup.md](proxmox-dev-setup.md).
- *Optional, für Docker-Builds:* Docker Desktop oder Colima.

## 2. Repo + Dependencies

```bash
npm install
```

`node_modules` ist gitignored — gibt's beim ersten Lauf nicht, baut sich auf. Wenn `optionalDependencies` (`@rolldown/binding-…`) meckern: das sind plattformspezifische Pre-Builds, npm überspringt die unpassenden Plattformen automatisch.

## 3. Entra-App-Registrierung (Pflicht für Login)

Das ist der größte Brocken und einmalig pro Tenant. Detaillierte Schritte: **[entra-setup.md](entra-setup.md)**.

Kurzliste, was am Ende existieren muss:

- [ ] App-Registration mit **SPA-Redirect-URI** `http://localhost:5173`
- [ ] **Application ID URI** = `api://<client-id>` (sonst `AADSTS500011`)
- [ ] **Scope** `access_as_user` exposed (sonst `AADSTS65005`)
- [ ] **Manifest** `requestedAccessTokenVersion: 2` (sonst lehnt die Bridge das Token mit `jwt issuer invalid` ab)
- [ ] **App Roles** `Proxmox.Admin`, `Proxmox.Teacher`, `Proxmox.Student` angelegt
- [ ] Mindestens einen Test-User der App + einer Rolle zugewiesen (Enterprise Applications → Users and groups)
- [ ] **Microsoft Graph → Delegated `User.Read`** mit Admin Consent
- [ ] **Client Secret** generiert (Wert sofort speichern, nur einmal sichtbar)
- [ ] Optional: **Groups-Claim** ins Token aufgenommen (für Klassen-Filter)

Ergebnis sind drei Werte: **Client-ID, Tenant-ID, Client-Secret**. Die kommen in Schritt 4.

## 4. `.env` befüllen

```bash
cp .env.example .env
```

Mindestens diese Werte:

```env
VITE_AZURE_CLIENT_ID=<application-client-id>
VITE_AZURE_TENANT_ID=<directory-tenant-id>

AZURE_CLIENT_ID=<application-client-id>
AZURE_TENANT_ID=<directory-tenant-id>
AZURE_CLIENT_SECRET=<secret-value>
```

`PORT` (Bridge) und `API_AUDIENCE` nur überschreiben, wenn man bewusst von den Defaults abweicht. Die Proxmox-Variablen können leer bleiben, solange `RealProxmoxClient` noch nicht dran ist.

> `.env` ist gitignored, `.env.example` wird gepflegt. Wenn du neue Variablen einführst, beides aktualisieren.

## 5. Starten

```bash
npm run dev
```

Startet parallel:

| Service | Port | Was es ist |
|---|---|---|
| Frontend (Vite) | 5173 | React-App, leitet `/api/*` per Vite-Proxy an die Bridge weiter |
| Bridge (tsx) | 3001 | Express, validiert JWTs, hält den `ProxmoxClient` |

Smoke-Test: <http://localhost:3001/api/health> muss `200` antworten, <http://localhost:5173> zeigt den Login-Screen.

Einzeln starten:

```bash
npm run dev:frontend
npm run dev:bridge
```

## 6. Login verifizieren

1. <http://localhost:5173> → „Mit Microsoft anmelden"
2. Microsoft-Anmeldemaske durchklicken mit einem User, der in der App-Registration zugewiesen ist und einer der drei App-Roles trägt.
3. Erfolg: man landet wieder auf `localhost:5173`, sieht die rollenabhängige UI (Admin/Lehrer/Schüler).
4. Im Browser-DevTools-Network ist ein Access-Token sichtbar mit:
   - `aud: api://<client-id>`
   - `roles: ["Proxmox.Teacher"]` (oder Admin/Student)
   - bei aktiviertem Groups-Claim: `groups: ["<group-oid>", …]`

Typische Fehler stehen in [entra-setup.md → Smoke-Test](entra-setup.md#smoke-test).

## 7. UI-Vorschau ohne Login (Dev-Bypass)

Solange kein Tenant erreichbar ist, lässt sich die UI über einen URL-Parameter als beliebige Rolle ansehen — persistiert via `localStorage`:

| URL | Effekt |
|---|---|
| `http://localhost:5173/?devauth=student` | als Schüler eingeloggt |
| `http://localhost:5173/?devauth=teacher` | als Lehrer eingeloggt |
| `http://localhost:5173/?devauth=admin` | als Admin eingeloggt |
| `http://localhost:5173/?devauth=off` | Bypass aus, zurück zum echten Login |

Implementation: [src/auth/DevFakeAuth.tsx](../src/auth/DevFakeAuth.tsx). Greift nur, wenn explizit aktiviert.

## 8. Proxmox-Anbindung

Sobald die Bridge eine erreichbare Proxmox-Instanz sieht, filtert sie die `classes`-Liste in der Identity gegen die Proxmox-Tag-Whitelist: nur Group-OIDs, die in mindestens einem Template als `tpl-class-<oid>` markiert sind, gelten als „aktive Klasse für dieses Tool". Ohne Proxmox-Konfig (Variablen leer) wird der Filter übersprungen und die Bridge gibt alle Memberships ungefiltert weiter — gut fürs frühe Dev-Stadium, schlecht für Prod.

Was die Bridge erwartet (in `.env`):

| Variable | Wofür |
|---|---|
| `PROXMOX_URL` | z. B. `https://10.5.0.10:8006`. Wenn von extern via Tailscale + Windows-Portproxy: `https://<tailscale-ip-des-windows>:8006`. |
| `PROXMOX_TOKEN_ID` | Token-ID im Format `user@realm!tokenname`, z. B. `root@pam!pttool-dev`. |
| `PROXMOX_TOKEN_SECRET` | Secret-UUID — wird beim Anlegen genau einmal angezeigt. |
| `PROXMOX_TLS_REJECT_UNAUTHORIZED` | `false` für Self-Signed-Cert (Dev). Prod sollte gültiges Cert haben, Variable weglassen oder `true`. |

Token erzeugen im Proxmox-WebUI: **Datacenter → Permissions → API Tokens → Add**. Für Dev mit Privilege Separation **aus** (Token erbt User-Rechte). Für Prod dedizierten User mit minimal nötigen Rechten (PVEVMAdmin auf einem Resource-Pool) — siehe [proxmox-dev-setup.md](proxmox-dev-setup.md) für ein Dev-VM-Setup auf Hyper-V.

Smoke-Test nach Konfig: `GET /api/debug/proxmox` (im Dev-Modus, mit gültigem Bearer-Token) gibt Nodes + alle Resources + die gerade aktive Klassen-Whitelist zurück. Wenn das durchgeht, sieht die Bridge Proxmox sauber.

## 9. Docker (Bridge produktiv)

```bash
docker compose up --build            # lokaler Full-Stack (Frontend + Bridge)
```

Bridge läuft als Multi-Stage-Build im `node`-User. Die Tiers sind in zwei Compose-Dateien getrennt ([docker-compose.backend.yml](../docker-compose.backend.yml) inkl. `cloudflared` unter dem `tunnel`-Profil, [docker-compose.frontend.yml](../docker-compose.frontend.yml)); die Wurzel [docker-compose.yml](../docker-compose.yml) setzt sie via `include:` für den lokalen Full-Stack zusammen. Für den getrennten Produktivbetrieb (Frontend auf Azure Static Web Apps, Bridge hinter Cloudflare-Tunnel) → **[deployment.md](deployment.md)**.

## Was du *nicht* selbst tun musst

- Klassen-Groups in Entra anlegen — macht die Schul-IT pro Klasse.
- Lehrer/Schüler-Zuweisung zu Groups — ebenfalls Tenant-Aufgabe.
- Manifest fürs Teams-App-Catalog generieren — nur relevant beim Ausrollen in echte Teams-Tabs ([appPackage/](../appPackage/)).
