/**
 * Pulse realtime layer, backed by Ably.
 *
 * Events are published on a single channel: `pulse`.
 * Message names:
 *   article.new         \u2014 new article ingested
 *   article.dismissed   \u2014 dismissed by any user
 *   article.claimed     \u2014 claimed by a user
 *   article.unclaimed   \u2014 claim released
 *   article.covered     \u2014 marked as already covered
 *   article.written     \u2014 marked written (published)
 *   article.pinned      \u2014 admin pinned
 *   notification.new    \u2014 new in-app notification
 *   top-picks.regenerated\u2014 AI picks regenerated
 *   trending.new        \u2014 trending-posts cache refreshed
 *
 * Presence is on a separate channel: `pulse-presence`. Each logged-in client joins
 * with their username so "who's online" works.
 *
 * If ABLY_API_KEY is not set, publish() is a no-op \u2014 the server functions normally.
 */
import { cfg } from "./config";

// Lazy-load Ably so a missing module or broken install can't prevent server startup.
let AblyModule: any = null;
let ablyLoadFailed = false;
function loadAbly(): any {
  if (AblyModule) return AblyModule;
  if (ablyLoadFailed) return null;
  try {
    AblyModule = require("ably");
    return AblyModule;
  } catch (e: any) {
    ablyLoadFailed = true;
    console.error("[realtime] Ably module not available:", e.message);
    return null;
  }
}

export const PULSE_CHANNEL = "pulse";
export const PULSE_PRESENCE_CHANNEL = "pulse-presence";

let client: any = null;
let cachedKey: string = "";

function getClient(): any {
  const key = cfg("ABLY_API_KEY");
  if (!key) {
    if (client) { client = null; cachedKey = ""; }
    return null;
  }
  if (client && cachedKey === key) return client;
  const Ably = loadAbly();
  if (!Ably) return null;
  try {
    // queryTime:false means the SDK won't call Ably's /time endpoint before
    // signing — keeps the whole path fully local and fast.
    client = new Ably.Rest({ key, queryTime: false });
    cachedKey = key;
    return client;
  } catch (e: any) {
    console.error("[realtime] failed to init Ably:", e.message);
    return null;
  }
}

export function publish(event: string, data: any): void {
  if (cfg("REALTIME_DISABLED") === "1") return;
  try {
    const c = getClient();
    if (!c) return;
    const channel = c.channels.get(PULSE_CHANNEL);
    const p = channel.publish(event, data);
    if (p && typeof p.catch === "function") {
      p.catch((e: any) => console.error(`[realtime] publish ${event} failed:`, e?.message));
    }
  } catch (e: any) {
    // Never throw into the caller — realtime is best-effort.
    console.error(`[realtime] publish ${event} threw:`, e?.message);
  }
}

/**
 * Issue a short-lived token request for a browser client.
 * Clients call GET /api/realtime/token to get a signed tokenRequest they can use
 * to authenticate with Ably without ever seeing the raw API key.
 */
/**
 * Build an Ably tokenRequest manually using HMAC-SHA-256. Pure local crypto,
 * no SDK async call. Keeps the HTTP handler sub-millisecond.
 *
 * Ably tokenRequest format:
 *   { keyName, clientId, capability, timestamp, nonce, ttl, mac }
 * where mac = base64( HMAC-SHA256( keySecret, keyName + "\n" + ttl + "\n" + capability + "\n" + clientId + "\n" + timestamp + "\n" + nonce + "\n" ) )
 */
import crypto from "crypto";

export async function createTokenRequest(clientId: string): Promise<any> {
  const key = cfg("ABLY_API_KEY");
  if (!key) return null;
  const [keyName, keySecret] = key.split(":");
  if (!keyName || !keySecret) {
    console.error("[realtime] ABLY_API_KEY malformed (expected keyName:keySecret)");
    return null;
  }

  const capability = JSON.stringify({
    [PULSE_CHANNEL]: ["subscribe", "history"],
    [PULSE_PRESENCE_CHANNEL]: ["subscribe", "publish", "presence"],
  });
  const ttl = 60 * 60 * 1000; // 1 hour
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(16).toString("hex");

  const signText = [keyName, ttl, capability, clientId, timestamp, nonce].join("\n") + "\n";
  const mac = crypto.createHmac("sha256", keySecret).update(signText).digest("base64");

  return { keyName, clientId, capability, timestamp, nonce, ttl, mac };
}

export function isRealtimeConfigured(): boolean {
  // Hard kill-switch: set REALTIME_DISABLED=1 (env or app_settings) to turn
  // realtime off globally regardless of whether an Ably key is configured.
  if (cfg("REALTIME_DISABLED") === "1") return false;
  return !!cfg("ABLY_API_KEY");
}
