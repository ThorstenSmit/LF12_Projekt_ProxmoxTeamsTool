import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import axios from "axios";
import http from "http";
import https from "https";
import { randomBytes } from "crypto";
import jwt, { JwtPayload } from "jsonwebtoken";
import jwksClient from "jwks-rsa";
import { WebSocketServer, WebSocket } from "ws";
import { createProxmoxClientFromEnv } from "./proxmox";
import type { VM, VMID } from "./proxmox";
import { filterToActiveClasses, clearActiveClassCache } from "./classes";
import { TAG, tagValue, tagValues, hasTag } from "./tags";
import {
  type BridgeIdentity,
  isAdmin,
  isTeacher,
  isStudent,
  canSeeTemplate,
  canSeeVm,
  canModifyVm,
  mapEduRoleToAppRoles,
  filterAppRoles,
  applyImpersonation,
} from "./authz";
import { buildVmName } from "./naming";
import { envOrFile } from "./env";

dotenv.config();

const PORT = process.env.PORT || 3001;
// Config-Werte via envOrFile(): Env-Var <NAME> ODER Datei aus <NAME>_FILE
// (Docker-/Compose-Secrets). Beide Wege werden unterstuetzt.
const TENANT_ID = envOrFile("AZURE_TENANT_ID") || envOrFile("VITE_AZURE_TENANT_ID");
const CLIENT_ID = envOrFile("AZURE_CLIENT_ID") || envOrFile("VITE_AZURE_CLIENT_ID");
const CLIENT_SECRET = envOrFile("AZURE_CLIENT_SECRET");
const API_AUDIENCE = envOrFile("API_AUDIENCE");

// AUTH_MODE: standard | edu | auto (default). Controls how the bridge derives
// roles + classes for a user. See docs/entra-setup.md → "Tenant-Typ wählen".
const AUTH_MODE = (process.env.AUTH_MODE ?? "auto").toLowerCase() as
  | "standard"
  | "edu"
  | "auto";

// Proxmox-Connection-Konstanten (oben, weil mehrere Helfer sie referenzieren).
const PROXMOX_URL = envOrFile("PROXMOX_URL") ?? "";
const PROXMOX_TOKEN_ID = envOrFile("PROXMOX_TOKEN_ID") ?? "";
const PROXMOX_TOKEN_SECRET = envOrFile("PROXMOX_TOKEN_SECRET") ?? "";
const PROXMOX_TLS_INSECURE =
  (process.env.PROXMOX_TLS_REJECT_UNAUTHORIZED ?? "true").toLowerCase() ===
  "false";

// Proxmox client (null if env not configured — bridge then skips class filter).
const proxmox = createProxmoxClientFromEnv();
if (proxmox) {
  console.log("[bridge] Proxmox client configured: " + PROXMOX_URL);
} else {
  console.log("[bridge] Proxmox not configured -- class allowlist disabled, all M365 groups pass through");
}

if (!TENANT_ID || !CLIENT_ID) {
  console.error(
    "[bridge] FATAL: AZURE_TENANT_ID and AZURE_CLIENT_ID are required — " +
      "single-tenant token validation cannot work without a concrete tenant. Refusing to start."
  );
  process.exit(1);
}

// Der Tenant IST das Schloss: mit einer Multi-Tenant-Authority würden Tokens aus
// JEDEM Entra-Tenant die Issuer-Pruefung passieren und die Org-Grenze verschwindet.
// Darum harter Boot-Abbruch, wenn TENANT_ID ein Multi-Tenant-Platzhalter ist.
const MULTI_TENANT_AUTHORITIES = new Set(["common", "organizations", "consumers"]);
if (MULTI_TENANT_AUTHORITIES.has(TENANT_ID.toLowerCase())) {
  console.error(
    `[bridge] FATAL: AZURE_TENANT_ID="${TENANT_ID}" is a multi-tenant authority. ` +
      "Set the concrete tenant GUID (the iss/tid claims are always the GUID, never a domain) so only your org can sign in. Refusing to start."
  );
  process.exit(1);
}

