export type { ProxmoxClient } from "./client";
export { ProxmoxNotConfiguredError } from "./client";
export type {
  CloneOptions,
  Task,
  TaskRef,
  TaskStatus,
  VM,
  VMConfig,
  VMID,
  VMRef,
  VMStatus,
} from "./types";
export {
  RealProxmoxClient,
  parseTags,
  serializeTags,
} from "./RealProxmoxClient";

import { RealProxmoxClient } from "./RealProxmoxClient";
import type { ProxmoxClient } from "./client";

// Factory — returns a ProxmoxClient if the env is fully configured, or null
// (in which case the bridge falls back to not filtering classes server-side).
export function createProxmoxClientFromEnv(): ProxmoxClient | null {
  const baseUrl = process.env.PROXMOX_URL;
  const tokenId = process.env.PROXMOX_TOKEN_ID;
  const tokenSecret = process.env.PROXMOX_TOKEN_SECRET;
  if (!baseUrl || !tokenId || !tokenSecret) return null;

  const rejectUnauthorized =
    (process.env.PROXMOX_TLS_REJECT_UNAUTHORIZED ?? "true").toLowerCase() !==
    "false";

  return new RealProxmoxClient({ baseUrl, tokenId, tokenSecret, rejectUnauthorized });
}
