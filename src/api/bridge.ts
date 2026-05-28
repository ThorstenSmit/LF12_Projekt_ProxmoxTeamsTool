import { useMemo } from "react";
import { useAuth } from "../auth/authContext";
import { apiUrl } from "../config/runtime";

export type VmStatus = "running" | "stopped" | "paused" | "unknown";

export interface Template {
  vmid: number;
  node: string;
  name: string;
  classes: string[];
  ownerOid: string | null;
  isPublic: boolean;
  tags: string[];
}

export interface VmDTO {
  vmid: number;
  node: string;
  name: string;
  status: VmStatus;
  ownerOid: string | null;
  sourceTemplate: { vmid: number; name: string | null } | null;
  cpus?: number;
  maxmem?: number;
  // Live-Stats — nur fuer running VMs gesetzt.
  cpu?: number;          // 0..1 (current, ~Wenige-Sekunden-Mittel)
  mem?: number;          // bytes (current)
  cpuAvg5m?: number;     // 0..1 (Durchschnitt letzte ~5 min, aus Proxmox-RRD)
  memAvg5m?: number;     // bytes (Durchschnitt letzte ~5 min)
  uptime?: number;       // Sekunden
  tags: string[];
}

export interface ClassInfo {
  oid: string;
  displayName: string | null;
  description: string | null;
  visibility: string | null;
}

export interface TaskRef {
  node: string;
  upid: string;
}

export function useBridgeApi() {
  const { accessToken, impersonatedRole } = useAuth();
  return useMemo(() => {
    const baseHeaders: Record<string, string> = accessToken
      ? { Authorization: `Bearer ${accessToken}` }
      : {};
    if (impersonatedRole) {
      baseHeaders["X-Impersonate-Role"] = impersonatedRole;
    }

    async function call<T>(url: string, init?: RequestInit): Promise<T> {
      const headers: Record<string, string> = { ...baseHeaders };
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          headers[k] = v;
        }
      }
      // apiUrl() praefixt die absolute Bridge-Origin, falls konfiguriert
      // (sonst bleibt der Pfad relativ/same-origin). Siehe ../config/runtime.
      const r = await fetch(apiUrl(url), { ...init, headers });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`${r.status} ${text}`);
      }
      return r.json() as Promise<T>;
    }

    return {
      listTemplates: () =>
        call<{ templates: Template[] }>("/api/templates").then((d) => d.templates),
      listVms: () => call<{ vms: VmDTO[] }>("/api/vms").then((d) => d.vms),
      listClasses: () =>
        call<{ classes: ClassInfo[] }>("/api/classes").then((d) => d.classes),
      createVmFromTemplate: (templateId: number) =>
        call<{ task: TaskRef; newVmid: number }>(
          `/api/vms/from-template/${templateId}`,
          { method: "POST" }
        ),
      startVm: (vmid: number) =>
        call<{ task: TaskRef }>(`/api/vms/${vmid}/start`, { method: "POST" }),
      shutdownVm: (vmid: number) =>
        call<{ task: TaskRef }>(`/api/vms/${vmid}/shutdown`, { method: "POST" }),
      stopVm: (vmid: number) =>
        call<{ task: TaskRef }>(`/api/vms/${vmid}/stop`, { method: "POST" }),
      deleteVm: (vmid: number) =>
        call<{ task: TaskRef }>(`/api/vms/${vmid}`, { method: "DELETE" }),
      attachDisk: (
        vmid: number,
        opts: { storage: string; sizeGb: number; slot?: string }
      ) =>
        call<{ ok: true; slot: string; sizeGb: number; storage: string }>(
          `/api/vms/${vmid}/disk`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(opts),
          }
        ),
      consoleLink: (vmid: number) =>
        call<{ url: string; hint: string }>(`/api/vms/${vmid}/console-link`),
      vncSession: (vmid: number) =>
        call<{ sessionKey: string; password: string; port: string }>(
          `/api/vms/${vmid}/vnc-session`,
          { method: "POST" }
        ),
      listAssignableClasses: () =>
        call<{ classes: ClassInfo[] }>("/api/classes/assignable").then(
          (d) => d.classes
        ),
      claimTemplate: (vmid: number) =>
        call<Template>(`/api/templates/${vmid}/claim`, { method: "POST" }),
      releaseTemplate: (vmid: number) =>
        call<Template>(`/api/templates/${vmid}/release`, { method: "POST" }),
      updateTemplate: (
        vmid: number,
        patch: { isPublic?: boolean; classes?: string[] }
      ) =>
        call<Template>(`/api/templates/${vmid}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        }),
    };
  }, [accessToken, impersonatedRole]);
}
