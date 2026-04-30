import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/TeamsAuthProvider";
import { UserProfile } from "../components/UserProfile";
import {
  useBridgeApi,
  type ClassInfo,
  type Template,
  type VmDTO,
} from "../api/bridge";

function VmStatsPill({ vm }: { vm: VmDTO }) {
  if (vm.status !== "running") return null;
  const cpu = vm.cpuAvg5m ?? vm.cpu ?? 0;
  const mem = vm.memAvg5m ?? vm.mem ?? 0;
  const cpuPct = Math.round(cpu * 100);
  const memUsedMb = Math.round(mem / 1024 / 1024);
  const memMaxMb = vm.maxmem ? Math.round(vm.maxmem / 1024 / 1024) : 0;
  const memPct = memMaxMb > 0 ? Math.round((memUsedMb / memMaxMb) * 100) : 0;
  return (
    <span className="stats-pill">
      <span className={`pill-chip ${cpuPct > 85 ? "hot" : cpuPct > 60 ? "warm" : ""}`}>
        CPU {cpuPct}% Ø5m
      </span>
      <span className={`pill-chip ${memPct > 85 ? "hot" : memPct > 60 ? "warm" : ""}`}>
        RAM {memUsedMb}/{memMaxMb} MB Ø5m
      </span>
    </span>
  );
}

