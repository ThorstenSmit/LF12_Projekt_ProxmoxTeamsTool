# VM-Namenskonvention

Beim Klonen einer VM aus einem Template wird der Name **serverseitig deterministisch** aus User-E-Mail, Template-ID und neu vergebener VMID gebildet. Das Format ist hardcoded in der Bridge — es gibt keinen Config-/Env-Key dafür, Änderungen sind Code-Änderungen.

## Format

```
<email-localpart>-tpl<template-id>-<vmid>
```

| Teil               | Quelle                                                        |
| ------------------ | ------------------------------------------------------------- |
| `<email-localpart>`| Text vor dem `@` der User-E-Mail (aus Token-Claims)           |
| `<template-id>`    | VMID des Quell-Templates                                      |
| `<vmid>`           | Neue VMID: Start bei `100`, danach `max(vorhandene VMIDs) + 1`|

### Beispiele

| E-Mail                  | Template | VMID | Ergebnis                  |
| ----------------------- | -------- | ---- | ------------------------- |
| `alice.meier@school.de` | 9000     | 142  | `alice-meier-tpl9000-142` |
| `j_smith@contoso.com`   | 100      | 105  | `j-smith-tpl100-105`      |

## Sanitization

Implementiert in [`bridge/index.ts`](./../bridge/index.ts) (ca. Zeile 918–921):

```typescript
const safeName = `${id.email.split("@")[0]}-tpl${templateId}-${nextId}`
  .toLowerCase()
  .replace(/[^a-z0-9-]/g, "-")
  .slice(0, 60);
```

Reihenfolge der Normalisierung:

1. komplett in Kleinbuchstaben (`toLowerCase`)
2. jedes Zeichen außerhalb `[a-z0-9-]` wird durch `-` ersetzt
3. auf **60 Zeichen** gekürzt (`slice(0, 60)`)

**Erlaubte Zeichen:** `a-z`, `0-9`, `-`

## VMID-Vergabe

Implementiert in [`bridge/index.ts`](./../bridge/index.ts) (ca. Zeile 972–979):

```typescript
async function pickFreeVmid(): Promise<VMID> {
  const all = await proxmox!.listVMs();
  if (all.length === 0) return 100;
  const max = Math.max(...all.map((v) => v.vmid));
  return max + 1;
}
```

- **Start:** VMID `100` (bei leerem Cluster)
- **Vergabe:** `max(vorhandene VMID) + 1`

## Bewusste Lücken / offene Härtungen

Das einzige Längenlimit ist der `slice(0, 60)`. Es gibt **keine** DNS-Label-Prüfung. Konkret nicht abgesichert:

- 63-Zeichen-DNS-Grenze (eigenes Limit liegt bei 60, also unkritisch, aber nicht aus DNS-Gründen)
- führende/abschließende Bindestriche (`-name`, `name-`)
- doppelte Bindestriche (`--`)

Das ist eine bewusste Entscheidung: reicht für den aktuellen Use-Case, bei Bedarf später härten.

## Referenzen

- [`KONZEPT.md`](./../KONZEPT.md) — offizielle Konzept-Doku der Namenskonvention (Abschnitt VM-Naming)
- [`bridge/index.ts`](./../bridge/index.ts) — `safeName`-Generierung & `pickFreeVmid()`
- [`bridge/proxmox/types.ts`](./../bridge/proxmox/types.ts) — `CloneOptions`- und `VM`-Interfaces
