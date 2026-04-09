import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import jwt, { JwtPayload } from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { createProxmoxClientFromEnv } from "./proxmox";
import { filterToActiveClasses, clearActiveClassCache } from "./classes";

dotenv.config();

const PORT = process.env.PORT || 3001;
const TENANT_ID = process.env.AZURE_TENANT_ID || process.env.VITE_AZURE_TENANT_ID;
const CLIENT_ID = process.env.AZURE_CLIENT_ID || process.env.VITE_AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET;
const API_AUDIENCE = process.env.API_AUDIENCE;

// AUTH_MODE: standard | edu | auto (default). Controls how the bridge derives
// roles + classes for a user. See docs/entra-setup.md → "Tenant-Typ wählen".
const AUTH_MODE = (process.env.AUTH_MODE ?? "auto").toLowerCase() as
  | "standard"
  | "edu"
  | "auto";

// Proxmox client (null if env not configured — bridge then skips class filter).
const proxmox = createProxmoxClientFromEnv();
if (proxmox) {
  console.log("[bridge] Proxmox client configured: " + process.env.PROXMOX_URL);
} else {
  console.log("[bridge] Proxmox not configured -- class allowlist disabled, all M365 groups pass through");
}

if (!TENANT_ID || !CLIENT_ID) {
  console.warn(
    "[bridge] Missing AZURE_TENANT_ID / AZURE_CLIENT_ID — token validation will fail until set."
  );
}

const app = express();
app.use(cors());
app.use(express.json());

// ── JWKS / Token Validation ────────────────────────────────────────────────────

const jwks = jwksClient({
  jwksUri: `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`,
  cache: true,
  cacheMaxAge: 24 * 60 * 60 * 1000,
});

function getSigningKey(header: jwt.JwtHeader, cb: jwt.SigningKeyCallback) {
  if (!header.kid) {
    cb(new Error("Token header missing kid"));
    return;
  }
  jwks.getSigningKey(header.kid, (err, key) => {
    if (err || !key) {
      cb(err || new Error("Signing key not found"));
      return;
    }
    cb(null, key.getPublicKey());
  });
}

export interface BridgeClaims extends JwtPayload {
  oid?: string;
  preferred_username?: string;
  name?: string;
  roles?: string[];
  groups?: string[];
  scp?: string;
  _claim_names?: { groups?: string };
  _claim_sources?: Record<string, { endpoint?: string }>;
}

export type AppRole = "Proxmox.Admin" | "Proxmox.Teacher" | "Proxmox.Student";

export interface BridgeIdentity {
  oid: string;
  name: string;
  email: string;
  roles: AppRole[];
  classes: string[];
  source: "standard" | "edu";
}

function verifyToken(token: string): Promise<BridgeClaims> {
  return new Promise((resolve, reject) => {
    // v1 tokens carry `aud: api://<client-id>`, v2 tokens carry `aud: <client-id>`.
    // Accept both so the bridge works regardless of the App Registration's
    // `requestedAccessTokenVersion` setting. Override with API_AUDIENCE if a
    // custom Application ID URI is configured in Entra.
    const audience = API_AUDIENCE
      ? [API_AUDIENCE]
      : CLIENT_ID
        ? [`api://${CLIENT_ID}`, CLIENT_ID]
        : undefined;
    const issuer = `https://login.microsoftonline.com/${TENANT_ID}/v2.0`;
    jwt.verify(
      token,
      getSigningKey,
      {
        audience,
        issuer,
        algorithms: ["RS256"],
      },
      (err, decoded) => {
        if (err || !decoded || typeof decoded === "string") {
          reject(err || new Error("Invalid token"));
          return;
        }
        resolve(decoded as BridgeClaims);
      }
    );
  });
}

// ── Auth Middleware ────────────────────────────────────────────────────────────

declare module "express-serve-static-core" {
  interface Request {
    user?: BridgeClaims;
    rawToken?: string;
  }
}

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Authorization header required" });
    return;
  }
  const token = header.slice("Bearer ".length);

  try {
    req.user = await verifyToken(token);
    req.rawToken = token;
    next();
  } catch (err) {
    console.error("[bridge] token validation failed:", err);
    res.status(401).json({ error: "Invalid token" });
  }
}

// ── Group Membership Resolution ────────────────────────────────────────────────

const GROUP_CACHE_TTL_MS = 10 * 60 * 1000;
const groupCache = new Map<string, { groups: string[]; expiresAt: number }>();

