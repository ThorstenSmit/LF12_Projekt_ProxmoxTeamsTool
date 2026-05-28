import { Link } from "react-router-dom";

// Catch-all fuer nicht existierende Routen — sonst landet eine Falsch-URL in
// einer leeren App-Huelle (Header ohne Inhalt).
export function NotFoundPage() {
  return (
    <section className="page">
      <header className="page-header">
        <h2>404 — Seite nicht gefunden</h2>
        <p className="page-subtitle">
          Diese Seite gibt es nicht (oder sie läuft auf einer anderen VM 😉).
        </p>
      </header>
      <div className="card">
        <p>
          <Link to="/">← Zurück zur Übersicht</Link>
        </p>
      </div>
    </section>
  );
}
