// Domain types for talking to Proxmox VE.
//
// Tags are plain comma-separated strings on the Proxmox side. We model them
// as a string[] here and the client implementation handles the join/split.

export type VMID = number;

export interface VMRef {
  node: string;
  vmid: VMID;
}

export type VMStatus = "running" | "stopped" | "paused" | "unknown";

export interface VM extends VMRef {
  name: string;
  status: VMStatus;
  template: boolean;
  tags: string[];
  cpus?: number;
  maxmem?: number;
  // Live-Stats aus cluster/resources — nur fuer running VMs sinnvoll.
  cpu?: number;       // Auslastung 0..1 (1.0 == alle vCPUs voll)
  mem?: number;       // belegter Arbeitsspeicher in Bytes
  uptime?: number;    // Sekunden seit Start
  disk?: number;      // belegte Disk
  maxdisk?: number;
  diskread?: number;
  diskwrite?: number;
  netin?: number;
  netout?: number;
}

export interface VMConfig {
  name?: string;
  tags?: string[];
  cores?: number;
  memory?: number;
}

export interface CloneOptions {
  newid: VMID;
  name: string;
  target?: string;
  full?: boolean;
}

// Proxmox task identifier (UPID). Async operations return one of these; the
// caller can poll getTask() to learn when it's done.
export interface TaskRef {
  node: string;
  upid: string;
}

export type TaskStatus = "running" | "stopped";

export interface Task {
  node: string;
  upid: string;
  status: TaskStatus;
  exitstatus?: string;
}
