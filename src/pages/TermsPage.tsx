import { Link } from "react-router-dom";

// Platzhalter-Seite fuer die im Teams-Manifest referenzierte termsOfUseUrl
// (/terms). Kein rechtsverbindliches Dokument.
export function TermsPage() {
  return (
    <section className="page">
      <header className="page-header">
        <h2>Nutzungsbedingungen</h2>
        <p className="page-subtitle">
          Ebenfalls ein Platzhalter — kein rechtsverbindliches Dokument.
        </p>
      </header>
      <div className="card">
        <p>Auch dies ist ein Schulprojekt. Die Hausregeln:</p>
        <ul>
          <li>Sei nett zu den VMs.</li>
          <li>Lösch nicht die VMs deiner Mitschüler:innen.</li>
          <li>Wenn etwas kaputtgeht, war es ganz sicher das Netzwerk.</li>
        </ul>
        <p>
          <Link to="/">← Zurück zur Übersicht</Link>
        </p>
      </div>
    </section>
  );
}