// CORS: leer => offen (Dev / Single-Host hinter Reverse-Proxy, same-origin).
// Gesetzt (Komma-separierte Origin-Liste) => nur diese Origins duerfen die
// Bridge cross-origin aufrufen — noetig, sobald das Frontend auf einer anderen
// Origin liegt (z.B. Azure Static Web Apps) und die Bridge per Cloudflare-Tunnel
// erreicht wird. Auth laeuft per Bearer-Header (keine Cookies) -> kein
// credentials:true noetig.
const CORS_ALLOWED_ORIGINS = (envOrFile("CORS_ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
console.log(
  CORS_ALLOWED_ORIGINS.length
    ? `[bridge] CORS restricted to: ${CORS_ALLOWED_ORIGINS.join(", ")}`
    : "[bridge] CORS open (all origins) — set CORS_ALLOWED_ORIGINS to restrict"
);

const app = express();
app.use(
  cors(
    CORS_ALLOWED_ORIGINS.length > 0
      ? { origin: CORS_ALLOWED_ORIGINS }
      : {}
  )
);
app.use(express.json());

// Getypter Auth-Fehler, damit die Middleware einen aussagekraeftigen Status/Code
// liefern kann, statt jeden Fehlschlag auf "Invalid token" / 500 zu kollabieren.
class AuthError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

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
  tid?: string;
  preferred_username?: string;
  name?: string;
  roles?: string[];
  groups?: string[];
  scp?: string;
  _claim_names?: { groups?: string };
  _claim_sources?: Record<string, { endpoint?: string }>;
}

function verifyToken(token: string): Promise<BridgeClaims> {
  return new Promise((resolve, reject) => {
    // v1 tokens carry `aud: api://<client-id>`, v2 tokens carry `aud: <client-id>`.
    // Accept both so the bridge works regardless of the App Registration's
    // `requestedAccessTokenVersion` setting. Override with API_AUDIENCE if a
    // custom Application ID URI is configured in Entra.
    const audience: [string, ...string[]] | undefined = API_AUDIENCE
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
        const claims = decoded as BridgeClaims;
        // Defense-in-depth: `issuer` oben pinnt den Tenant bereits, aber wir
        // pruefen den `tid`-Claim zusaetzlich explizit, damit ein Config-Drift
        // niemals stillschweigend ein org-fremdes Token durchlaesst.
        if (claims.tid !== TENANT_ID) {
          reject(
            new AuthError(403, "wrong_tenant", "Token was issued for a different tenant")
          );
          return;
        }
        resolve(claims);
      }
    );
  });
}

// ── Auth Middleware ────────────────────────────────────────────────────────────

declare module "express-serve-static-core" {
  interface Request {
    user?: BridgeClaims;
    rawToken?: string;
    identity?: BridgeIdentity;
    graphToken?: string;
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
    // Unterscheidbarer Status/Code statt pauschalem 401, damit ein org-fremder /
    // abgelaufener / falsch-adressierter Aufrufer (und unsere Support-Logs) die
    // Faelle auseinanderhalten kann. Die Bridge ist single-tenant (Boot-Guard).
    if (err instanceof AuthError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : "";
    if (name === "TokenExpiredError") {
      res.status(401).json({ error: "Token expired", code: "token_expired" });
    } else if (/issuer/i.test(msg)) {
      res.status(403).json({ error: "Token from an unexpected tenant", code: "wrong_tenant" });
    } else if (/audience/i.test(msg)) {
      res.status(401).json({ error: "Token has wrong audience", code: "bad_audience" });
    } else {
      res.status(401).json({ error: "Invalid token", code: "invalid_token" });
    }
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

  const tokenEndpoint = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
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

async function getRawClassOids(
  source: "standard" | "edu",
  claims: BridgeClaims,
  graphToken: string
): Promise<string[]> {
  if (source === "standard") {
    return getUserGroups(claims, graphToken);
  }
  const r = await axios.get(
    "https://graph.microsoft.com/v1.0/education/me/classes?$expand=group($select=id)&$select=id",
    { headers: { Authorization: `Bearer ${graphToken}` } }
  );
  return (r.data?.value ?? [])
    .map((c: { group?: { id?: string } }) => c.group?.id)
    .filter((id: string | undefined): id is string => typeof id === "string");
}

async function resolveFromStandard(
  claims: BridgeClaims,
  graphToken: string
): Promise<BridgeIdentity> {
  const allGroups = await getRawClassOids("standard", claims, graphToken);
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

  const rawClasses = await getRawClassOids("edu", claims, graphToken);
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
  if (!claims.oid) throw new AuthError(401, "missing_oid", "Token missing oid claim");
  const mode = await detectMode(graphToken, claims.oid);
  return mode === "edu"
    ? resolveFromEdu(claims, graphToken)
    : resolveFromStandard(claims, graphToken);
}

// ── Identity Middleware + Authorization Helpers ────────────────────────────────

// Klassifiziert einen Fehler aus dem Identity-/Upstream-Pfad nach Quelle
// (Microsoft-IdP vs. Proxmox — resolveIdentity ruft fuer die Klassen-Whitelist
// auch Proxmox auf!) und reicht die echte Ursache durch, statt pauschal den IdP
// zu beschuldigen. Auth-Header/-URLs werden NICHT exponiert (nur Code/Message/
// Upstream-Status/-Body); das rohe `detail` nur ausserhalb von production.
function describeUpstreamError(err: unknown): {
  status: number;
  code: string;
  error: string;
  detail?: string;
} {
  if (err instanceof AuthError) {
    return { status: err.status, code: err.code, error: err.message };
  }
  if (axios.isAxiosError(err)) {
    const reqUrl = err.config?.baseURL ?? err.config?.url ?? "";
    const proxmoxBase = PROXMOX_URL.replace(/\/+$/, "");
    const target = /graph\.microsoft\.com|login\.microsoftonline\.com/.test(reqUrl)
      ? "microsoft"
      : proxmoxBase && reqUrl.startsWith(proxmoxBase)
        ? "proxmox"
        : "upstream";
    const upstream = err.response?.status;
    const body =
      err.response?.data === undefined
        ? ""
        : typeof err.response.data === "string"
          ? err.response.data
          : JSON.stringify(err.response.data);
    const rawDetail = [err.code, err.message, upstream ? `upstream ${upstream}` : "", body]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 400);
    const detail = process.env.NODE_ENV === "production" ? undefined : rawDetail;

    // 4xx mit Response = der Upstream hat bewusst abgelehnt.
    if (upstream && upstream >= 400 && upstream < 500) {
      if (target === "microsoft") {
        return { status: 403, code: "not_provisioned", error: "Account is not authorized for this organization", detail };
      }
      if (target === "proxmox") {
        return { status: 502, code: "proxmox_error", error: "Proxmox rejected the request", detail };
      }
      return { status: 502, code: "upstream_error", error: "Upstream rejected the request", detail };
    }
    // Kein Response (Timeout/ECONNREFUSED/DNS) oder 5xx = Upstream nicht erreichbar.
    if (target === "proxmox") {
      return { status: 504, code: "proxmox_unavailable", error: "Proxmox not reachable", detail };
    }
    if (target === "microsoft") {
      return { status: 502, code: "idp_unavailable", error: "Identity provider unavailable", detail };
    }
    return { status: 502, code: "upstream_unavailable", error: "Upstream service unavailable", detail };
  }
  return {
    status: 500,
    code: "identity_error",
    error: "identity resolution failed",
    detail:
      process.env.NODE_ENV === "production"
        ? undefined
        : err instanceof Error
          ? err.message
          : String(err),
  };
}

// Schreibt einen klassifizierten Upstream-Fehler als JSON-Response.
function sendUpstreamError(res: express.Response, err: unknown): void {
  const d = describeUpstreamError(err);
  res
    .status(d.status)
    .json(
      d.detail
        ? { error: d.error, code: d.code, detail: d.detail }
        : { error: d.error, code: d.code }
    );
}

async function requireIdentity(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!req.rawToken) {
    res.status(401).json({ error: "Token required" });
    return;
  }
  try {
    req.graphToken = await exchangeForGraphToken(req.rawToken);
    const realIdentity = await resolveIdentity(req.user!, req.graphToken);
    req.identity = maybeImpersonate(realIdentity, req);
    next();
  } catch (err) {
    console.error("[bridge] identity resolution failed:", err);
    sendUpstreamError(res, err);
  }
}

// Dev-Impersonation: nur in non-prod und nur wenn der echte Anrufer Admin ist.
// Erlaubt einen einzelnen App-Role-Header, der die Rolle fuer diese Request
// ueberschreibt -- praktisch fuer Demo-Screenshots.
function maybeImpersonate(
  real: BridgeIdentity,
  req: express.Request
): BridgeIdentity {
  return applyImpersonation(
    real,
    req.header("X-Impersonate-Role"),
    process.env.NODE_ENV === "production"
  );
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
    sendUpstreamError(res, error);
  }
});

