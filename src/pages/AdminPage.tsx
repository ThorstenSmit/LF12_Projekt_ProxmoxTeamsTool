import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/TeamsAuthProvider";
import {
  useBridgeApi,
  type Template,
  type VmDTO,
  type ClassInfo,
} from "../api/bridge";

function VmStatsPill({ vm }: { vm: VmDTO }) {
  if (vm.status !== "running") return null;
  const cpuPct = Math.round((vm.cpu ?? 0) * 100);
  const memUsedMb = vm.mem ? Math.round(vm.mem / 1024 / 1024) : 0;
  const memMaxMb = vm.maxmem ? Math.round(vm.maxmem / 1024 / 1024) : 0;
  const memPct = memMaxMb > 0 ? Math.round((memUsedMb / memMaxMb) * 100) : 0;
  return (
    <span className="stats-pill">
      <span className={`pill-chip ${cpuPct > 85 ? "hot" : cpuPct > 60 ? "warm" : ""}`}>
        CPU {cpuPct}%
      </span>
      <span className={`pill-chip ${memPct > 85 ? "hot" : memPct > 60 ? "warm" : ""}`}>
        RAM {memUsedMb}/{memMaxMb} MB
      </span>
    </span>
  );
}

export function AdminPage() {
  const { hasRole, isAuthenticated, accessToken } = useAuth();
  const api = useBridgeApi();

  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [vms, setVms] = useState<VmDTO[] | null>(null);
  const [classes, setClasses] = useState<ClassInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [t, v, c] = await Promise.all([
        api.listTemplates(),
        api.listVms(),
        api.listClasses(),
      ]);
      setTemplates(t);
      setVms(v);
      setClasses(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    if (!accessToken) return;
    refresh();
  }, [accessToken, refresh]);

  useEffect(() => {
    const anyRunning = vms?.some((v) => v.status === "running");
    if (!anyRunning) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [vms, refresh]);

  if (!isAuthenticated) return <p>Bitte einloggen.</p>;
  if (!hasRole("Proxmox.Admin")) {
    return (
      <section className="page">
        <p>Diese Seite ist nur fuer Admins.</p>
      </section>
    );
  }

  return (
    <section className="page">
      <header className="page-header">
        <h2>Admin Console</h2>
        <p className="page-subtitle">Globale Sicht ueber alle Templates, VMs und Klassen.</p>
      </header>

      {error && <div className="card error">Fehler: {error}</div>}

      <div className="admin-grid">
        <div className="card">
          <h3>Templates ({templates?.length ?? "—"})</h3>
          <ul>
            {templates?.map((t) => (
              <li key={t.vmid}>
                <strong>{t.name}</strong> (VMID {t.vmid})
                {t.isPublic && <span className="badge badge-public">public</span>}
                <br />
                <small>{t.classes.length} Klassen, Owner {t.ownerOid?.slice(0, 8) ?? "—"}</small>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3>VMs ({vms?.length ?? "—"})</h3>
          <ul>
            {vms?.map((v) => (
              <li key={v.vmid}>
                <Link to={`/my-vms#vm-${v.vmid}`}>
                  <strong>{v.name}</strong>
                </Link>{" "}
                (VMID {v.vmid})
                <span className={`badge badge-${v.status}`}>{v.status}</span>
                {v.status === "running" && (
                  <Link
                    to={`/vms/${v.vmid}/console`}
                    title="Console"
                    className="inline-icon-link"
                  >
                    🖥
                  </Link>
                )}
                <br />
                <small>
                  Owner {v.ownerOid?.slice(0, 8) ?? "—"} · aus Template{" "}
                  {v.sourceTemplate
                    ? v.sourceTemplate.name ?? `VMID ${v.sourceTemplate.vmid}`
                    : "—"}
                </small>
                <br />
                <VmStatsPill vm={v} />
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h3>Aktive Klassen ({classes?.length ?? "—"})</h3>
          <ul>
            {classes?.map((c) => (
              <li key={c.oid}>
                <strong>{c.displayName ?? "(unbekannt)"}</strong>
                <br />
                <small>{c.oid}</small>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
