import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/authContext";
import { useRoleFlags } from "../auth/useRoleFlags";
import {
  useBridgeApi,
  type ClassInfo,
  type Template,
} from "../api/bridge";
import { ErrorCard } from "../components/ErrorCard";
import { LoadingCard } from "../components/LoadingCard";
import { EmptyCard } from "../components/EmptyCard";
import { errMsg } from "../lib/errors";
import { shortOid } from "../lib/format";

export function TemplatesPage() {
  const { isAuthenticated, accessToken, identity } = useAuth();
  const { isStudent, isAdmin, isStaff: canManage } = useRoleFlags();
  const api = useBridgeApi();
  const navigate = useNavigate();

  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [assignable, setAssignable] = useState<ClassInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const list = await api.listTemplates();
      setTemplates(list);
    } catch (e) {
      setError(errMsg(e));
    }
  }, [api]);

  useEffect(() => {
    if (!accessToken) return;
    void (async () => {
      await refresh();
    })();
    if (canManage) {
      api.listAssignableClasses().then(setAssignable).catch(() => setAssignable([]));
    }
  }, [accessToken, refresh, canManage, api]);

  if (!isAuthenticated) return <p>Bitte einloggen.</p>;

  async function withBusy<T>(vmid: number, op: () => Promise<T>) {
    setBusyId(vmid);
    setError(null);
    setHint(null);
    try {
      return await op();
    } catch (e) {
      setError(errMsg(e));
      throw e;
    } finally {
      setBusyId(null);
    }
  }

  async function instantiate(t: Template) {
    await withBusy(t.vmid, async () => {
      const res = await api.createVmFromTemplate(t.vmid);
      // Auf "Meine VMs" wechseln und die neue VMID mitgeben — dort wird sie als
      // "wird erstellt …" angezeigt und gepollt, bis der Klon + das Tag-Finalize
      // der Bridge durch sind und sie in /api/vms auftaucht.
      navigate("/my-vms", {
        state: { pendingVmid: res.newVmid, pendingName: t.name },
      });
    });
  }

  async function claim(t: Template) {
    await withBusy(t.vmid, async () => {
      await api.claimTemplate(t.vmid);
      await refresh();
    });
  }

  async function release(t: Template) {
    if (!confirm(`Vorlage "${t.name}" freigeben? Sie kann danach wieder übernommen werden.`)) return;
    await withBusy(t.vmid, async () => {
      await api.releaseTemplate(t.vmid);
      await refresh();
    });
  }

  async function togglePublic(t: Template) {
    await withBusy(t.vmid, async () => {
      await api.updateTemplate(t.vmid, { isPublic: !t.isPublic });
      await refresh();
    });
  }

  async function toggleClass(t: Template, oid: string) {
    const newClasses = t.classes.includes(oid)
      ? t.classes.filter((c) => c !== oid)
      : [...t.classes, oid];
    await withBusy(t.vmid, async () => {
      await api.updateTemplate(t.vmid, { classes: newClasses });
      await refresh();
    });
  }

  return (
    <section className="page">
      <header className="page-header">
        <h2>Vorlagen</h2>
        <p className="page-subtitle">
          {isStudent
            ? "Vorlagen, die dir über deine Klasse(n) zugewiesen wurden."
            : "Vorlagen verwalten — Besitzer, öffentliche Freigabe und Klassen-Zuweisung."}
        </p>
      </header>

      <ErrorCard message={error} />
      {hint && <div className="card hint">{hint}</div>}

      {templates === null && <LoadingCard label="Lade Vorlagen ..." />}

      {templates && templates.length === 0 && (
        <EmptyCard>
          <p>
            Keine Vorlagen in deinem Sichtbereich.{" "}
            {isStudent
              ? "Sobald ein Lehrer eine Vorlage für deine Klasse freigibt, taucht sie hier auf."
              : "Lege eine Vorlage in Proxmox an und markiere sie mit pttool-tpl."}
          </p>
        </EmptyCard>
      )}

      {templates && templates.length > 0 && (
        <ul className="card-list">
          {templates.map((t) => {
            // "isOwn" nur, wenn der Benutzer auch verwalten darf -- sonst zeigen
            // wir einem Schüler, der zufällig die gleiche OID wie der Besitzer
            // hat (oder in Impersonation-Demos), keine Edit-Buttons.
            const isOwn = !!t.ownerOid && identity?.oid === t.ownerOid && canManage;
            // Edit-Buttons (öffentlich / Klassen / Freigeben) brauchen einen Besitzer,
            // sonst gibt's nichts freizugeben und Freigaben/Klassen-Setzen wäre
            // eine verdeckte Übernahme. Solange nicht zugewiesen, ist die einzige
            // sinnvolle Aktion "Mir zuweisen".
            const canEdit = !!t.ownerOid && (isAdmin || isOwn);
            const editing = editingId === t.vmid;
            return (
              <li key={t.vmid} id={`template-${t.vmid}`} className="card">
                <div className="card-row">
                  <strong>{t.name}</strong>
                  <span className="badge">VMID {t.vmid}</span>
                  {t.isPublic && (
                    <span className="badge badge-public">öffentlich</span>
                  )}
                  {!t.ownerOid && (
                    <span className="badge badge-unclaimed">nicht zugewiesen</span>
                  )}
                  {isOwn && <span className="badge badge-own">deine Vorlage</span>}
                </div>
                <div className="card-meta">
                  <span>Klassen: {t.classes.length}</span>
                  <span>Knoten: {t.node}</span>
                  {t.ownerOid && !isOwn && (
                    <span>Besitzer: {shortOid(t.ownerOid)}…</span>
                  )}
                </div>

                <div className="card-actions icon-actions">
                  <button
                    className="icon-button"
                    aria-label="VM aus dieser Vorlage erstellen"
                    data-tooltip={
                      isStudent
                        ? "VM aus dieser Vorlage erstellen (max. eine pro Vorlage)"
                        : "VM aus dieser Vorlage erstellen (Test/Demo)"
                    }
                    title="VM aus dieser Vorlage erstellen"
                    onClick={() => instantiate(t)}
                    disabled={busyId === t.vmid}
                  >
                    {busyId === t.vmid ? "…" : "➕"}
                  </button>

                  {canManage && !t.ownerOid && (
                    <button
                      className="icon-button wide"
                      aria-label="Mir zuweisen"
                      data-tooltip="Mir zuweisen (Besitzer werden)"
                      title="Mir zuweisen"
                      onClick={() => claim(t)}
                      disabled={busyId === t.vmid}
                    >
                      Mir zuweisen
                    </button>
                  )}

                  {canEdit && (
                    <>
                      <button
                        className={`icon-button ${t.isPublic ? "active" : ""}`}
                        aria-label="Öffentliche Freigabe umschalten"
                        data-tooltip={t.isPublic ? "Öffentliche Freigabe entfernen" : "Öffentlich freigeben"}
                        title="Öffentliche Freigabe"
                        onClick={() => togglePublic(t)}
                        disabled={busyId === t.vmid}
                      >
                        🌐
                      </button>
                      <button
                        className={`icon-button ${editing ? "active" : ""}`}
                        aria-label="Klassen zuweisen"
                        data-tooltip="Klassen zuweisen"
                        title="Klassen zuweisen"
                        onClick={() => setEditingId(editing ? null : t.vmid)}
                        disabled={busyId === t.vmid}
                      >
                        🏷
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Freigeben"
                        data-tooltip="Freigeben (kein Besitzer mehr)"
                        title="Freigeben"
                        onClick={() => release(t)}
                        disabled={busyId === t.vmid}
                      >
                        🪄
                      </button>
                    </>
                  )}
                </div>

                {canEdit && editing && (
                  <div className="card-edit">
                    <h4>Klassen-Zuweisung</h4>
                    {assignable === null && <p>Lade Klassen ...</p>}
                    {assignable && assignable.length === 0 && (
                      <p className="muted">
                        Du bist in keiner M365-Gruppe, die du als Klasse zuweisen könntest.
                      </p>
                    )}
                    {assignable && assignable.length > 0 && (
                      <ul className="class-picker">
                        {assignable.map((c) => (
                          <li key={c.oid}>
                            <label>
                              <input
                                type="checkbox"
                                checked={t.classes.includes(c.oid)}
                                onChange={() => toggleClass(t, c.oid)}
                                disabled={busyId === t.vmid}
                              />
                              {c.displayName ?? c.oid}
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
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