// ── Templates ──────────────────────────────────────────────────────────────────

function templateDTO(tpl: VM) {
  return {
    vmid: tpl.vmid,
    node: tpl.node,
    name: tpl.name,
    classes: tagValues(tpl.tags, TAG.TPL_CLASS_PREFIX),
    ownerOid: tagValue(tpl.tags, TAG.TPL_OWNER_PREFIX),
    isPublic: hasTag(tpl.tags, TAG.TPL_PUBLIC),
    tags: tpl.tags,
  };
}

function vmDTO(
  vm: VM,
  templatesByVmid: Map<number, VM> | undefined,
  avg?: { cpuAvg5m: number; memAvg5m: number }
) {
  const srcId = Number(tagValue(vm.tags, TAG.VM_TPL_PREFIX)) || null;
  const srcTpl = srcId && templatesByVmid ? templatesByVmid.get(srcId) : undefined;
  return {
    vmid: vm.vmid,
    node: vm.node,
    name: vm.name,
    status: vm.status,
    ownerOid: tagValue(vm.tags, TAG.VM_OWNER_PREFIX),
    sourceTemplate: srcId
      ? { vmid: srcId, name: srcTpl?.name ?? null }
      : null,
    cpus: vm.cpus,
    maxmem: vm.maxmem,
    cpu: vm.cpu,
    mem: vm.mem,
    cpuAvg5m: avg?.cpuAvg5m,
    memAvg5m: avg?.memAvg5m,
    uptime: vm.uptime,
    tags: vm.tags,
  };
}

const RRD_CACHE_TTL_MS = 30_000;
const rrdCache = new Map<
  number,
  { cpuAvg5m: number; memAvg5m: number; expiresAt: number }
>();

