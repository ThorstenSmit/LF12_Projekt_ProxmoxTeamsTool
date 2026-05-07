import { useEffect, useState, createContext, useContext } from "react";
import type { ReactNode } from "react";
import { app, authentication } from "@microsoft/teams-js";
import {
  PublicClientApplication,
  InteractionRequiredAuthError,
} from "@azure/msal-browser";
import type { AccountInfo } from "@azure/msal-browser";
import { MsalProvider, useMsal } from "@azure/msal-react";
import { msalConfig, loginRequest } from "../config/authConfig";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface GraphProfile {
  id: string;
  displayName: string;
  mail: string | null;
  userPrincipalName: string;
  jobTitle?: string | null;
  officeLocation?: string | null;
}

export interface BridgeIdentity {
  oid: string;
  name: string;
  email: string;
  roles: string[];
  classes: string[];
  source: "standard" | "edu";
}

type ImpersonatedRole = "Proxmox.Admin" | "Proxmox.Teacher" | "Proxmox.Student";

interface AuthContextType {
  isInTeams: boolean;
  isAuthenticated: boolean;
  user: AccountInfo | null;
  accessToken: string | null;
  profile: GraphProfile | null;
  identity: BridgeIdentity | null;
  roles: string[];
  classes: string[];
  hasRole: (role: string) => boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getToken: () => Promise<string | null>;
  loading: boolean;
  error: string | null;
  // Demo-Impersonation: ein echter Admin kann eine andere Rolle "aufsetzen".
  // realIsAdmin gibt zurueck, ob der angemeldete User WIRKLICH Admin ist
  // (unabhaengig von der Impersonation), damit das Switcher-UI nur fuer
  // echte Admins angezeigt wird.
  realIsAdmin: boolean;
  impersonatedRole: ImpersonatedRole | null;
  setImpersonatedRole: (r: ImpersonatedRole | null) => void;
}

export const AuthContext = createContext<AuthContextType>({
  isInTeams: false,
  isAuthenticated: false,
  user: null,
  accessToken: null,
  profile: null,
  identity: null,
  roles: [],
  classes: [],
  hasRole: () => false,
  login: async () => {},
  logout: async () => {},
  getToken: async () => null,
  loading: true,
  error: null,
  realIsAdmin: false,
  impersonatedRole: null,
  setImpersonatedRole: () => {},
});

export const useAuth = () => useContext(AuthContext);

// ── MSAL Instance ──────────────────────────────────────────────────────────────

const msalInstance = new PublicClientApplication(msalConfig);

// Mappt HTTP-Status + strukturierten {code} der Bridge auf eine nutzer-
// verstaendliche Meldung. Ohne das schluckt das Frontend 401/403 von /api/me
// still und der User sieht eine leere App ohne jede Erklaerung.
function bridgeAuthErrorMessage(status: number, code?: string): string {
  switch (code) {
    case "not_provisioned":
      return "Du bist angemeldet, aber dein Konto ist für dieses Tool nicht freigeschaltet. Bitte wende dich an einen Admin.";
    case "wrong_tenant":
      return "Dein Konto gehört nicht zu dieser Organisation.";
    case "token_expired":
      return "Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.";
    case "idp_unavailable":
      return "Microsoft ist gerade nicht erreichbar. Bitte versuch es in ein paar Minuten erneut.";
  }
  if (status === 403)
    return "Zugriff verweigert — dein Konto ist für dieses Tool nicht berechtigt. Bitte kontaktiere einen Admin.";
  if (status === 401) return "Anmeldung fehlgeschlagen. Bitte melde dich erneut an.";
  return "Anmeldung konnte nicht abgeschlossen werden. Bitte später erneut versuchen.";
}

// ── Inner Auth Provider (needs MSAL context) ───────────────────────────────────

