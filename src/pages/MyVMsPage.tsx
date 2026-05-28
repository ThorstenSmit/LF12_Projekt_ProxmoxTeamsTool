import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/authContext";
import { useRoleFlags } from "../auth/useRoleFlags";
import { useBridgeApi, type VmDTO } from "../api/bridge";
import { StatusBadge } from "../components/StatusBadge";
import { ErrorCard } from "../components/ErrorCard";
import { LoadingCard } from "../components/LoadingCard";
import { EmptyCard } from "../components/EmptyCard";
import { useVmAutoRefresh } from "../hooks/useVmAutoRefresh";
import { errMsg } from "../lib/errors";
import { bytesToMb } from "../lib/format";

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
  const { isAuthenticated, accessToken } = useAuth();
  const { isStudent } = useRoleFlags();
  const api = useBridgeApi();
  const navigate = useNavigate();

  const [vms, setVms] = useState<VmDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // Frisch erstellte VM (von der Vorlagen-Seite weitergereicht): bis sie in der
  // Liste auftaucht, zeigen wir einen Platzhalter + pollen eifrig. Klon + das
  // Tag-Finalize der Bridge brauchen ein paar Sekunden (siehe bridge/index.ts).
  const location = useLocation();
  const navState = location.state as
    | { pendingVmid?: number; pendingName?: string }
    | null;
  const [pendingVmid, setPendingVmid] = useState<number | null>(
    navState?.pendingVmid ?? null
  );
  const pendingName = navState?.pendingName ?? null;
  const [pendingDeadline] = useState(() => Date.now() + 150_000);

  // Abgeleitet: Platzhalter zeigen, solange die erstellte VMID noch nicht in der
  // Liste ist. Sobald sie auftaucht, wird das automatisch false (kein State-Clear
  // nötig) — das steuert Placeholder, Cadence (eager) und den Abbruch-Timeout.
  const showPending =
    pendingVmid != null && !(vms ?? []).some((v) => v.vmid === pendingVmid);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setVms(await api.listVms());
    } catch (e) {
      setError(errMsg(e));
    }
  }, [api]);

  useEffect(() => {
    if (!accessToken) return;
    void (async () => {
      await refresh();
    })();
  }, [accessToken, refresh]);

  // Auto-Refresh: läuft was oder steht ein Klon aus -> schnell (Live-Stats),
  // sonst ruhiger — aber immer, damit neue/gestoppte VMs ohne Reload auftauchen.
  useVmAutoRefresh(vms, refresh, { eager: showPending });

  // Abbruch-Deadline für den ausstehenden Klon: taucht die VM nicht auf, Hinweis
  // zeigen + Platzhalter beenden. setState nur im Timeout-Callback (nicht synchron
  // im Effekt-Body). Erscheint die VM, wird showPending false -> Cleanup räumt den
  // Timeout ab, bevor er feuert.
  useEffect(() => {
    if (!showPending) return;
    const t = setTimeout(() => {
      setPendingVmid(null);
      setError(
        "Die neue VM ist nicht aufgetaucht — bitte Seite neu laden oder in Proxmox prüfen."
      );
    }, Math.max(0, pendingDeadline - Date.now()));
    return () => clearTimeout(t);
  }, [showPending, pendingDeadline]);

  if (!isAuthenticated) return <p>Bitte einloggen.</p>;

  async function run(
    vm: VmDTO,
    action: "start" | "shutdown" | "stop" | "delete"
  ) {
    if (action === "delete" && !confirm(`VM "${vm.name}" wirklich löschen?`)) return;
    if (action === "stop" && !confirm(`VM "${vm.name}" hart stoppen (Strom trennen)?`)) return;
    setBusyId(vm.vmid);
    setError(null);
    try {
      if (action === "start") await api.startVm(vm.vmid);
      else if (action === "shutdown") await api.shutdownVm(vm.vmid);
      else if (action === "stop") await api.stopVm(vm.vmid);
      else await api.deleteVm(vm.vmid);
      await refresh();
    } catch (e) {
      setError(errMsg(e));
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
            ? "Deine eigenen VMs, eine pro zugewiesener Vorlage."
            : "Schüler-VMs aus den Klassen, die du betreust."}
        </p>
      </header>

      <ErrorCard message={error} />

      {showPending && (
        <div className="card hint">
          <div className="card-row">
            <strong>{pendingName ?? `VM ${pendingVmid}`}</strong>
            <span className="badge">VMID {pendingVmid}</span>
            <span className="badge">wird erstellt …</span>
          </div>
          <p className="muted">
            Klon läuft und wird konfiguriert — die VM erscheint gleich automatisch.
          </p>
        </div>
      )}

      {vms === null && !showPending && <LoadingCard label="Lade VMs ..." />}

      {vms && vms.length === 0 && !showPending && (
        <EmptyCard>
          <p>
            Aktuell keine VMs in deinem Sichtbereich. {isStudent
              ? "Klick auf der Vorlagen-Seite auf \"VM aus dieser Vorlage anlegen\"."
              : "Schüler in deinen Klassen haben noch keine VMs erstellt."}
          </p>
        </EmptyCard>
      )}

      {vms && vms.length > 0 && (
        <ul className="card-list">
          {vms.map((v) => (
            <li key={v.vmid} id={`vm-${v.vmid}`} className="card">
              <div className="card-row">
                <strong>{v.name}</strong>
                <span className="badge">VMID {v.vmid}</span>
                <StatusBadge status={v.status} />
              </div>
              <div className="card-meta">
                {v.sourceTemplate && (
                  <span>
                    aus Vorlage{" "}
                    <Link to={`/templates#template-${v.sourceTemplate.vmid}`}>
                      {v.sourceTemplate.name ?? `VMID ${v.sourceTemplate.vmid}`}
                    </Link>
                  </span>
                )}
                <span>{v.cpus ?? "?"} vCPU</span>
                <span>{v.maxmem ? bytesToMb(v.maxmem) + " MB" : "? MB"}</span>
                <span>Knoten {v.node}</span>
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
                  aria-label="Herunterfahren"
                  title="Sauberes Herunterfahren (Guest-Agent)"
                  data-tooltip="Sauber herunterfahren"
                  disabled={busyId === v.vmid || v.status !== "running"}
                  onClick={() => run(v, "shutdown")}
                >
                  ⏻
                </button>
                <button
                  className="icon-button"
                  aria-label="Stopp (hart)"
                  title="Hart stoppen — Strom trennen"
                  data-tooltip="Hart stoppen"
                  disabled={busyId === v.vmid || v.status === "stopped"}
                  onClick={() => run(v, "stop")}
                >
                  ⏹
                </button>
                <button
                  className="icon-button"
                  aria-label="Konsole"
                  title="VNC-Konsole öffnen"
                  data-tooltip="Konsole öffnen"
                  disabled={busyId === v.vmid || v.status !== "running"}
                  onClick={() => openConsole(v)}
                >
                  🖥
                </button>
                <button
                  className="icon-button danger"
                  aria-label="Löschen"
                  title="Löschen"
                  data-tooltip="Löschen"
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