// 5-Minuten-Durchschnitt aus Proxmox-RRD. timeframe=hour liefert Punkte
// im 30-Sekunden-Raster, die letzten 10 davon sind also ~5 min.
async function getVmAvg5m(
  node: string,
  vmid: number
): Promise<{ cpuAvg5m: number; memAvg5m: number } | null> {
  const cached = rrdCache.get(vmid);
  if (cached && cached.expiresAt > Date.now()) {
    return { cpuAvg5m: cached.cpuAvg5m, memAvg5m: cached.memAvg5m };
  }
  try {
    const r = await axios.get<{
      data: Array<{ time: number; cpu?: number; mem?: number; maxmem?: number }>;
    }>(
      `${PROXMOX_URL.replace(/\/+$/, "")}/api2/json/nodes/${node}/qemu/${vmid}/rrddata?timeframe=hour&cf=AVERAGE`,
      {
        headers: {
          Authorization: `PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}`,
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: !PROXMOX_TLS_INSECURE }),
        timeout: 8000,
      }
    );
    const points = r.data?.data ?? [];
    const recent = points.slice(-10);
    const cpus = recent
      .map((p) => p.cpu)
      .filter((c): c is number => typeof c === "number");
    const mems = recent
      .map((p) => p.mem)
      .filter((m): m is number => typeof m === "number");
    const cpuAvg5m = cpus.length
      ? cpus.reduce((a, b) => a + b, 0) / cpus.length
      : 0;
    const memAvg5m = mems.length
      ? mems.reduce((a, b) => a + b, 0) / mems.length
      : 0;
    rrdCache.set(vmid, {
      cpuAvg5m,
      memAvg5m,
      expiresAt: Date.now() + RRD_CACHE_TTL_MS,
    });
    return { cpuAvg5m, memAvg5m };
  } catch (e) {
    console.warn(
      `[bridge] RRD fetch for vm ${vmid} failed:`,
      e instanceof Error ? e.message : e
    );
    return null;
  }
}

async function listAllProxmoxVms(): Promise<{
  templates: VM[];
  vms: VM[];
  templatesByVmid: Map<number, VM>;
}> {
  const all = (await proxmox!.listVMs()).filter((v) =>
    v.template ? hasTag(v.tags, TAG.TPL_MARKER) : hasTag(v.tags, TAG.VM_MARKER)
  );
  const templates = all.filter((v) => v.template);
  const vms = all.filter((v) => !v.template);
  const templatesByVmid = new Map<number, VM>();
  for (const t of templates) templatesByVmid.set(t.vmid, t);
  return { templates, vms, templatesByVmid };
}

function requireProxmox(res: express.Response): boolean {
  if (!proxmox) {
    res.status(503).json({ error: "Proxmox not configured" });
    return false;
  }
  return true;
}

app.get("/api/classes", requireAuth, requireIdentity, async (req, res) => {
  const id = req.identity!;
  const graphToken = req.graphToken!;
  const results = await Promise.all(
    id.classes.map(async (oid) => {
      try {
        const r = await axios.get(
          `https://graph.microsoft.com/v1.0/groups/${oid}?$select=id,displayName,description,visibility`,
          { headers: { Authorization: `Bearer ${graphToken}` } }
        );
        return {
          oid,
          displayName: r.data.displayName as string,
          description: r.data.description as string | null,
          visibility: r.data.visibility as string | null,
        };
      } catch {
        return { oid, displayName: null, description: null, visibility: null };
      }
    })
  );
  res.json({ classes: results });
});

async function resolveClassDisplayNames(
  oids: string[],
  graphToken: string,
  opts: { dropNonGroups?: boolean } = {}
): Promise<Array<{ oid: string; displayName: string | null }>> {
  const results = await Promise.all(
    oids.map(async (oid) => {
      try {
        const r = await axios.get(
          `https://graph.microsoft.com/v1.0/groups/${oid}?$select=id,displayName`,
          { headers: { Authorization: `Bearer ${graphToken}` } }
        );
        return { oid, displayName: r.data.displayName as string, isGroup: true };
      } catch {
        // /groups/{id} 404 → OID ist keine M365-Group (z.B. directoryRole oder
        // administrativeUnit). Kennzeichnen, damit Endpoints sie ggf. ausfiltern.
        return { oid, displayName: null, isGroup: false };
      }
    })
  );
  return (opts.dropNonGroups ? results.filter((r) => r.isGroup) : results).map(
    ({ oid, displayName }) => ({ oid, displayName })
  );
}

// Alle Klassen, die der Lehrer einem Template zuweisen koennte -- das sind
// seine eigenen M365-Group-Memberships (ohne den Active-Filter), denn ein
// Lehrer kann *seine* Klassen aktivieren, indem er ein Template hin haengt.
app.get("/api/classes/assignable", requireAuth, requireIdentity, async (req, res) => {
  if (!isTeacher(req.identity!) && !isAdmin(req.identity!)) {
    res.status(403).json({ error: "Nur Lehrer/Admin" });
    return;
  }
  try {
    const oids = await getRawClassOids(
      req.identity!.source,
      req.user!,
      req.graphToken!
    );
    const named = await resolveClassDisplayNames(oids, req.graphToken!, {
      dropNonGroups: true,
    });
    res.json({ classes: named });
  } catch (err) {
    proxmoxErrorResponse(res, err);
  }
});

async function patchTemplateTags(
  vmid: number,
  identity: BridgeIdentity,
  modify: (tags: string[]) => string[]
): Promise<VM> {
  const { templates } = await listAllProxmoxVms();
  const tpl = templates.find((t) => t.vmid === vmid);
  if (!tpl) throw Object.assign(new Error("Template not found"), { httpStatus: 404 });

  const ownerOid = tagValue(tpl.tags, TAG.TPL_OWNER_PREFIX);
  const allowed = isAdmin(identity) || (ownerOid && ownerOid === identity.oid);
  if (!allowed) {
    throw Object.assign(new Error("Not the owner"), { httpStatus: 403 });
  }
  const newTags = modify([...tpl.tags]);
  await proxmox!.updateConfig(tpl.node, tpl.vmid, { tags: newTags });
  return { ...tpl, tags: newTags };
}

