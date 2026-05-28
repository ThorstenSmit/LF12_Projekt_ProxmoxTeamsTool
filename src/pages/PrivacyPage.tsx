import { Link } from "react-router-dom";

// Platzhalter-Seite fuer die im Teams-Manifest referenzierte privacyUrl
// (/privacy). Kein rechtsverbindlicher Text — bewusst locker gehalten.
export function PrivacyPage() {
  return (
    <section className="page">
      <header className="page-header">
        <h2>Datenschutz</h2>
        <p className="page-subtitle">
          Platzhalter eines Schulprojekts — kein rechtsverbindlicher Text.
        </p>
      </header>
      <div className="card">
        <p>
          Dieses Tool ist ein Ausbildungsprojekt (LF12). Wir sammeln keine Daten,
          die wir nicht brauchen — und ehrlich gesagt hatten wir noch keine Zeit,
          hier echten Juristen-Text reinzuschreiben.
        </p>
        <p>
          Deine Microsoft-Anmeldung nutzen wir ausschließlich, um dir deine VMs
          und Templates zu zeigen. Keine Tracking-Pixel, keine Cookie-Monster,
          kein Datenverkauf an Außerirdische. 🛸
        </p>
        <p>
          <Link to="/">← Zurück zur Übersicht</Link>
        </p>
      </div>
    </section>
  );
}
