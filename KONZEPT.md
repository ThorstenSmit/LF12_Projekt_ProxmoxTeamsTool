# Konzept — Proxmox Teams Tool

> Stand: 2026-05-21 — frühe Konzeptphase. Repo enthält aktuell nur ein Teams-SSO-Gerüst (React + Express OBO). Das hier beschreibt die geplante Zielarchitektur.

## Idee in einem Satz

Ein Microsoft-Teams-Tab, mit dem Lehrer Schülern Proxmox-VMs aus Templates zur Verfügung stellen. Alle Aufrufe gegen Proxmox laufen über eine **Bridge** im Proxmox-Netz, die Tokens prüft, die Berechtigung gegen das Domänenmodell auswertet und den Befehl dann an die Proxmox-API durchreicht.

---

## Komponenten

```
┌─────────────────────┐         ┌─────────────────────┐         ┌──────────────┐
│  Teams Tab (React)  │ ──────► │       Bridge        │ ──────► │    Proxmox   │
│  (Browser im Teams) │  HTTPS  │ (im Proxmox-Netz)   │   API   │              │
└──────────┬──────────┘         └──────────┬──────────┘         └──────────────┘
           │                               │
           │ Teams SSO                     │ JWT-Validierung
           │ MSAL                          │ Graph (Gruppen)
           ▼                               ▼
        ┌──────────────────────────────────────┐
        │  Microsoft Entra ID / Graph API      │
        │  - User-Identität                    │
        │  - App Roles (Admin/Teacher/Student) │
        │  - M365-Groups (= Klassen)           │
        └──────────────────────────────────────┘
```

### 1. Frontend (Teams Tab)
- React + TypeScript + Vite, eingebettet als Teams Tab.
- Authentisiert via Teams SSO (`@microsoft/teams-js`) + MSAL.
- Spricht **nur mit der Bridge**, nie direkt mit Proxmox.
- Sendet semantische Befehle: „Create VM from Template X", „Start VM Y", „List my VMs".

### 2. Bridge
- Läuft im selben Netz wie Proxmox (Reachability + Latenz).
- Im besten Fall ein **dünner Proxmox-API-Wrapper** + Auth-Layer davor.
- Zwei externe Abhängigkeiten:
  - **Proxmox-API** für die eigentlichen Operationen.
  - **Microsoft Entra/Graph** für Token-Validierung und ggf. Gruppen­mit­glied­schaft.
- Hält möglichst **keinen State** (siehe Tags unten). Caching optional, später.

### 3. Proxmox
- Source of Truth für VMs, Templates **und deren Metadaten** (Owner, Klasse, Public-Flag) — alles in Proxmox-Tags.

### 4. Microsoft Entra / Graph
- Identität: User-OID aus Token-Claims.
- Rollen: App Roles `Proxmox.Admin`, `Proxmox.Teacher`, `Proxmox.Student` als Claim.
- Klassen: Vorschlag — eine M365-Group/Team pro Klasse, Group-OID ist die Klassen-ID. Mitgliedschaft per Graph abfragbar.

---

## Tokenfluss

1. Teams Tab lädt → Teams SSO gibt ein ID-Token für die App heraus.
2. Frontend holt via MSAL ein **Access-Token für die Bridge-API** (`api://<bridge>/access_as_user`).
3. Frontend ruft Bridge mit `Authorization: Bearer <token>` auf.
4. Bridge validiert das JWT (Signatur via JWKS, `iss`, `aud`, `exp`, App-Role-Claim).
5. Bridge extrahiert **User-OID** und **Rolle** aus Claims.
6. Falls Gruppenmitgliedschaft (= Klassenzugehörigkeit) gebraucht wird: Bridge tauscht das Token via **On-Behalf-Of** gegen ein Graph-Token und fragt Group-Memberships ab.

---

## Datenmodell — alles in Proxmox-Tags

Proxmox-Tags sind plain strings ohne Key/Value. Konvention: `prefix:value`.