// Lehrer/Admin uebernehmen ein noch ungeclaimtes Template -- setzt tpl-owner-<self>.
app.post("/api/templates/:vmid/claim", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  if (!isTeacher(req.identity!) && !isAdmin(req.identity!)) {
    res.status(403).json({ error: "Nur Lehrer/Admin" });
    return;
  }
  try {
    const vmid = Number(req.params.vmid);
    if (!Number.isFinite(vmid)) {
      res.status(400).json({ error: "vmid must be a number" });
      return;
    }
    const { templates } = await listAllProxmoxVms();
    const tpl = templates.find((t) => t.vmid === vmid);
    if (!tpl) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    const currentOwner = tagValue(tpl.tags, TAG.TPL_OWNER_PREFIX);
    if (currentOwner && currentOwner !== req.identity!.oid && !isAdmin(req.identity!)) {
      res.status(409).json({
        error: "Template hat bereits einen Owner",
        ownerOid: currentOwner,
      });
      return;
    }
    const newTags = tpl.tags.filter((t) => !t.startsWith(TAG.TPL_OWNER_PREFIX));
    if (!hasTag(newTags, TAG.TPL_MARKER)) newTags.push(TAG.TPL_MARKER);
    newTags.push(`${TAG.TPL_OWNER_PREFIX}${req.identity!.oid}`);
    await proxmox!.updateConfig(tpl.node, tpl.vmid, { tags: newTags });
    res.json(templateDTO({ ...tpl, tags: newTags }));
  } catch (err) {
    proxmoxErrorResponse(res, err);
  }
});

// Owner gibt das Template frei -- entfernt tpl-owner-* und (optional) das
// public-Flag + alle class-Zuweisungen, damit es wieder claimable wird.
app.post("/api/templates/:vmid/release", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  try {
    const vmid = Number(req.params.vmid);
    const updated = await patchTemplateTags(vmid, req.identity!, (tags) =>
      tags.filter((t) => !t.startsWith(TAG.TPL_OWNER_PREFIX))
    );
    res.json(templateDTO(updated));
  } catch (err: unknown) {
    const e = err as { httpStatus?: number; message?: string };
    if (e?.httpStatus) {
      res.status(e.httpStatus).json({ error: e.message });
      return;
    }
    proxmoxErrorResponse(res, err);
  }
});

// Public-Flag + Klassen-Zuweisung aktualisieren. Body: { isPublic?, classes? }
app.patch("/api/templates/:vmid", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  try {
    const vmid = Number(req.params.vmid);
    const { isPublic, classes } = req.body ?? {};
    if (
      isPublic === undefined &&
      classes === undefined
    ) {
      res.status(400).json({ error: "isPublic oder classes muss gesetzt sein" });
      return;
    }
    if (classes !== undefined && !Array.isArray(classes)) {
      res.status(400).json({ error: "classes muss ein Array von OIDs sein" });
      return;
    }
    const updated = await patchTemplateTags(vmid, req.identity!, (tags) => {
      let next = tags;
      if (isPublic !== undefined) {
        next = next.filter((t) => t !== TAG.TPL_PUBLIC);
        if (isPublic) next.push(TAG.TPL_PUBLIC);
      }
      if (classes !== undefined) {
        next = next.filter((t) => !t.startsWith(TAG.TPL_CLASS_PREFIX));
        for (const oid of classes as string[]) {
          if (typeof oid === "string" && oid.length > 0) {
            next.push(`${TAG.TPL_CLASS_PREFIX}${oid}`);
          }
        }
      }
      return next;
    });
    // Klassen-Cache invalidieren — sonst sieht /api/me die neue Klasse erst nach 5 min.
    clearActiveClassCache();
    res.json(templateDTO(updated));
  } catch (err: unknown) {
    const e = err as { httpStatus?: number; message?: string };
    if (e?.httpStatus) {
      res.status(e.httpStatus).json({ error: e.message });
      return;
    }
    proxmoxErrorResponse(res, err);
  }
});

app.get("/api/templates", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  try {
    const { templates } = await listAllProxmoxVms();
    const visible = templates
      .filter((t) => canSeeTemplate(t, req.identity!))
      .map(templateDTO);
    res.json({ templates: visible });
  } catch (err) {
    proxmoxErrorResponse(res, err);
  }
});

async function buildVmDTOsWithAvg(
  vms: VM[],
  templatesByVmid: Map<number, VM>
) {
  // RRD-Calls fuer running VMs parallelisieren. Der Cache (30 s) faengt
  // Auto-Refresh-Bursts ab, sodass nicht jeder Request 10 RRD-Calls schiesst.
  return Promise.all(
    vms.map(async (v) => {
      if (v.status !== "running") return vmDTO(v, templatesByVmid);
      const avg = await getVmAvg5m(v.node, v.vmid);
      return vmDTO(v, templatesByVmid, avg ?? undefined);
    })
  );
}

