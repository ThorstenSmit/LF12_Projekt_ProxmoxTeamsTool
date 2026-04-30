import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/TeamsAuthProvider";
import {
  useBridgeApi,
  type ClassInfo,
  type Template,
  type VmDTO,
} from "../api/bridge";

type BulkAction = "start" | "shutdown" | "stop" | "delete";

function VmStatsPill({ vm }: { vm: VmDTO }) {
  if (vm.status !== "running") return null;
  const cpuPct = Math.round((vm.cpu ?? 0) * 100);
  const memUsedMb = vm.mem ? Math.round(vm.mem / 1024 / 1024) : 0;
  const memMaxMb = vm.maxmem ? Math.round(vm.maxmem / 1024 / 1024) : 0;
  const memPct = memMaxMb > 0 ? Math.round((memUsedMb / memMaxMb) * 100) : 0;
  const cpuTone = cpuPct > 85 ? "hot" : cpuPct > 60 ? "warm" : "";
  const memTone = memPct > 85 ? "hot" : memPct > 60 ? "warm" : "";
  return (
    <span className="stats-pill" title="CPU + RAM aus cluster/resources (current)">
      <span className={`pill-chip ${cpuTone}`}>CPU {cpuPct}%</span>
      <span className={`pill-chip ${memTone}`}>
        RAM {memUsedMb}/{memMaxMb} MB
      </span>
    </span>
  );
}