// Overage: when a user is in >150 groups Entra drops the `groups` array and
// sets `_claim_names.groups` instead — then we have to fetch via Graph.
async function getUserGroups(
  claims: BridgeClaims,
  graphToken: string
): Promise<string[]> {
  if (Array.isArray(claims.groups)) return claims.groups;
  if (!claims._claim_names?.groups || !claims.oid) return [];

  const cached = groupCache.get(claims.oid);
  if (cached && cached.expiresAt > Date.now()) return cached.groups;

  const response = await axios.post(
    "https://graph.microsoft.com/v1.0/me/getMemberGroups",
    { securityEnabledOnly: false },
    {
      headers: {
        Authorization: `Bearer ${graphToken}`,
        "Content-Type": "application/json",
      },
    }
  );
  const groups: string[] = response.data.value ?? [];
  groupCache.set(claims.oid, {
    groups,
    expiresAt: Date.now() + GROUP_CACHE_TTL_MS,
  });
  return groups;
}

// ── On-Behalf-Of Helper ────────────────────────────────────────────────────────

async function exchangeForGraphToken(userToken: string): Promise<string> {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error("Bridge not configured: missing Azure credentials");
  }

  const tokenEndpoint = `https://login.microsoftonline.com/${TENANT_ID || "common"}/oauth2/v2.0/token`;
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: userToken,
    requested_token_use: "on_behalf_of",
    scope: "https://graph.microsoft.com/.default",
  });

  const response = await axios.post(tokenEndpoint, params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return response.data.access_token;
}

// ── Identity Resolver (standard / edu / auto) ──────────────────────────────────

const MODE_CACHE_TTL_MS = 60 * 60 * 1000;
const modeCache = new Map<string, { mode: "standard" | "edu"; expiresAt: number }>();

async function detectMode(
  graphToken: string,
  oid: string
): Promise<"standard" | "edu"> {
  if (AUTH_MODE === "standard" || AUTH_MODE === "edu") return AUTH_MODE;

  const cached = modeCache.get(oid);
  if (cached && cached.expiresAt > Date.now()) return cached.mode;

  let mode: "standard" | "edu";
  try {
    await axios.get("https://graph.microsoft.com/v1.0/education/me", {
      headers: { Authorization: `Bearer ${graphToken}` },
    });
    mode = "edu";
  } catch (e) {
    // 403/404 → tenant lacks EDU or user has no EDU profile → standard path.
    // Any other error is propagated so we don't silently mis-classify.
    if (axios.isAxiosError(e) && (e.response?.status === 403 || e.response?.status === 404)) {
      mode = "standard";
    } else {
      throw e;
    }
  }

  modeCache.set(oid, { mode, expiresAt: Date.now() + MODE_CACHE_TTL_MS });
  console.log(`[bridge] identity mode for ${oid}: ${mode}`);
  return mode;
}

function mapEduRoleToAppRoles(primaryRole?: string): AppRole[] {
  switch (primaryRole) {
    case "teacher":
    case "faculty":
      return ["Proxmox.Teacher"];
    case "student":
      return ["Proxmox.Student"];
    default:
      return [];
  }
}

function filterAppRoles(roles: string[] | undefined): AppRole[] {
  if (!roles) return [];
  const allowed: AppRole[] = ["Proxmox.Admin", "Proxmox.Teacher", "Proxmox.Student"];
  return roles.filter((r): r is AppRole => allowed.includes(r as AppRole));
}

async function resolveFromStandard(
  claims: BridgeClaims,
  graphToken: string
): Promise<BridgeIdentity> {
  const allGroups = await getUserGroups(claims, graphToken);
  const classes = await filterToActiveClasses(proxmox, allGroups);
  return {
    oid: claims.oid!,
    name: claims.name ?? "",
    email: claims.preferred_username ?? "",
    roles: filterAppRoles(claims.roles),
    classes,
    source: "standard",
  };
}

// EDU path — untested without an EDU tenant. Built against Microsoft Graph
// Education docs. When an EDU tenant becomes available, verify primaryRole values
// and the $expand=group response shape.
async function resolveFromEdu(
  claims: BridgeClaims,
  graphToken: string
): Promise<BridgeIdentity> {
  const userRes = await axios.get(
    "https://graph.microsoft.com/v1.0/education/me/user?$select=primaryRole",
    { headers: { Authorization: `Bearer ${graphToken}` } }
  );
  const eduRoles = mapEduRoleToAppRoles(userRes.data?.primaryRole);

  const classesRes = await axios.get(
    "https://graph.microsoft.com/v1.0/education/me/classes?$expand=group($select=id)&$select=id,displayName",
    { headers: { Authorization: `Bearer ${graphToken}` } }
  );
  const rawClasses: string[] = (classesRes.data?.value ?? [])
    .map((c: { group?: { id?: string } }) => c.group?.id)
    .filter((id: string | undefined): id is string => typeof id === "string");
  const classes = await filterToActiveClasses(proxmox, rawClasses);

  // Admin role is never in EDU's primaryRole — it stays an explicit App Role.
  // Union of EDU-derived + explicit App Roles from the token.
  const explicitAppRoles = filterAppRoles(claims.roles);
  const roles = Array.from(new Set([...eduRoles, ...explicitAppRoles]));

  return {
    oid: claims.oid!,
    name: claims.name ?? "",
    email: claims.preferred_username ?? "",
    roles,
    classes,
    source: "edu",
  };
}

