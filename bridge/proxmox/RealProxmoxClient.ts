import axios, { AxiosInstance, AxiosResponse } from "axios";
import https from "https";
import type { ProxmoxClient } from "./client";
import type {
  CloneOptions,
  Task,
  TaskRef,
  TaskStatus,
  VM,
  VMConfig,
  VMID,
  VMStatus,
} from "./types";

// HTTP client against a Proxmox VE cluster, authenticated via API token.
// Token auth bypasses CSRF (the Cookie+CSRFPreventionToken dance is only
// required for ticket auth) — see https://pve.proxmox.com/wiki/Proxmox_VE_API.

export interface RealProxmoxClientOptions {
  baseUrl: string;
  tokenId: string;
  tokenSecret: string;
  rejectUnauthorized?: boolean;
}

export class RealProxmoxClient implements ProxmoxClient {
  private http: AxiosInstance;

  constructor(opts: RealProxmoxClientOptions) {
    this.http = axios.create({
      baseURL: opts.baseUrl.replace(/\/+$/, "") + "/api2/json",
      headers: {
        Authorization: `PVEAPIToken=${opts.tokenId}=${opts.tokenSecret}`,
      },
      httpsAgent: new https.Agent({
        rejectUnauthorized: opts.rejectUnauthorized ?? true,
      }),
      timeout: 15000,
    });
  }

  // ── Discovery ────────────────────────────────────────────────────────────

  async listNodes(): Promise<string[]> {
    const r = await this.http.get<{ data: Array<{ node: string }> }>("/nodes");
    return r.data.data.map((n) => n.node);
  }

  // ── VMs ──────────────────────────────────────────────────────────────────

  async listVMs(opts?: { node?: string; requireTags?: string[] }): Promise<VM[]> {
    const r = await this.http.get<{ data: ClusterResource[] }>(
      "/cluster/resources",
      { params: { type: "vm" } }
    );
    let vms = r.data.data.map(clusterResourceToVM);
    if (opts?.node) {
      vms = vms.filter((v) => v.node === opts.node);
    }
    if (opts?.requireTags?.length) {
      vms = vms.filter((v) =>
        opts.requireTags!.every((t) => v.tags.includes(t))
      );
    }
    return vms;
  }

  async getVM(node: string, vmid: VMID): Promise<VM> {
    const [statusR, configR] = await Promise.all([
      this.http.get<{ data: VMStatusResponse }>(
        `/nodes/${node}/qemu/${vmid}/status/current`
      ),
      this.http.get<{ data: VMConfigResponse }>(
        `/nodes/${node}/qemu/${vmid}/config`
      ),
    ]);
    const s = statusR.data.data;
    const c = configR.data.data;
    return {
      node,
      vmid,
      name: s.name ?? c.name ?? `vm-${vmid}`,
      status: mapStatus(s.status),
      template: c.template === 1,
      tags: parseTags(c.tags ?? s.tags),
      cpus: c.cores ?? s.cpus,
      maxmem: s.maxmem,
    };
  }

  async cloneFromTemplate(
    node: string,
    templateVmid: VMID,
    opts: CloneOptions
  ): Promise<TaskRef> {
    const body = new URLSearchParams();
    body.set("newid", String(opts.newid));
    body.set("name", opts.name);
    if (opts.target) body.set("target", opts.target);
    if (opts.full !== undefined) body.set("full", opts.full ? "1" : "0");

    const r = await this.http.post<{ data: string }>(
      `/nodes/${node}/qemu/${templateVmid}/clone`,
      body.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    return { node, upid: r.data.data };
  }

  async startVM(node: string, vmid: VMID): Promise<TaskRef> {
    return this.taskAction(node, vmid, "start");
  }

  async stopVM(node: string, vmid: VMID): Promise<TaskRef> {
    // "shutdown" lets the guest OS shut cleanly; "stop" pulls the plug.
    // Bridge users (Schueler) probably want clean shutdown — UI can offer
    // a force-stop separately later.
    return this.taskAction(node, vmid, "shutdown");
  }

  async deleteVM(node: string, vmid: VMID): Promise<TaskRef> {
    const r = await this.http.delete<{ data: string }>(
      `/nodes/${node}/qemu/${vmid}`
    );
    return { node, upid: r.data.data };
  }

  // ── Config / tags ────────────────────────────────────────────────────────

  async updateConfig(node: string, vmid: VMID, patch: VMConfig): Promise<void> {
    const body = new URLSearchParams();
    if (patch.name !== undefined) body.set("name", patch.name);
    if (patch.cores !== undefined) body.set("cores", String(patch.cores));
    if (patch.memory !== undefined) body.set("memory", String(patch.memory));
    if (patch.tags !== undefined) body.set("tags", serializeTags(patch.tags));

    if ([...body.keys()].length === 0) return;

    await this.http.put(`/nodes/${node}/qemu/${vmid}/config`, body.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  async getTask(ref: TaskRef): Promise<Task> {
    const r = await this.http.get<{
      data: { status: string; exitstatus?: string };
    }>(`/nodes/${ref.node}/tasks/${ref.upid}/status`);
    return {
      node: ref.node,
      upid: ref.upid,
      status: r.data.data.status === "stopped" ? "stopped" : "running",
      exitstatus: r.data.data.exitstatus,
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async taskAction(
    node: string,
    vmid: VMID,
    action: "start" | "stop" | "shutdown" | "reboot"
  ): Promise<TaskRef> {
    const r: AxiosResponse<{ data: string }> = await this.http.post(
      `/nodes/${node}/qemu/${vmid}/status/${action}`,
      ""
    );
    return { node, upid: r.data.data };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface ClusterResource {
  vmid: number;
  node: string;
  name?: string;
  status?: string;
  template?: number;
  tags?: string;
  maxcpu?: number;
  maxmem?: number;
}

interface VMStatusResponse {
  name?: string;
  status?: string;
  cpus?: number;
  maxmem?: number;
  tags?: string;
}

interface VMConfigResponse {
  name?: string;
  template?: number;
  tags?: string;
  cores?: number;
  memory?: number;
}

function clusterResourceToVM(r: ClusterResource): VM {
  return {
    node: r.node,
    vmid: r.vmid,
    name: r.name ?? `vm-${r.vmid}`,
    status: mapStatus(r.status),
    template: r.template === 1,
    tags: parseTags(r.tags),
    cpus: r.maxcpu,
    maxmem: r.maxmem,
  };
}

function mapStatus(s?: string): VMStatus {
  switch (s) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    case "paused":
      return "paused";
    default:
      return "unknown";
  }
}

// Proxmox VE 7 used ";" as tag separator; VE 8 accepts both "," and ";".
// Be permissive when reading, but normalize on write.
export function parseTags(raw?: string): string[] {
  if (!raw) return [];
  return raw
    .split(/[;,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

export function serializeTags(tags: string[]): string {
  return tags.map((t) => t.trim()).filter((t) => t.length > 0).join(";");
}