function AuthProviderInner({ children }: { children: ReactNode }) {
  const { instance, accounts } = useMsal();
  const [isInTeams, setIsInTeams] = useState(false);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [profile, setProfile] = useState<GraphProfile | null>(null);
  const [identity, setIdentity] = useState<BridgeIdentity | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const IMPERSONATE_KEY = "pttool.impersonate";
  const [impersonatedRole, setImpersonatedRoleState] = useState<ImpersonatedRole | null>(
    () => {
      if (typeof window === "undefined") return null;
      const v = localStorage.getItem(IMPERSONATE_KEY);
      if (v === "Proxmox.Admin" || v === "Proxmox.Teacher" || v === "Proxmox.Student") {
        return v;
      }
      return null;
    }
  );
  const setImpersonatedRole = (r: ImpersonatedRole | null) => {
    setImpersonatedRoleState(r);
    if (r) localStorage.setItem(IMPERSONATE_KEY, r);
    else localStorage.removeItem(IMPERSONATE_KEY);
  };

  const user = accounts[0] ?? null;
  const isAuthenticated = !!user;

  // Echte Roles aus ID-Token (immer, ohne Impersonation), damit das Switcher-
  // UI in der Profile-Bar erkennt ob der User wirklich Admin ist.
  const idTokenRoles =
    (user?.idTokenClaims as { roles?: string[] } | undefined)?.roles ?? [];
  const realRoles = identity?.roles ?? idTokenRoles;
  const realIsAdmin = realRoles.includes("Proxmox.Admin");

  // Die "gefuehlten" Roles fuer die UI: bei aktiver Impersonation ueberschrieben.
  const roles = impersonatedRole ? [impersonatedRole] : realRoles;
  const classes = identity?.classes ?? [];
  const hasRole = (role: string) => roles.includes(role);

  // Detect if running inside Teams
  useEffect(() => {
    const initTeams = async () => {
      try {
        await app.initialize();
        const context = await app.getContext();
        if (context) {
          setIsInTeams(true);
          // Try Teams SSO
          await teamsSSO();
        }
      } catch {
        // Not in Teams – that's fine, use regular MSAL flow
        setIsInTeams(false);
      } finally {
        setLoading(false);
      }
    };

    const handleRedirect = async () => {
      try {
        await instance.initialize();
        const response = await instance.handleRedirectPromise();
        if (response?.accessToken) {
          setAccessToken(response.accessToken);
        }
      } catch (err) {
        console.error("Redirect handling failed:", err);
      }
    };

    handleRedirect().then(initTeams);
  }, [instance]);

  // After page refresh we have an account but no token — acquire silently
  useEffect(() => {
    if (!user || accessToken) return;
    instance
      .acquireTokenSilent({ ...loginRequest, account: user })
      .then((res) => setAccessToken(res.accessToken))
      .catch((err) => {
        console.warn("Silent token acquisition failed:", err);
      });
  }, [user, accessToken, instance]);

  // Once we have an access token, fetch profile + identity from the backend.
  // Re-fetcht bei Impersonation-Switch, damit die Server-seitig gerechnete
  // Identity (Klassen-Filter etc.) zur impersonierten Rolle passt.
  useEffect(() => {
    if (!accessToken) {
      setProfile(null);
      setIdentity(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${accessToken}`,
        };
        if (impersonatedRole) headers["X-Impersonate-Role"] = impersonatedRole;
        const res = await fetch("/api/me", { headers });
        if (!res.ok) {
          // Strukturierten {error, code} der Bridge auslesen, damit ein
          // angemeldeter-aber-nicht-berechtigter User eine klare Meldung sieht
          // statt einer stillen, leeren App.
          let code: string | undefined;
          let serverMsg: string | undefined;
          try {
            const body = await res.json();
            code = body?.code;
            serverMsg = body?.error;
          } catch {
            /* kein JSON-Body */
          }
          console.error("Failed to fetch /api/me:", res.status, code ?? serverMsg);
          if (!cancelled) {
            setProfile(null);
            setIdentity(null);
            setError(bridgeAuthErrorMessage(res.status, code));
          }
          return;
        }
        const data = await res.json();
        if (!cancelled) {
          setProfile(data.profile ?? null);
          setIdentity(data.identity ?? null);
          setError(null);
        }
      } catch (err) {
        console.error("Failed to fetch /api/me:", err);
        if (!cancelled) {
          setError("Verbindung zur Bridge fehlgeschlagen. Bitte später erneut versuchen.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessToken, impersonatedRole]);

  /**
   * Teams SSO: get a token silently from Teams client.
   */
  const teamsSSO = async () => {
    try {
      const token = await authentication.getAuthToken();
      setAccessToken(token);

      // Optionally exchange token on backend for Graph access
      // via the On-Behalf-Of flow
      return token;
    } catch (err) {
      console.warn("Teams SSO failed, falling back to MSAL popup:", err);
      setError("Teams SSO failed – try manual login");
      return null;
    }
  };

  /**
   * Login via MSAL redirect (robust in popups, iframes, and webviews).
   * The page navigates away to login.microsoftonline.com and comes back —
   * the response is handled by handleRedirectPromise() above.
   */
  const login = async () => {
    try {
      setError(null);
      await instance.loginRedirect(loginRequest);
    } catch (err) {
      console.error("Login failed:", err);
      const msg =
        err instanceof Error
          ? `${(err as { errorCode?: string }).errorCode ?? err.name}: ${err.message}`
          : "Login failed. Please try again.";
      setError(msg);
    }
  };

  /**
   * Logout via redirect.
   */
  const logout = async () => {
    try {
      setAccessToken(null);
      await instance.logoutRedirect();
    } catch (err) {
      console.error("Logout failed:", err);
    }
  };

  /**
   * Get a valid access token (silently if possible, redirect if interaction needed).
   */
  const getToken = async (): Promise<string | null> => {
    if (!user) return null;

    try {
      const response = await instance.acquireTokenSilent({
        ...loginRequest,
        account: user,
      });
      setAccessToken(response.accessToken);
      return response.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        // Token expired or consent needed – navigate to login
        await instance.acquireTokenRedirect(loginRequest);
        return null; // page navigates away
      }
      console.error("Token acquisition failed:", err);
      return null;
    }
  };

  return (
    <AuthContext.Provider
      value={{
        isInTeams,
        isAuthenticated,
        user,
        accessToken,
        profile,
        identity,
        roles,
        classes,
        hasRole,
        login,
        logout,
        getToken,
        loading,
        error,
        realIsAdmin,
        impersonatedRole,
        setImpersonatedRole,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ── Exported Provider (wraps MSAL + Auth) ──────────────────────────────────────

import { DevFakeAuthProvider, readDevAuthRole } from "./DevFakeAuth";

export function TeamsAuthProvider({ children }: { children: ReactNode }) {
  const devRole = readDevAuthRole();
  if (devRole) {
    return <DevFakeAuthProvider role={devRole}>{children}</DevFakeAuthProvider>;
  }
  return (
    <MsalProvider instance={msalInstance}>
      <AuthProviderInner>{children}</AuthProviderInner>
    </MsalProvider>
  );
}