async function resolveIdentity(
  claims: BridgeClaims,
  graphToken: string
): Promise<BridgeIdentity> {
  if (!claims.oid) throw new Error("Token missing oid claim");
  const mode = await detectMode(graphToken, claims.oid);
  return mode === "edu"
    ? resolveFromEdu(claims, graphToken)
    : resolveFromStandard(claims, graphToken);
}

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const graphToken = await exchangeForGraphToken(req.rawToken!);
    const profile = await axios.get("https://graph.microsoft.com/v1.0/me", {
      headers: { Authorization: `Bearer ${graphToken}` },
    });
    const identity = await resolveIdentity(req.user!, graphToken);

    res.json({
      profile: profile.data,
      identity,
    });
  } catch (error: unknown) {
    console.error("/api/me failed:", error);
    if (axios.isAxiosError(error)) {
      res.status(error.response?.status || 500).json({
        error: "Request failed",
        details: error.response?.data,
      });
    } else {
      res.status(500).json({
        error: "Request failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
});

// Debug endpoints — only registered outside production. Dockerfile sets
// NODE_ENV=production for shipped builds, so they're auto-gated.
if (process.env.NODE_ENV !== "production") {
  app.get("/api/debug/proxmox", requireAuth, async (_req, res) => {
    if (!proxmox) {
      res.status(503).json({ error: "Proxmox not configured" });
      return;
    }
    try {
      clearActiveClassCache();
      const [nodes, vms] = await Promise.all([
        proxmox.listNodes(),
        proxmox.listVMs(),
      ]);
      const TAG_PREFIX = "tpl-class:";
      const activeClassOids = new Set<string>();
      for (const v of vms) {
        for (const t of v.tags) {
          if (t.startsWith(TAG_PREFIX)) activeClassOids.add(t.slice(TAG_PREFIX.length));
        }
      }
      res.json({
        url: process.env.PROXMOX_URL,
        nodes,
        vms,
        activeClassOids: [...activeClassOids],
      });
    } catch (e) {
      const detail = axios.isAxiosError(e)
        ? { status: e.response?.status, body: e.response?.data, message: e.message }
        : e instanceof Error ? e.message : String(e);
      res.status(502).json({ error: "Proxmox call failed", detail });
    }
  });

  app.get("/api/debug/identity", requireAuth, async (req, res) => {
    try {
      const graphToken = await exchangeForGraphToken(req.rawToken!);
      const identity = await resolveIdentity(req.user!, graphToken);
      res.json({ authMode: AUTH_MODE, identity });
    } catch (e) {
      res.status(500).json({
        error: "identity resolution failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  });

  app.get("/api/debug/groups", requireAuth, async (req, res) => {
    const graphToken = await exchangeForGraphToken(req.rawToken!);

    const tryCall = async <T,>(fn: () => Promise<T>): Promise<T | { error: unknown }> => {
      try {
        return await fn();
      } catch (e) {
        return {
          error: axios.isAxiosError(e)
            ? { status: e.response?.status, body: e.response?.data }
            : e instanceof Error
              ? e.message
              : String(e),
        };
      }
    };

    const memberOf = await tryCall(async () => {
      const r = await axios.get(
        "https://graph.microsoft.com/v1.0/me/memberOf?$select=id,displayName,description,groupTypes,securityEnabled,mailEnabled,visibility",
        { headers: { Authorization: `Bearer ${graphToken}` } }
      );
      return r.data;
    });

    const transitiveMemberOf = await tryCall(async () => {
      const r = await axios.get(
        "https://graph.microsoft.com/v1.0/me/transitiveMemberOf?$select=id,displayName,groupTypes",
        { headers: { Authorization: `Bearer ${graphToken}` } }
      );
      return r.data;
    });

    const getMemberGroups = await tryCall(async () => {
      const r = await axios.post(
        "https://graph.microsoft.com/v1.0/me/getMemberGroups",
        { securityEnabledOnly: false },
        {
          headers: {
            Authorization: `Bearer ${graphToken}`,
            "Content-Type": "application/json",
          },
        }
      );
      return r.data;
    });

    res.json({
      claimGroups: req.user!.groups ?? null,
      memberOf,
      transitiveMemberOf,
      getMemberGroups,
    });
  });

  console.log("[bridge] debug endpoints enabled at /api/debug/* (NODE_ENV != production)");
}

app.listen(PORT, () => {
  console.log(`[bridge] listening on http://localhost:${PORT}`);
});
