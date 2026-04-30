# Teams-App-Sideload (lokales Testen)

Schnellster Weg, die App als nativen Teams-Tab zu installieren — ohne
Org-weites Rollout. Reine Dev-/Demo-Variante; fuer Prod siehe Roadmap
„Teams-Manifest aktualisieren + Cloudflare-Tunnel-Deployment".

## Was du brauchst

- Eine **HTTPS-erreichbare URL** fuer das Frontend. Localhost geht nicht
  — Teams iframed die App und braucht ein vertrauenswuerdiges TLS-Cert.
- Eine **Entra-App-Registration** (siehe [entra-setup.md](entra-setup.md))
  mit dieser HTTPS-URL als SPA-Redirect.
- `python3` + `zip` auf dem Mac (sind beide standard da).

## Tunnel aufmachen (Tailscale Funnel — schnellster Weg)

Falls Tailscale schon installiert (haben wir fuer Proxmox eh):

1. Im Tailscale Admin-Console (`login.tailscale.com`) → **Settings →
   Funnel** → fuer den Mac enablen.
2. Auf dem Mac:

   ```bash
   sudo tailscale funnel --bg 5173
   ```

   Gibt dir eine URL aus wie
   `https://macbook-pro-von-alexander.<deintailnet>.ts.net/`.
   Diese URL ist public-HTTPS mit Let's-Encrypt-Cert von Tailscale,
   kein Login noetig.

Alternative: Cloudflare Tunnel (im `docker-compose.yml` als Kommentar
vorbereitet). Mehr Setup, dafuer fuer Prod geeignet.

## Entra-App vorbereiten

Im Entra-Portal die App-Registration oeffnen:

1. **Authentication** → bei der bestehenden Single-page-application-
   Plattform den Tunnel-Host als zweite Redirect-URI hinzufuegen:

   ```
   https://<dein-tunnel-host>
   ```

   Localhost-Redirect kannst du dabeilassen (fuer weiter parallel
   `npm run dev`-Entwicklung).

2. Falls Teams Single-Sign-On (SSO innerhalb des Tabs ohne MSAL-Redirect)
   funktionieren soll, muss zusaetzlich die Application ID URI auch in
   `/.default` als Pre-Authorized-App fuer Teams hinterlegt werden. Fuer
   das hier reichende Minimal-Setup (MSAL-Redirect-Flow im Iframe)
   ignorierbar.

## Manifest + Icons in ein Sideload-Zip packen

```bash
cd appPackage

# entweder Variablen explizit setzen:
FRONTEND_HOST=macbook-pro-von-alexander.<deintailnet>.ts.net \
AZURE_CLIENT_ID=05e8c4d6-... \
  bash build.sh

# oder einfach build.sh laufen lassen, die zieht AZURE_CLIENT_ID aus .env
# falls dort gesetzt — du musst nur noch FRONTEND_HOST vorne dranschreiben.
```

Das Script:

- Setzt im `manifest.json` die Platzhalter `{{FRONTEND_HOST}}` und
  `{{AZURE_CLIENT_ID}}` ein, validiert das JSON.
- Zippt das mit `color.png` (192×192) und `outline.png` (32×32) auf
  oberster Ebene zu `pttool-teams-app.zip`.

Die Zip liegt anschliessend im `appPackage/`-Ordner. Sie ist
gitignored, das Manifest-Template bleibt versioniert.

## In Teams hochladen

1. Teams oeffnen (Desktop oder Web)
2. Linke Sidebar → **Apps** (das Icon ganz unten)
3. Unten links **„Apps verwalten"** → oben rechts **„App hochladen"**
4. **„Eine App fuer mich oder mein Team hochladen"** → die
   `pttool-teams-app.zip` waehlen
5. **Hinzufuegen** → Teams loggt dich via Entra ein und der erste
   Static-Tab (Dashboard) oeffnet sich

Du hast jetzt drei Tabs im App-Header: **Proxmox** (Dashboard),
**Templates**, **Meine VMs**. Pin links in der Sidebar, dann ist die
App in jeder Teams-Session direkt da.

## Troubleshooting

- **„Diese App kann nicht ausgefuehrt werden"** im Tab: meistens das
  Cert. Pruefe ob die Tunnel-URL im Browser direkt erreichbar ist und
  kein Cert-Fehler kommt.
- **Login-Schleife**: Redirect-URI in Entra fehlt fuer den Tunnel-Host.
  Vergleiche genau (https + Hostname, kein trailing slash).
- **„AADSTS"-Fehler im Tab-Inhalt**: gleiche Ursachen wie beim normalen
  Browser-Login. Siehe [entra-setup.md → Smoke-Test](entra-setup.md#smoke-test).
- **Keine Konsole im Tab sichtbar**: Teams-Browser ist im Strict-Mode,
  manche WebSockets brauchen `validDomains`-Eintrag. Pruefe ob alle
  Hosts, die das Frontend kontaktiert, im `validDomains`-Array des
  Manifests stehen.

## Wenn du das fuer den Schul-Tenant deployen willst

- Stabile Domain statt Tunnel — Cloudflare-Tunnel-Sidecar im
  `docker-compose.yml` aktivieren.
- Manifest-Version inkrementieren (jede Update-Variante braucht hoehere
  `version` in `manifest.json`).
- Statt Sideload: Manifest in der Teams Admin Console org-weit
  approven. Dann taucht die App fuer alle Schueler/Lehrer im
  „App-Katalog" auf — kein manuelles Hochladen mehr pro User.