### VM-Tags
| Tag | Bedeutung |
|---|---|
| `pttool` | Marker: vom Tool verwaltet (Discovery/Filter) |
| `vm-owner-<user-oid>` | Schüler, dem die VM gehört |
| `vm-tpl-<template-id>` | Aus welchem Template erstellt (für „Recreate") |

### Template-Tags (Proxmox-VM-Templates)
| Tag | Bedeutung |
|---|---|
| `pttool-tpl` | Marker: ein vom Tool nutzbares Template |
| `tpl-owner-<teacher-oid>` | Ersteller (Lehrer) |
| `tpl-public` | Public-Flag — andere Lehrer dürfen es zuweisen |
| `tpl-class-<class-id>` | Klassenzuweisung (mehrfach möglich → m:n) |

**Vorteil:** Keine separate DB. Proxmox bleibt Single Source of Truth. Backups/Snapshots des Proxmox-Clusters enthalten automatisch das Domänenmodell.

**Nachteil/offen:** Pro Auth-Entscheidung müssen Tags gelesen werden. Für die erste Iteration **bewusst akzeptiert** — wir messen, bevor wir optimieren.

---

## VM-Namensschema (Hostname)

Der VM-Name wird beim Klonen aus einem Template **serverseitig in der Bridge** deterministisch erzeugt. Es gibt **keinen Namens-Input vom Frontend** — der Client schickt nur die `templateId`, die komplette Benennung passiert in der Bridge.

**Muster:** `<email-localpart>-tpl<template-id>-<vmid>`

| Bestandteil | Herkunft |
|---|---|
| `<email-localpart>` | Teil der User-E-Mail vor dem `@` (aus den Token-Claims) |
| `<template-id>` | VMID des Quell-Templates |
| `<vmid>` | neu vergebene VMID der geklonten VM (`max(vorhandene vmid) + 1`, Start bei `100` im leeren Cluster) |

**Sanitization** (in dieser Reihenfolge):
1. komplett `lowercase`
2. jedes Zeichen außerhalb `[a-z0-9-]` → `-`
3. auf **60 Zeichen** gekürzt (`slice(0, 60)`)

**Beispiele:**

| User-E-Mail | Template | VMID | → VM-Name |
|---|---|---|---|
| `alice.meier@school.de` | 9000 | 142 | `alice-meier-tpl9000-142` |
| `j_smith@contoso.com` | 100 | 105 | `j-smith-tpl100-105` |

**Source of Truth:** [`bridge/index.ts`](bridge/index.ts) (`safeName`-Erzeugung beim Clone) und `pickFreeVmid()` für die VMID-Vergabe. Es gibt **keinen Config-/Env-Key** für das Format — eine Formatänderung ist eine Code-Änderung.

> **Bewusst offen:** Das einzige Längenlimit ist der `slice(0, 60)`. Es gibt **keine** DNS-Label-Prüfung (63 Zeichen, kein führender/abschließender `-`, kein Doppel-`-`). Reicht für den aktuellen Use-Case; bei Bedarf später härten.

---

## Berechtigungs­prüfung (Bridge)

Pro eingehendem Request:

1. **Token validieren** → User-OID, Rolle.
2. **Befehl klassifizieren** — Read vs. Write, Target = VM / Template / Klasse.
3. **Target-Tags lesen** aus Proxmox (oder, bei Listen, Filterung über Tags).
4. **Regel auswerten:**

| Rolle | Darf |
|---|---|
| Admin | alles |
| Teacher | Templates erstellen; eigene Templates oder `tpl-public` als `tpl-class-<seine-klasse>` zuweisen/entziehen; VMs in seinen Klassen sehen + start/stop/delete |
| Student | aus zugewiesenen Templates **eine** VM pro Template erstellen; nur eigene VMs (`owner == self`) start/stop/delete/recreate |

5. **Erlauben** → Proxmox-Call durchreichen. **Verweigern** → 403.

> Auth-Checks prüfen **immer Rolle + Ownership/Class** — reine Rollen-Checks reichen nie aus.

---

## Klassen

**Entschieden:** Eine **M365-Group pro Klasse**. Die Bridge unterstützt zwei Wege, an Rollen + Klassenzugehörigkeit zu kommen — gewählt via `AUTH_MODE` (s. u.).

- Group-OID = `class-id` (landet auch als `tpl-class-<group-oid>` in den Proxmox-Tags) — **identisch in beiden Modi**, sodass die Proxmox-Tags und VM-Logic mode-agnostisch bleiben.

### Modus `standard` (Plain M365, kein EDU)
- Klassen werden manuell als M365-Group im Tenant angelegt.
- **Lehrer und Schüler sind beide ganz normale Mitglieder** derselben Group — innerhalb der Group nicht unterscheidbar.
- Lehrer/Schüler-Differenzierung kommt **ausschließlich aus der App Role** (`Proxmox.Teacher` vs. `Proxmox.Student`) im Token-Claim, manuell pro User in Entra zugewiesen.
- „Lehrer Müller ist Lehrer der Klasse 12a" = `App Role == Teacher` **UND** `User ∈ Group(12a)`. Beide Bedingungen prüft die Bridge.
- Schüler analog: `App Role == Student` **UND** `User ∈ Group(12a)`.

### Modus `edu` (Teams for Education / School Data Sync)
- Falls der Tenant EDU-licensed ist und der Admin `EduRoster.ReadBasic` für unsere App freigibt: die Bridge zieht Rollen + Klassen aus dem Education Graph.
- **Roles:** `primaryRole` aus `/education/me/user` → mapped (`teacher`/`faculty` → `Proxmox.Teacher`, `student` → `Proxmox.Student`). `Proxmox.Admin` bleibt eine zusätzliche manuelle App-Role.
- **Klassen:** `/education/me/classes?$expand=group` → `group.id` (= Group-OID der unter dem EDU-Class-Objekt liegenden M365-Group).
- Vorteil: keine Per-User-Pflege in Entra mehr — Teacher/Student/Klassen kommen aus dem SDS-Sync vom Schulverwaltungssystem.
- Implementiert in [bridge/index.ts → `resolveFromEdu`](bridge/index.ts) — **untested without an EDU tenant**, defensiv gegen die Microsoft-Docs gebaut.

### Modus `auto` (Default)
- Bridge probiert beim ersten Request pro User-OID `GET /education/me`.
  - 200 → User wird als EDU-User behandelt.
  - 403 (kein Consent) / 404 (kein EDU im Tenant) → Standard-Modus.
- Ergebnis 1 h pro OID gecached, damit der Probe-Call nicht pro Request fällt.
- Ein und derselbe Bridge-Build funktioniert so in beiden Tenant-Typen ohne Deploy-Anpassung.

### Wie die Bridge an die Mitgliedschaft kommt
- **Primärquelle:** `groups`-Claim direkt im Access-Token (in Entra: Token configuration → Groups claim → „All groups", Format Group ID). Spart pro Request einen Graph-Call. Implementiert in [bridge/index.ts → `getUserGroups`](bridge/index.ts).
- **Overage-Fallback:** Bei >150 Group-Memberships schaltet Entra die `groups`-Array auf einen `_claim_names`-Pointer um — dann fetcht die Bridge via OBO + `POST /v1.0/me/getMemberGroups` und cached das Ergebnis pro User-OID 10 min in-memory. Für Schüler praktisch kein Thema, für Lehrer mit vielen Klassen + Tenant-Groups evtl. doch.
- **Filterung in der Bridge:** Bei „All groups" landen auch nicht-Klassen-Groups (Security-/Distribution-Groups) im Token. Wir whitelisten serverseitig über die Klassen-Tags in Proxmox (`tpl-class-<oid>`) — alles, was dort nicht referenziert ist, wird ignoriert. Implementiert in [bridge/classes.ts → `filterToActiveClasses`](bridge/classes.ts); Whitelist wird einmal pro 5 min aus `cluster/resources` aggregiert. Ist `PROXMOX_URL` nicht gesetzt, läuft die Bridge ohne Filter (Dev-Fallback).

### Pflege der Klassen
- Liegt komplett im Tenant: Klassen-Group anlegen, Lehrer + Schüler hinzufügen — fertig. Kann über Schulverwaltung/IT/Teams-Admin laufen, **wir bauen dafür kein eigenes UI**.

---

## Performance — bewusst auf später vertagt

- Erste Iteration: Tags pro Request live aus Proxmox lesen.
- Wenn das ruckelt → in dieser Reihenfolge eskalieren:
  1. In-Memory-Cache in der Bridge (Tags pro Resource, kurze TTL).
  2. Batch-Reads (Proxmox liefert Listen mit Tags inklusive).
  3. Dedizierter Endpoint / Sekundärindex in der Bridge.
- **Nicht** vorab bauen.

---

## Was als nächstes ansteht

1. Bridge-Skeleton (eigener Service oder erstmal der bestehende `server/` ausgebaut) mit JWT-Validierung gegen Entra.
2. Tag-Schema festklopfen (siehe oben — Strings finalisieren).
3. Erste Read-Operation: „Liste meine VMs" (Schüler-Sicht) — End-to-End: Frontend → Bridge → Proxmox → gefilterte Antwort.
4. Template-Erstellung + Klassenzuweisung (Lehrer-Sicht).
5. VM-Erstellung aus Template (Schüler-Sicht) inkl. „eine pro Template"-Constraint.

Bis dahin: das hier ist ein Konzeptpapier, kein Implementations­plan.
