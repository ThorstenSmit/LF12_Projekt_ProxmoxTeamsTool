import type { ProxmoxClient } from "./proxmox";

// Active-class whitelist. A Group becomes a "Pttool-Klasse" by virtue of
// at least one template in Proxmox being tagged `tpl-class:<group-oid>`.
// Without such a tag the group is just an M365 group from the user's
// `groups`-claim and gets filtered out — keeps "All Company" etc. out of
// the UI even though the user is technically a member.

const ACTIVE_CLASS_CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { oids: Set<string>; expiresAt: number } | null = null;

const TAG_PREFIX = "tpl-class:";

export async function getActiveClassOids(
  client: ProxmoxClient | null
): Promise<Set<string> | null> {
  // No client configured -> no filter -> bridge passes all groups through.
  // Useful in dev before Proxmox is wired up.
  if (!client) return null;

  if (cache && cache.expiresAt > Date.now()) return cache.oids;

  const vms = await client.listVMs();
  const oids = new Set<string>();
  for (const vm of vms) {
    for (const tag of vm.tags) {
      if (tag.startsWith(TAG_PREFIX)) {
        const oid = tag.slice(TAG_PREFIX.length).trim();
        if (oid) oids.add(oid);
      }
    }
  }
  cache = { oids, expiresAt: Date.now() + ACTIVE_CLASS_CACHE_TTL_MS };
  return oids;
}

// For tests / debug endpoints — drop the cache so the next call hits Proxmox.
export function clearActiveClassCache(): void {
  cache = null;
}

export async function filterToActiveClasses(
  client: ProxmoxClient | null,
  candidateOids: string[]
): Promise<string[]> {
  const active = await getActiveClassOids(client);
  if (active === null) return candidateOids;
  return candidateOids.filter((oid) => active.has(oid));
}