app.get("/api/vms", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  try {
    const { vms, templatesByVmid } = await listAllProxmoxVms();
    const visibleVms = vms.filter((v) =>
      canSeeVm(v, req.identity!, templatesByVmid)
    );
    const dtos = await buildVmDTOsWithAvg(visibleVms, templatesByVmid);
    res.json({ vms: dtos });
  } catch (err) {
    proxmoxErrorResponse(res, err);
  }
});

// Console-Link auf die Proxmox-WebUI-noVNC-Console. WICHTIG: das oeffnet die
// Proxmox-UI direkt, die per Cookie-Auth laeuft -- der User muss dort einmal
// einloggen. Fuer eine schulreife Loesung muesste die Bridge die VNC-Session
// proxy'en, das ist ein eigener Brocken Arbeit.
app.get("/api/vms/:vmid/console-link", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  try {
    const vmid = Number(req.params.vmid);
    if (!Number.isFinite(vmid)) {
      res.status(400).json({ error: "vmid must be a number" });
      return;
    }
    const { vms, templatesByVmid } = await listAllProxmoxVms();
    const vm = vms.find((v) => v.vmid === vmid);
    if (!vm) {
      res.status(404).json({ error: "VM not found" });
      return;
    }
    if (!canSeeVm(vm, req.identity!, templatesByVmid)) {
      res.status(403).json({ error: "Not allowed" });
      return;
    }
    const base = PROXMOX_URL.replace(/\/+$/, "");
    const url = `${base}/?console=kvm&novnc=1&vmid=${vm.vmid}&node=${vm.node}&resize=scale`;
    res.json({
      url,
      hint:
        "Oeffnet die Proxmox-WebUI-Console in einem neuen Tab. Erstanmeldung mit Proxmox-Credentials (z.B. root@pam) noetig -- die Auth-Cookie-Session laeuft separat von Entra.",
    });
  } catch (err) {
    proxmoxErrorResponse(res, err);
  }
});

// Schüler: VM aus einem ihm zugewiesenen Template erstellen.
// Constraint: max 1 VM pro Template pro Schüler.
app.post("/api/vms/from-template/:templateId", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  try {
    const id = req.identity!;
    const templateId = Number(req.params.templateId);
    if (!Number.isFinite(templateId)) {
      res.status(400).json({ error: "templateId must be a number" });
      return;
    }
    const { templates, vms } = await listAllProxmoxVms();
    const tpl = templates.find((t) => t.vmid === templateId);
    if (!tpl) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    if (!canSeeTemplate(tpl, id)) {
      res.status(403).json({ error: "Template not assigned to you" });
      return;
    }
    // Schüler darf max 1 VM pro Template — Admin/Lehrer dürfen wiederholen
    if (isStudent(id) && !isAdmin(id) && !isTeacher(id)) {
      const existing = vms.find(
        (v) =>
          tagValue(v.tags, TAG.VM_OWNER_PREFIX) === id.oid &&
          tagValue(v.tags, TAG.VM_TPL_PREFIX) === String(templateId)
      );
      if (existing) {
        res.status(409).json({
          error: "You already have a VM from this template",
          vmid: existing.vmid,
        });
        return;
      }
    }
    // VMID picken
    const nextId = await pickFreeVmid();
    const safeName = buildVmName(id.email, templateId, nextId);
    const task = await proxmox!.cloneFromTemplate(tpl.node, tpl.vmid, {
      newid: nextId,
      name: safeName,
      full: true,
    });
    // Tag-Finalize im Hintergrund: clone uebernimmt die Template-Tags
    // (`pttool-tpl;tpl-class-...;tpl-owner-...`), wir brauchen aber das
    // VM-Schema (`pttool;vm-owner-<oid>;vm-tpl-<tplid>`). Polling, weil
    // updateConfig waehrend des Clone-Tasks mit "VM is locked" failt.
    finalizeClonedVmTags(tpl.node, nextId, tpl.vmid, id.oid).catch((e) =>
      console.error("[bridge] finalizeClonedVmTags failed:", e)
    );
    res.status(202).json({
      task,
      newVmid: nextId,
      note: "Clone task enqueued. Tags werden im Hintergrund umgeschrieben.",
    });
  } catch (err) {
    proxmoxErrorResponse(res, err);
  }
});

async function finalizeClonedVmTags(
  node: string,
  newVmid: VMID,
  templateVmid: VMID,
  ownerOid: string
): Promise<void> {
  const targetTags = [
    TAG.VM_MARKER,
    `${TAG.VM_OWNER_PREFIX}${ownerOid}`,
    `${TAG.VM_TPL_PREFIX}${templateVmid}`,
  ];
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      await proxmox!.updateConfig(node, newVmid, { tags: targetTags });
      console.log(`[bridge] finalized tags on VM ${newVmid} after ${attempt + 1} attempts`);
      return;
    } catch (e) {
      // Clone task vermutlich noch laufend (Proxmox: "VM is locked"). Weiterversuchen.
      if (attempt === 29) {
        console.warn(`[bridge] gave up finalizing VM ${newVmid} tags after 60s: ${
          e instanceof Error ? e.message : String(e)
        }`);
      }
    }
  }
}

