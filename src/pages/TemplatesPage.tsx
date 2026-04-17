import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../auth/TeamsAuthProvider";
import { useBridgeApi, type Template } from "../api/bridge";

export function TemplatesPage() {
  const { hasRole, isAuthenticated, accessToken } = useAuth();
  const api = useBridgeApi();
  const isStudent = hasRole("Proxmox.Student");

  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      setTemplates(await api.listTemplates());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [api]);

  useEffect(() => {
    if (!accessToken) return;
    refresh();
  }, [accessToken, refresh]);

  if (!isAuthenticated) return <p>Bitte einloggen.</p>;

  async function instantiate(t: Template) {
    setBusyId(t.vmid);
    setError(null);
    setHint(null);
    try {
      const res = await api.createVmFromTemplate(t.vmid);
      setHint(
        `Klon-Task fuer VMID ${res.newVmid} an Proxmox uebergeben (UPID ${res.task.upid}). VM-Liste aktualisieren um den Stand zu sehen.`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="page">
      <header className="page-header">
        <h2>Templates</h2>
        <p className="page-subtitle">
          {isStudent
            ? "Templates, die dir ueber deine Klasse(n) zugewiesen wurden."
            : "Templates, die du erstellt oder zugewiesen bekommen hast."}
        </p>
      </header>

      {error && <div className="card error">Fehler: {error}</div>}
      {hint && <div className="card hint">{hint}</div>}

      {templates === null && <div className="card">Lade Templates ...</div>}

      {templates && templates.length === 0 && (
        <div className="card empty">
          <p>
            Keine Templates in deinem Sichtbereich. {isStudent
              ? "Sobald ein Lehrer ein Template fuer deine Klasse freigibt, taucht es hier auf."
              : "Lege ein Template in Proxmox an und tag es mit `pttool-tpl`, `tpl-owner-<deine-oid>` und einem `tpl-class-<group-oid>`."}
          </p>
        </div>
      )}

      {templates && templates.length > 0 && (
        <ul className="card-list">
          {templates.map((t) => (
            <li
              key={t.vmid}
              id={`template-${t.vmid}`}
              className="card"
            >
              <div className="card-row">
                <strong>{t.name}</strong>
                <span className="badge">VMID {t.vmid}</span>
                {t.isPublic && <span className="badge badge-public">public</span>}
              </div>
              <div className="card-meta">
                <span>Klassen: {t.classes.length === 0 ? "—" : t.classes.length}</span>
                <span>Node: {t.node}</span>
              </div>
              {isStudent && (
                <div className="card-actions">
                  <button
                    onClick={() => instantiate(t)}
                    disabled={busyId === t.vmid}
                  >
                    {busyId === t.vmid ? "Erstelle..." : "VM aus diesem Template anlegen"}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