export function HomePage() {
  const { isAuthenticated, hasRole, roles, accessToken, identity } = useAuth();
  const api = useBridgeApi();
  const isAdmin = hasRole("Proxmox.Admin");
  const isTeacher = hasRole("Proxmox.Teacher");
  const isStudent = hasRole("Proxmox.Student");
  const hasAnyRole = roles.length > 0;

  const [classes, setClasses] = useState<ClassInfo[] | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [vms, setVms] = useState<VmDTO[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!hasAnyRole) return;
    setError(null);
    try {
      const wantsClasses = isAdmin || isTeacher || isStudent;
      const [c, t, v] = await Promise.all([
        wantsClasses ? api.listClasses() : Promise.resolve([]),
        api.listTemplates().catch(() => []),
        api.listVms().catch(() => []),
      ]);
      setClasses(c);
      setTemplates(t);
      setVms(v);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api, hasAnyRole, isAdmin, isTeacher, isStudent]);

  useEffect(() => {
    if (!accessToken) return;
    refresh();
  }, [accessToken, refresh]);

  useEffect(() => {
    const anyRunning = vms.some((v) => v.status === "running");
    if (!anyRunning) return;
    const id = setInterval(refresh, 5000);
    return () => clearInterval(id);
  }, [vms, refresh]);

  const ownedTemplates = identity
    ? templates.filter((t) => t.ownerOid === identity.oid)
    : [];

  return (
    <>
      <UserProfile />

      {isAuthenticated && !hasAnyRole && (
        <div className="card warning">
          <h3>Keine Rolle zugewiesen</h3>
          <p>
            Du bist eingeloggt, hast aber noch keine Rolle. Ein Admin muss dir
            eine Rolle zuweisen (Proxmox.Student, Proxmox.Teacher oder
            Proxmox.Admin).
          </p>
        </div>
      )}

      {error && <div className="card error">Fehler: {error}</div>}

      {/* Admin: 3-Spalten-Overview wie /admin */}
      {isAdmin && (
        <div className="admin-grid">
          <div className="card">
            <h3>
              Templates ({templates.length}){" "}
              <Link to="/templates" className="card-section-link">
                verwalten →
              </Link>
            </h3>
            <ul>
              {templates.map((t) => (
                <li key={t.vmid}>
                  <Link to={`/templates#template-${t.vmid}`}>
                    <strong>{t.name}</strong>
                  </Link>{" "}
                  <span className="muted">(VMID {t.vmid})</span>
                  {t.isPublic && (
                    <span className="badge badge-public">public</span>
                  )}
                  <br />
                  <small className="muted">
                    {t.classes.length} Klasse(n) · Owner{" "}
                    {t.ownerOid?.slice(0, 8) ?? "—"}
                  </small>
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h3>
              VMs ({vms.length}){" "}
              <Link to="/my-vms" className="card-section-link">
                verwalten →
              </Link>
            </h3>
            <ul>
              {vms.map((v) => (
                <li key={v.vmid}>
                  <Link to={`/my-vms#vm-${v.vmid}`}>
                    <strong>{v.name}</strong>
                  </Link>{" "}
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
                  <VmStatsPill vm={v} />
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <h3>
              Aktive Klassen ({classes?.length ?? "—"}){" "}
              <Link to="/classes" className="card-section-link">
                verwalten →
              </Link>
            </h3>
            <ul>
              {classes?.map((c) => (
                <li key={c.oid}>
                  <strong>{c.displayName ?? "(unbekannt)"}</strong>
                  <br />
                  <small className="muted">{c.oid}</small>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Lehrer: Klassen + eigene Templates */}
      {isTeacher && !isAdmin && (
        <>
          <Link to="/classes" className="card card-link">
            <h3>Klassen ({classes?.length ?? "—"})</h3>
            {classes && classes.length > 0 ? (
              <ul className="home-inline">
                {classes.map((c) => (
                  <li key={c.oid}>{c.displayName ?? c.oid}</li>
                ))}
              </ul>
            ) : (
              <p>Noch keine aktiven Klassen — weise einem deiner Templates eine Klasse zu.</p>
            )}
          </Link>

          <Link to="/templates" className="card card-link">
            <h3>Deine Templates ({ownedTemplates.length})</h3>
            {ownedTemplates.length > 0 ? (
              <ul className="home-inline">
                {ownedTemplates.map((t) => (
                  <li key={t.vmid}>
                    {t.name}
                    {t.isPublic && (
                      <span className="badge badge-public">public</span>
                    )}{" "}
                    <span className="muted">· {t.classes.length} Klasse(n)</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                Du hast noch keine Templates uebernommen. In der Templates-Seite
                kannst du ungeclaimte Templates per <strong>Mir zuweisen</strong>{" "}
                claimen.
              </p>
            )}
          </Link>
        </>
      )}

      {/* Schueler: Klassen + verfuegbare Templates + eigene VMs */}
      {isStudent && !isAdmin && !isTeacher && (
        <>
          <Link to="/classes" className="card card-link">
            <h3>Deine Klassen ({classes?.length ?? "—"})</h3>
            {classes && classes.length > 0 ? (
              <ul className="home-inline">
                {classes.map((c) => (
                  <li key={c.oid}>{c.displayName ?? c.oid}</li>
                ))}
              </ul>
            ) : (
              <p>Du bist (noch) in keiner aktiven Klasse fuer dieses Tool.</p>
            )}
          </Link>

          <Link to="/templates" className="card card-link">
            <h3>Verfuegbare Templates ({templates.length})</h3>
            {templates.length > 0 ? (
              <ul className="home-inline">
                {templates.map((t) => (
                  <li key={t.vmid}>
                    <strong>{t.name}</strong>
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                Aktuell keine Templates fuer deine Klasse(n) — sobald ein
                Lehrer eines freigibt, taucht es hier auf.
              </p>
            )}
          </Link>

          <Link to="/my-vms" className="card card-link">
            <h3>Meine VMs ({vms.length})</h3>
            {vms.length > 0 ? (
              <ul className="home-inline">
                {vms.map((v) => (
                  <li key={v.vmid}>
                    <strong>{v.name}</strong>{" "}
                    <span className={`badge badge-${v.status}`}>
                      {v.status}
                    </span>
                    <VmStatsPill vm={v} />
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                Noch keine eigenen VMs. Klick auf der Templates-Seite auf{" "}
                <strong>+</strong>, um eine VM aus einem Template zu erstellen.
              </p>
            )}
          </Link>
        </>
      )}
    </>
  );
}
