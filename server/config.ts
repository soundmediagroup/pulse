/**
 * Runtime configuration layer.
 *
 * Lookup order per key:
 *   1. app_settings DB (editable via Admin UI at runtime)
 *   2. process.env (loaded from .env at container start)
 *   3. default value (if provided)
 *
 * Secrets (MSGRAPH_CLIENT_SECRET, ANTHROPIC_API_KEY, WEBHOOK_INGEST_TOKEN, etc.)
 * are stored as-is in app_settings; access is already gated by admin-role session.
 * If stricter protection is needed later, swap `storeValue`/`readValue` for an
 * encrypted variant \u2014 the API surface stays the same.
 */
import { storage } from "./storage";
import crypto from "crypto";

// Keys managed via the Admin Settings UI. If a key isn't listed here but is
// requested via cfg(), it still works \u2014 it just won't appear in the UI.
export interface SettingDef {
  key: string;
  label: string;
  group: "webhook" | "email" | "ai" | "analytics" | "realtime" | "misc";
  secret: boolean;           // secret values are masked in GET responses
  description?: string;
  default?: string;
  // If true, a fresh random value can be auto-generated from the UI.
  autoGenerate?: boolean;
}

export const SETTINGS_CATALOG: SettingDef[] = [
  // Webhook
  {
    key: "WEBHOOK_INGEST_TOKEN",
    label: "Webhook ingest token",
    group: "webhook",
    secret: true,
    autoGenerate: true,
    description: "Bearer token for POST /api/ingest/article. Rotate by clicking Regenerate.",
  },
  {
    key: "DEPLOY_TOKEN",
    label: "Deploy / admin-diag token",
    group: "webhook",
    secret: true,
    autoGenerate: true,
    description: "Bearer token (x-deploy-token header) that bypasses session auth for POST /api/deploy and all /api/admin/diag/* routes. Treat as equivalent to an admin password \u2014 rotate immediately if it may have leaked, and rotate here (not just .env) since every call site now reads it via cfg().",
  },
  // Microsoft Graph (press mailbox)
  { key: "MSGRAPH_TENANT_ID",    label: "Microsoft tenant ID",   group: "email", secret: false, description: "Azure AD tenant ID for Graph auth." },
  { key: "MSGRAPH_CLIENT_ID",    label: "Microsoft client ID",    group: "email", secret: false, description: "Azure app registration client (application) ID." },
  { key: "MSGRAPH_CLIENT_SECRET",label: "Microsoft client secret",group: "email", secret: true,  description: "Client secret for the Azure app. Rotate here and in Azure portal together." },
  { key: "PRESS_MAILBOX",        label: "Press mailbox address",  group: "email", secret: false, description: "UPN (not SMTP alias) of the mailbox being polled." },
  // AI
  { key: "ANTHROPIC_API_KEY",    label: "Anthropic API key",      group: "ai", secret: true, description: "Used by Top Picks and Redline." },
  // Realtime
  { key: "ABLY_API_KEY",         label: "Ably API key",           group: "realtime", secret: true, description: "Ably API key for live updates (article changes, notifications, presence). Not currently used — realtime is disabled via kill-switch below." },
  { key: "REALTIME_DISABLED",    label: "Disable realtime (kill-switch)", group: "realtime", secret: false, description: "Set to '1' to turn off all Ably publishing and token issuance, regardless of whether an API key is configured. Leave empty to enable." },
  // Analytics
  { key: "GA4_PROPERTY_ID",      label: "GA4 property ID",        group: "analytics", secret: false },
  { key: "SEARCH_CONSOLE_SITE",  label: "Search Console site",    group: "analytics", secret: false },
  { key: "GOOGLE_CREDENTIALS_B64", label: "Google credentials (base64)", group: "analytics", secret: true, description: "Service account JSON, base64-encoded." },
  {
    key: "CLOUDFLARE_API_TOKEN",
    label: "Cloudflare API token",
    group: "analytics",
    secret: true,
    description: "Scoped token for Zone > Analytics > Read on the stereonet.com zone only. Must NOT be an account-level or Super Admin token \u2014 rotate immediately in the Cloudflare dashboard if this value is ever suspected leaked, then paste the new value here.",
  },
  {
    key: "CLOUDFLARE_ZONE_TAG",
    label: "Cloudflare zone tag",
    group: "analytics",
    secret: false,
    description: "Zone ID for stereonet.com in Cloudflare (not secret, just an identifier).",
  },
];

const DB_KEY_PREFIX = "cfg:";

function storeValue(key: string, value: string): void {
  storage.setSetting(DB_KEY_PREFIX + key, value);
}

function readValue(key: string): string | null {
  return storage.getSetting(DB_KEY_PREFIX + key);
}

/**
 * Primary accessor. Checks DB first, then env, then default.
 * Returns empty string if nothing is set and no default provided (never null \u2014
 * makes call sites simpler).
 */
export function cfg(key: string, defaultValue = ""): string {
  const dbVal = readValue(key);
  if (dbVal != null && dbVal !== "") return dbVal;
  const envVal = process.env[key];
  if (envVal != null && envVal !== "") return envVal;
  return defaultValue;
}

/** Has this key been explicitly set (in DB or env)? */
export function cfgIsSet(key: string): boolean {
  const dbVal = readValue(key);
  if (dbVal != null && dbVal !== "") return true;
  const envVal = process.env[key];
  return envVal != null && envVal !== "";
}

/** Returns source so the UI can show "set via .env" vs "set in UI". */
export function cfgSource(key: string): "db" | "env" | "unset" {
  const dbVal = readValue(key);
  if (dbVal != null && dbVal !== "") return "db";
  const envVal = process.env[key];
  if (envVal != null && envVal !== "") return "env";
  return "unset";
}

/** Admin-UI writer. Empty string deletes the DB override (falls back to env). */
export function setCfg(key: string, value: string): void {
  if (value === "") storage.setSetting(DB_KEY_PREFIX + key, "");
  else storeValue(key, value);
}

/** Generate a cryptographically random token (used by autoGenerate). */
export function generateToken(prefix = "sn-hook"): string {
  return `${prefix}-${crypto.randomBytes(12).toString("hex")}`;
}

/** Mask a secret value for safe display. */
export function maskSecret(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "\u2022".repeat(v.length);
  return `${v.slice(0, 4)}${"\u2022".repeat(Math.min(20, v.length - 8))}${v.slice(-4)}`;
}