export function ClassesPage() {
  const { hasRole, isAuthenticated, accessToken } = useAuth();
  const api = useBridgeApi();
  const isStaff = hasRole("Proxmox.Admin") || hasRole("Proxmox.Teacher");

  const [classes, setClasses] = useState<ClassInfo[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [vms, setVms] = useState<VmDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [c, t, v] = await Promise.all([
        api.listClasses(),
        api.listTemplates(),
        api.listVms(),
      ]);
      setClasses(c);
      setTemplates(t);
      setVms(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    if (!accessToken) return;
    refresh();
  }, [accessToken, refresh]);

  // Auto-Refresh fuer Live-Stats wenn was laeuft.
  useEffect(() => {
    const anyRunning = vms.some((v) => v.status === "running");
    if (!anyRunning) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [vms, refresh]);

  if (!isAuthenticated) return <p>Bitte einloggen.</p>;
  if (!isStaff) {
    return (
      <section className="page">
        <p>Diese Seite ist nur fuer Lehrer und Admins.</p>
      </section>
    );
  }

  function templatesOf(oid: string): Template[] {
    return templates.filter((t) => t.classes.includes(oid));
  }
  function vmsOf(oid: string): VmDTO[] {
    const tplIds = new Set(templatesOf(oid).map((t) => t.vmid));
    return vms.filter(
      (v) => v.sourceTemplate && tplIds.has(v.sourceTemplate.vmid)
    );
  }

  async function bulk(classOid: string, action: BulkAction) {
    const targetVms = vmsOf(classOid);
    if (targetVms.length === 0) {
      setHint("Keine VMs in dieser Klasse.");
      return;
    }
    if (
      action === "delete" &&
      !confirm(`${targetVms.length} VM(s) in dieser Klasse wirklich loeschen?`)
    )
      return;
    if (
      action === "stop" &&
      !confirm(`${targetVms.length} VM(s) hart stoppen?`)
    )
      return;

    setBusy(`${classOid}:${action}`);
    setError(null);
    setHint(null);
    const callForAction = (vmid: number) => {
      if (action === "start") return api.startVm(vmid);
      if (action === "shutdown") return api.shutdownVm(vmid);
      if (action === "stop") return api.stopVm(vmid);
      return api.deleteVm(vmid);
    };
    const results = await Promise.allSettled(
      targetVms.map((v) => callForAction(v.vmid))
    );
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      setError(
        `${failed.length} von ${targetVms.length} VMs konnten nicht ${action}: ` +
          (failed[0] as PromiseRejectedResult).reason
      );
    } else {
      setHint(`${targetVms.length} VM(s): "${action}" ausgeloest.`);
    }
    setBusy(null);
    await refresh();
  }

  return (
    <section className="page">
      <header className="page-header">
        <h2>Klassen</h2>
        <p className="page-subtitle">
          Aktive Klassen verwalten — Templates der Klasse, VMs der Klasse und
          Sammel-Aktionen (Start / Shutdown / Stop / Loeschen).
        </p>
      </header>

      {error && <div className="card error">Fehler: {error}</div>}
      {hint && <div className="card hint">{hint}</div>}
      {classes === null && <div className="card">Lade Klassen ...</div>}

      {classes && classes.length === 0 && (
        <div className="card empty">
          <p>
            Du bist in keiner aktiven Klasse fuer dieses Tool. Sobald ein
            Template einer deiner Klassen-Groups zugewiesen wird, taucht sie
            hier auf.
          </p>
        </div>
      )}

      {classes && classes.length > 0 && (
        <ul className="card-list">
          {classes.map((c) => {
            const tpls = templatesOf(c.oid);
            const cvms = vmsOf(c.oid);
            const runningCount = cvms.filter((v) => v.status === "running").length;
            return (
              <li key={c.oid} className="card">
                <div className="card-row">
                  <strong>{c.displayName ?? "(unbekannt)"}</strong>
                  {c.visibility && <span className="badge">{c.visibility}</span>}
                  <span className="badge">
                    {tpls.length} Template{tpls.length === 1 ? "" : "s"}
                  </span>
                  <span className="badge">
                    {cvms.length} VM{cvms.length === 1 ? "" : "s"}
                    {runningCount > 0 ? ` · ${runningCount} running` : ""}
                  </span>
                </div>
                <div className="card-meta">
                  <span>OID {c.oid}</span>
                </div>
                {c.description && <p className="card-desc">{c.description}</p>}

                {tpls.length > 0 && (
                  <div className="card-edit">
                    <h4>Templates dieser Klasse</h4>
                    <ul className="inline-list">
                      {tpls.map((t) => (
                        <li key={t.vmid}>
                          <Link to={`/templates#template-${t.vmid}`}>
                            {t.name}
                          </Link>
                          <span className="muted"> (VMID {t.vmid})</span>
                          {t.isPublic && (
                            <span className="badge badge-public">public</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {cvms.length > 0 && (
                  <div className="card-edit">
                    <h4>VMs in dieser Klasse</h4>
                    <ul className="inline-list">
                      {cvms.map((v) => (
                        <li key={v.vmid}>
                          <Link to={`/my-vms#vm-${v.vmid}`}>{v.name}</Link>{" "}
                          <span className="muted">(VMID {v.vmid})</span>{" "}
                          <span className={`badge badge-${v.status}`}>
                            {v.status}
                          </span>
                          <VmStatsPill vm={v} />
                          {v.status === "running" && (
                            <Link
                              to={`/vms/${v.vmid}/console`}
                              title="Console oeffnen"
                              className="inline-icon-link"
                              aria-label="Console oeffnen"
                            >
                              🖥
                            </Link>
                          )}
                        </li>
                      ))}
                    </ul>
                    <div className="card-actions icon-actions">
                      <button
                        className="icon-button"
                        data-tooltip="Alle starten"
                        title="Alle starten"
                        aria-label="Alle starten"
                        disabled={
                          busy === `${c.oid}:start` ||
                          cvms.every((v) => v.status === "running")
                        }
                        onClick={() => bulk(c.oid, "start")}
                      >
                        ▶
                      </button>
                      <button
                        className="icon-button"
                        data-tooltip="Alle sauber herunterfahren"
                        title="Alle Shutdown"
                        aria-label="Alle Shutdown"
                        disabled={
                          busy === `${c.oid}:shutdown` || runningCount === 0
                        }
                        onClick={() => bulk(c.oid, "shutdown")}
                      >
                        ⏻
                      </button>
                      <button
                        className="icon-button"
                        data-tooltip="Alle hart stoppen"
                        title="Alle Stop (hart)"
                        aria-label="Alle Stop"
                        disabled={
                          busy === `${c.oid}:stop` || runningCount === 0
                        }
                        onClick={() => bulk(c.oid, "stop")}
                      >
                        ⏹
                      </button>
                      <button
                        className="icon-button danger"
                        data-tooltip="Alle loeschen"
                        title="Alle loeschen"
                        aria-label="Alle loeschen"
                        disabled={busy === `${c.oid}:delete`}
                        onClick={() => bulk(c.oid, "delete")}
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