async function pickFreeVmid(): Promise<VMID> {
  // Proxmox /cluster/nextid liefert den naechsten freien.
  // Aber listVMs reicht uns — wir nehmen max+1.
  const all = await proxmox!.listVMs();
  if (all.length === 0) return 100;
  const max = Math.max(...all.map((v) => v.vmid));
  return max + 1;
}

app.post("/api/vms/:vmid/start", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  await vmAction(req, res, "start");
});
app.post("/api/vms/:vmid/shutdown", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  await vmAction(req, res, "shutdown");
});
app.post("/api/vms/:vmid/stop", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  await vmAction(req, res, "stop");
});
app.delete("/api/vms/:vmid", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  await vmAction(req, res, "delete");
});

// Disk anhaengen. Admin/Lehrer (canModify) duerfen Disks an alle VMs in
// ihrem Sichtbereich attachen; Schueler an ihre eigene VM.
app.post("/api/vms/:vmid/disk", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  try {
    const vmid = Number(req.params.vmid);
    if (!Number.isFinite(vmid)) {
      res.status(400).json({ error: "vmid must be a number" });
      return;
    }
    const sizeGb = Number(req.body?.sizeGb);
    const storage = String(req.body?.storage ?? "");
    const slot = req.body?.slot ? String(req.body.slot) : undefined;
    if (!Number.isFinite(sizeGb) || sizeGb <= 0 || sizeGb > 256) {
      res.status(400).json({ error: "sizeGb must be 1..256" });
      return;
    }
    if (!storage) {
      res.status(400).json({ error: "storage required (e.g. local-lvm)" });
      return;
    }
    const { vms, templatesByVmid } = await listAllProxmoxVms();
    const vm = vms.find((v) => v.vmid === vmid);
    if (!vm) {
      res.status(404).json({ error: "VM not found" });
      return;
    }
    if (!canModifyVm(vm, req.identity!, templatesByVmid)) {
      res.status(403).json({ error: "Not allowed" });
      return;
    }
    await proxmox!.attachDisk(vm.node, vm.vmid, { storage, sizeGb, slot });
    res.status(200).json({ ok: true, slot: slot ?? "scsi0", sizeGb, storage });
  } catch (err) {
    proxmoxErrorResponse(res, err);
  }
});

async function vmAction(
  req: express.Request,
  res: express.Response,
  action: "start" | "shutdown" | "stop" | "delete"
) {
  try {
    const vmid = Number(req.params.vmid);
    if (!Number.isFinite(vmid)) {
      res.status(400).json({ error: "vmid must be a number" });
      return;
    }
    const { vms, templatesByVmid } = await listAllProxmoxVms();
    const vm = vms.find((v) => v.vmid === vmid);
    if (!vm) {
      res.status(404).json({ error: "VM not found" });
      return;
    }
    if (!canModifyVm(vm, req.identity!, templatesByVmid)) {
      res.status(403).json({ error: "Not allowed" });
      return;
    }
    const task =
      action === "start"
        ? await proxmox!.startVM(vm.node, vm.vmid)
        : action === "shutdown"
          ? await proxmox!.shutdownVM(vm.node, vm.vmid)
          : action === "stop"
            ? await proxmox!.stopVM(vm.node, vm.vmid)
            : await proxmox!.deleteVM(vm.node, vm.vmid);
    res.status(202).json({ task });
  } catch (err) {
    proxmoxErrorResponse(res, err);
  }
}

