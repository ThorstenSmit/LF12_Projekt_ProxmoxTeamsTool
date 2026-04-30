import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/TeamsAuthProvider";
import { useBridgeApi, type VmDTO } from "../api/bridge";

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

interface GaugeProps {
  label: string;
  value: number;
  max: number;
  suffix?: string;
  fraction?: boolean;
}
function Gauge({ label, value, max, suffix = "", fraction = false }: GaugeProps) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const display = fraction
    ? `${Math.round(value)}${suffix} / ${Math.round(max)}${suffix}`
    : `${Math.round(value)}${suffix}`;
  return (
    <div className="gauge">
      <div className="gauge-label">{label}</div>
      <div className="gauge-bar">
        <div
          className={`gauge-fill ${pct > 85 ? "hot" : pct > 60 ? "warm" : ""}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="gauge-value">{display}</div>
    </div>
  );
}

export function MyVMsPage() {
  const { hasRole, isAuthenticated, accessToken } = useAuth();
  const api = useBridgeApi();
  const navigate = useNavigate();
  const isStudent = hasRole("Proxmox.Student");

  const [vms, setVms] = useState<VmDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setVms(await api.listVms());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    if (!accessToken) return;
    refresh();
  }, [accessToken, refresh]);

  // Auto-Refresh fuer Live-Stats: wenn mindestens eine VM laeuft, alle 5 s.
  useEffect(() => {
    const anyRunning = vms?.some((v) => v.status === "running");
    if (!anyRunning) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [vms, refresh]);

  if (!isAuthenticated) return <p>Bitte einloggen.</p>;

  async function run(
    vm: VmDTO,
    action: "start" | "shutdown" | "stop" | "delete"
  ) {
    if (action === "delete" && !confirm(`VM "${vm.name}" wirklich loeschen?`)) return;
    if (action === "stop" && !confirm(`VM "${vm.name}" hart stoppen (Plug pull)?`)) return;
    setBusyId(vm.vmid);
    setError(null);
    try {
      if (action === "start") await api.startVm(vm.vmid);
      else if (action === "shutdown") await api.shutdownVm(vm.vmid);
      else if (action === "stop") await api.stopVm(vm.vmid);
      else await api.deleteVm(vm.vmid);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  function openConsole(vm: VmDTO) {
    navigate(`/vms/${vm.vmid}/console`);
  }

  return (
    <section className="page">
      <header className="page-header">
        <h2>{isStudent ? "Meine VMs" : "VMs deiner Klassen"}</h2>
        <p className="page-subtitle">
          {isStudent
            ? "Deine eigenen VMs, eine pro zugewiesenem Template."
            : "Schueler-VMs aus den Klassen, die du betreust."}
        </p>
      </header>

      {error && <div className="card error">Fehler: {error}</div>}
      {vms === null && <div className="card">Lade VMs ...</div>}

      {vms && vms.length === 0 && (
        <div className="card empty">
          <p>
            Aktuell keine VMs in deinem Sichtbereich. {isStudent
              ? "Klick auf der Templates-Seite auf \"VM aus diesem Template anlegen\"."
              : "Schueler in deinen Klassen haben noch keine VMs erstellt."}
          </p>
        </div>
      )}

      {vms && vms.length > 0 && (
        <ul className="card-list">
          {vms.map((v) => (
            <li key={v.vmid} className="card">
              <div className="card-row">
                <strong>{v.name}</strong>
                <span className="badge">VMID {v.vmid}</span>
                <span className={`badge badge-${v.status}`}>{v.status}</span>
              </div>
              <div className="card-meta">
                {v.sourceTemplate && (
                  <span>
                    aus Template{" "}
                    <Link to={`/templates#template-${v.sourceTemplate.vmid}`}>
                      {v.sourceTemplate.name ?? `VMID ${v.sourceTemplate.vmid}`}
                    </Link>
                  </span>
                )}
                <span>{v.cpus ?? "?"} vCPU</span>
                <span>{v.maxmem ? Math.round(v.maxmem / 1024 / 1024) + " MB" : "? MB"}</span>
                <span>Node {v.node}</span>
                {v.uptime !== undefined && v.uptime > 0 && (
                  <span title="Laufzeit seit letztem Start">
                    ⏱ {formatUptime(v.uptime)}
                  </span>
                )}
              </div>
              {v.status === "running" && (
                <div className="vm-stats">
                  <Gauge
                    label="CPU"
                    value={(v.cpu ?? 0) * 100}
                    max={100}
                    suffix="%"
                  />
                  <Gauge
                    label="RAM"
                    value={v.mem ? v.mem / 1024 / 1024 : 0}
                    max={v.maxmem ? v.maxmem / 1024 / 1024 : 0}
                    suffix=" MB"
                    fraction
                  />
                </div>
              )}
              <div className="card-actions icon-actions">
                <button
                  className="icon-button"
                  aria-label="Start"
                  title="Start"
                  data-tooltip="Starten"
                  disabled={busyId === v.vmid || v.status === "running"}
                  onClick={() => run(v, "start")}
                >
                  ▶
                </button>
                <button
                  className="icon-button"
                  aria-label="Shutdown"
                  title="Sauberes Herunterfahren (Guest-Agent)"
                  data-tooltip="Sauber herunterfahren"
                  disabled={busyId === v.vmid || v.status !== "running"}
                  onClick={() => run(v, "shutdown")}
                >
                  ⏻
                </button>
                <button
                  className="icon-button"
                  aria-label="Stop (hart)"
                  title="Hart stoppen — Plug pull"
                  data-tooltip="Hart stoppen"
                  disabled={busyId === v.vmid || v.status === "stopped"}
                  onClick={() => run(v, "stop")}
                >
                  ⏹
                </button>
                <button
                  className="icon-button"
                  aria-label="Console"
                  title="VNC-Console oeffnen"
                  data-tooltip="Console oeffnen"
                  disabled={busyId === v.vmid || v.status !== "running"}
                  onClick={() => openConsole(v)}
                >
                  🖥
                </button>
                <button
                  className="icon-button danger"
                  aria-label="Loeschen"
                  title="Loeschen"
                  data-tooltip="Loeschen"
                  disabled={busyId === v.vmid}
                  onClick={() => run(v, "delete")}
                >
                  🗑
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
