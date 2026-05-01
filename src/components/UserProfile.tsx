import { useAuth } from "../auth/TeamsAuthProvider";

export function UserProfile() {
  const {
    isAuthenticated,
    user,
    profile,
    roles,
    isInTeams,
    login,
    logout,
    loading,
    error,
  } = useAuth();

  if (loading) {
    return <div className="profile-bar loading">Authenticating...</div>;
  }

  if (!isAuthenticated) {
    return (
      <div className="welcome">
        <div className="welcome-mark" aria-hidden>
          P
        </div>
        <h2>Willkommen beim Proxmox Teams Tool</h2>
        <p>
          Melde dich mit deinem Microsoft-Account an, um auf deine VMs und
          Templates zuzugreifen.
        </p>
        {error && <p className="error">{error}</p>}
        <button onClick={login} className="btn btn-primary btn-large">
          Mit Microsoft anmelden
        </button>
      </div>
    );
  }

  const displayName = profile?.displayName || user?.name || "Unknown User";
  const email =
    profile?.mail || profile?.userPrincipalName || user?.username || "";

  return (
    <div
      className="profile-bar"
      title={
        `Tenant: ${user?.tenantId ?? "N/A"} · Environment: ${
          isInTeams ? "Microsoft Teams" : "Browser (Standalone)"
        }`
      }
    >
      <div className="avatar avatar-sm">{displayName.charAt(0).toUpperCase()}</div>
      <div className="profile-bar-info">
        <strong>{displayName}</strong>
        <span className="muted">{email}</span>
      </div>
      <div className="profile-bar-roles">
        {roles.length === 0 ? (
          <span className="badge">keine Rolle</span>
        ) : (
          roles.map((r) => (
            <span key={r} className="badge role-badge">
              {r}
            </span>
          ))
        )}
      </div>
      <button onClick={logout} className="btn btn-sm">
        Sign out
      </button>
    </div>
  );
}