function proxmoxErrorResponse(res: express.Response, err: unknown) {
  if (axios.isAxiosError(err)) {
    res.status(err.response?.status ?? 502).json({
      error: "Proxmox call failed",
      details: err.response?.data,
      message: err.message,
    });
  } else {
    res.status(500).json({
      error: "Bridge error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

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
      const TAG_PREFIX = "tpl-class-";
      const activeClassOids = new Set<string>();
      for (const v of vms) {
        for (const t of v.tags) {
          if (t.startsWith(TAG_PREFIX)) activeClassOids.add(t.slice(TAG_PREFIX.length));
        }
      }
      res.json({
        url: PROXMOX_URL,
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

// ── VNC-Websocket-Proxy ────────────────────────────────────────────────────────
// Flow:
//  1. Frontend ruft POST /api/vms/:vmid/vnc-session  -> Bridge ruft vncproxy auf
//     Proxmox auf, kriegt ticket+port, speichert in vncSessions-Map mit
//     einmalig nutzbarem session-key. Returns: { sessionKey, password: ticket }
//  2. Frontend oeffnet WS auf /ws/vnc/:vmid?session=KEY
//  3. Bridge schlaegt session-key in Map nach (single-use, delete on read),
//     oeffnet upstream-WS zum Proxmox-vncwebsocket-Endpoint mit dem ticket
//     im Query + API-Token im Authorization-Header, tunnels Binary-Frames.
//  4. noVNC im Frontend nutzt den ticket als RFB-Password -- Proxmox-VNC
//     macht VncAuth gegen genau diesen ticket-string.

const VNC_SESSION_TTL_MS = 60_000;
interface VncSession {
  vmid: number;
  node: string;
  ticket: string;
  port: string;
  ownerOid: string;
  expiresAt: number;
}
const vncSessions = new Map<string, VncSession>();

function generateSessionKey(): string {
  // 32 hex chars — collision-resistant for a 60s in-memory map.
  return randomBytes(16).toString("hex");
}

app.post("/api/vms/:vmid/vnc-session", requireAuth, requireIdentity, async (req, res) => {
  if (!requireProxmox(res)) return;
  try {
    const vmid = Number(req.params.vmid);
    if (!Number.isFinite(vmid)) {
      res.status(400).json({ error: "vmid must be a number" });
      return;
    }
    const { vms, templatesByVmid } = await listAllProxmoxVms();
    const vm = vms.find((v) => v.vmid === vmid);
    if (!vm) {
      res.status(404).json({ error: "VM not found" });
      return;
    }
    if (!canSeeVm(vm, req.identity!, templatesByVmid)) {
      res.status(403).json({ error: "Not allowed" });
      return;
    }
    const proxyResp = await axios.post<{
      data: { port: string; ticket: string; user: string; upid: string };
    }>(
      `${PROXMOX_URL.replace(/\/+$/, "")}/api2/json/nodes/${vm.node}/qemu/${vm.vmid}/vncproxy`,
      "websocket=1",
      {
        headers: {
          Authorization: `PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: !PROXMOX_TLS_INSECURE }),
        timeout: 10000,
      }
    );
    const { ticket, port } = proxyResp.data.data;
    const sessionKey = generateSessionKey();
    vncSessions.set(sessionKey, {
      vmid: vm.vmid,
      node: vm.node,
      ticket,
      port,
      ownerOid: req.identity!.oid,
      expiresAt: Date.now() + VNC_SESSION_TTL_MS,
    });
    res.json({ sessionKey, password: ticket, port });
  } catch (err) {
    proxmoxErrorResponse(res, err);
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/ws/vnc/")) {
    socket.destroy();
    return;
  }
  const vmidRaw = url.pathname.slice("/ws/vnc/".length);
  const vmid = Number(vmidRaw);
  const sessionKey = url.searchParams.get("session");
  if (!Number.isFinite(vmid) || !sessionKey) {
    socket.destroy();
    return;
  }
  const session = vncSessions.get(sessionKey);
  if (!session || session.expiresAt < Date.now() || session.vmid !== vmid) {
    vncSessions.delete(sessionKey);
    socket.destroy();
    return;
  }
  // Single-use: ein Session-Key entspricht genau einer WS-Verbindung.
  vncSessions.delete(sessionKey);

  wss.handleUpgrade(req, socket, head, (clientWs) => {
    proxyVncSession(clientWs, session).catch((err) =>
      console.error("[bridge] vnc proxy session error:", err)
    );
  });
});

async function proxyVncSession(clientWs: WebSocket, session: VncSession): Promise<void> {
  const wsBase = PROXMOX_URL.replace(/^http/, "ws").replace(/\/+$/, "");
  const upstreamUrl =
    `${wsBase}/api2/json/nodes/${session.node}/qemu/${session.vmid}/vncwebsocket` +
    `?port=${encodeURIComponent(session.port)}` +
    `&vncticket=${encodeURIComponent(session.ticket)}`;

  const upstream = new WebSocket(upstreamUrl, ["binary"], {
    headers: {
      Authorization: `PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}`,
    },
    rejectUnauthorized: !PROXMOX_TLS_INSECURE,
    perMessageDeflate: false,
  });

  const cleanup = (why: string) => {
    if (clientWs.readyState === clientWs.OPEN) clientWs.close(1000, why);
    if (upstream.readyState === upstream.OPEN) upstream.close(1000, why);
  };

  upstream.on("open", () => {
    console.log(`[bridge] vnc proxy connected: vmid=${session.vmid} port=${session.port}`);
  });
  upstream.on("message", (data, isBinary) => {
    if (clientWs.readyState === clientWs.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });
  upstream.on("error", (err) => {
    console.error(`[bridge] upstream vnc error vmid=${session.vmid}:`, err.message);
    cleanup("upstream-error");
  });
  upstream.on("close", (code, reason) => {
    console.log(
      `[bridge] upstream vnc closed vmid=${session.vmid} code=${code} reason=${reason.toString()}`
    );
    cleanup("upstream-closed");
  });

  clientWs.on("message", (data, isBinary) => {
    if (upstream.readyState === upstream.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });
  clientWs.on("error", (err) => {
    console.error(`[bridge] client vnc error vmid=${session.vmid}:`, err.message);
    cleanup("client-error");
  });
  clientWs.on("close", (code, reason) => {
    console.log(
      `[bridge] client vnc closed vmid=${session.vmid} code=${code} reason=${reason.toString()}`
    );
    cleanup("client-closed");
  });
}

// Periodische TTL-Aufraeumung, damit verfallene Sessions nicht im Speicher hocken.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of vncSessions) if (v.expiresAt < now) vncSessions.delete(k);
}, VNC_SESSION_TTL_MS);

server.listen(PORT, () => {
  console.log(`[bridge] listening on http://localhost:${PORT}`);
});
