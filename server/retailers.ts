// Retailers module — calls the EE PHP bridge for read-only access to the
// Retailers channel (channel_id = 19), and stores its own first-party hit /
// outbound-click counts in SQLite for weekly analytics per retailer.
//
// The PHP bridge lives on the stereonet.com EE host at /pulse-bridge.php and
// only accepts whitelisted named queries from a single shared token.
// See server/ee-bridge.php for the source.

import type { Express } from "express";
import { sqlite } from "./storage";

const EE_BRIDGE_URL = process.env.EE_BRIDGE_URL || "https://www.stereonet.com/ee-bridge.php";
const EE_BRIDGE_TOKEN = process.env.EE_BRIDGE_TOKEN || "sn-ee-br1dge-9F2kRm8WqLpYx4vN7Bc3Hd";
// Dedicated tracking-ingest token. Distinct from the bridge token so a leak
// of one doesn't compromise the other.
const PULSE_TRACK_TOKEN = process.env.PULSE_TRACK_TOKEN || "sn-trk-9D2mQp4XzKt8Yr6Lv3Nw7Bf";

// --- EE bridge client ------------------------------------------------------
async function callBridge(query: string, params: Record<string, any> = {}): Promise<any> {
  const r = await fetch(EE_BRIDGE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pulse-Token": EE_BRIDGE_TOKEN,
      "User-Agent": "PULSE/retailers",
    },
    body: JSON.stringify({ query, params }),
  });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error(`Bridge non-JSON (${r.status}): ${text.slice(0, 200)}`); }
  if (!r.ok || !j.ok) throw new Error(`Bridge error: ${j.error || r.status} ${j.detail || ""}`);
  return j.result;
}

// --- Local tables (tracking) ----------------------------------------------
function ensureTables() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS retailer_hits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      ip TEXT,
      country TEXT,
      ua TEXT,
      referrer TEXT,
      recipient_token TEXT
    );
    CREATE INDEX IF NOT EXISTS retailer_hits_entry_ts ON retailer_hits(entry_id, ts);

    CREATE TABLE IF NOT EXISTS retailer_clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entry_id INTEGER NOT NULL,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      url TEXT,
      ip TEXT,
      country TEXT,
      ua TEXT,
      referrer TEXT
    );
    CREATE INDEX IF NOT EXISTS retailer_clicks_entry_ts ON retailer_clicks(entry_id, ts);
    CREATE INDEX IF NOT EXISTS retailer_clicks_url ON retailer_clicks(url);

    -- Locally-cached metadata: which custom-field column holds the "Premium" flag.
    -- Discovered once via the bridge then cached so the list page is fast.
    CREATE TABLE IF NOT EXISTS retailer_field_map (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}
ensureTables();

// --- Premium-field auto-discovery -----------------------------------------
// EE custom fields live in exp_channel_data as columns named field_id_NN.
// We expose the human field name + auto-detect the most likely "premium"
// candidate. The admin can override via the setting key 'retailer_premium_field'.
async function discoverPremiumField(): Promise<{ field: string | null; fields: any[] }> {
  const fieldsResp = await callBridge("fields");
  const fields: any[] = fieldsResp.fields || [];
  // Look for an obvious match by label or name
  const candidate = fields.find((f) => /preferred|premium|featured/i.test(`${f.field_name} ${f.field_label}`));
  return { field: candidate ? `field_id_${candidate.field_id}` : null, fields };
}

function getMappedPremiumField(): string | null {
  const row = sqlite.prepare(`SELECT value FROM retailer_field_map WHERE key = 'premium_field'`).get() as any;
  return row?.value || null;
}

function setMappedPremiumField(field: string) {
  sqlite.prepare(`
    INSERT INTO retailer_field_map (key, value, updated_at) VALUES ('premium_field', ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(field);
}

// --- Country lookup (best-effort, optional) -------------------------------
function ipCountry(req: any): string {
  return (req.headers["cf-ipcountry"] as string) || "";
}
function realIp(req: any): string {
  return (req.headers["cf-connecting-ip"] as string)
    || (req.headers["x-forwarded-for"] as string || "").split(",")[0].trim()
    || req.ip
    || "";
}

// ===========================================================================
export function registerRetailerRoutes(app: Express) {
  // ---- TRACKING INGEST -----------------------------------------------------
  // Only one entry point. The previous browser-direct /track/r and
  // /track/r/click routes were removed because they were unauthenticated and
  // would allow anyone to fake retailer hit counts. All tracking now flows:
  //
  //   browser <img src> --> www.stereonet.com/track-r.php
  //                                |
  //                                v
  //          (EE host server-to-server with token)
  //                                |
  //                                v
  //   dashboard.stereonet.com/api/retailers/ingest
  //
  // The ingest endpoint enforces:
  //   1. A dedicated tracking token (X-Pulse-Track-Token), separate from the
  //      EE bridge token.
  //   2. A simple per-source-IP rate limit so a leaked token can't be used
  //      to flood the table.
  //   3. Input length caps + entry_id integer cast.
  //
  // The IP/country/UA in the payload are produced by track-r.php from CF
  // headers on the EE host. We trust them only because the request had a
  // valid token; they are NOT authoritative client identifiers.
  const RATE_LIMIT_WINDOW_MS = 60_000;
  const RATE_LIMIT_MAX = 300; // 300 hits/min per source IP is generous for legit traffic
  const rateBucket = new Map<string, { count: number; resetAt: number }>();
  function rateLimitOk(sourceIp: string): boolean {
    const now = Date.now();
    const b = rateBucket.get(sourceIp);
    if (!b || b.resetAt < now) {
      rateBucket.set(sourceIp, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    b.count += 1;
    return b.count <= RATE_LIMIT_MAX;
  }

  app.post("/api/retailers/ingest", (req: any, res: any) => {
    // Token check first — cheapest reject path.
    const token = String(req.headers["x-pulse-track-token"] || "");
    if (token !== PULSE_TRACK_TOKEN || !token) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }
    // Source IP is the actual TCP peer (or CF-provided), not the spoofable
    // payload field. Used only for rate limiting.
    const sourceIp = realIp(req) || "unknown";
    if (!rateLimitOk(sourceIp)) {
      return res.status(429).json({ ok: false, error: "rate_limited" });
    }
    try {
      const b = req.body || {};
      const entryId = parseInt(String(b.entry_id || "0"), 10);
      if (!entryId || entryId < 1 || entryId > 2_147_483_647) {
        return res.json({ ok: true, skipped: "invalid entry_id" });
      }
      const ip = String(b.ip || "").slice(0, 64);
      const country = String(b.country || "").slice(0, 8);
      const ua = String(b.ua || "").slice(0, 500);
      const referrer = String(b.referrer || "").slice(0, 500);
      const kind = String(b.kind || "hit");
      if (kind === "click") {
        const url = String(b.url || "").slice(0, 1000);
        sqlite.prepare(`INSERT INTO retailer_clicks (entry_id, url, ip, country, ua, referrer) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(entryId, url, ip, country, ua, referrer);
      } else {
        const recipient = String(b.recipient || "").slice(0, 100) || null;
        sqlite.prepare(`INSERT INTO retailer_hits (entry_id, ip, country, ua, referrer, recipient_token) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(entryId, ip, country, ua, referrer, recipient);
      }
      res.json({ ok: true });
    } catch (e: any) {
      // Don't leak DB error detail to the caller; log internally.
      console.error("[retailers/ingest] write failed:", e?.message);
      res.status(500).json({ ok: false, error: "write_failed" });
    }
  });

  // ---- ADMIN API (requires session) ---------------------------------------
  // Note: requireAuth middleware mirrors pattern used elsewhere. PULSE
  // currently gates admin pages by session role; we reuse that.
  const requireSession = (req: any, res: any, next: any) => {
    if (!req.session?.username) return res.status(401).json({ message: "Auth required" });
    next();
  };

  // GET /api/retailers — list + counts
  app.get("/api/retailers", requireSession, async (req: any, res: any) => {
    try {
      const search = String(req.query.search || "");
      const limit = Math.min(500, parseInt(String(req.query.limit || "200"), 10));
      const offset = Math.max(0, parseInt(String(req.query.offset || "0"), 10));
      const premiumOnly = String(req.query.premium || "") === "1";
      const standardOnly = String(req.query.standard || "") === "1";

      let premiumField = getMappedPremiumField();
      if (!premiumField) {
        const disc = await discoverPremiumField();
        if (disc.field) {
          setMappedPremiumField(disc.field);
          premiumField = disc.field;
        }
      }

      const data = await callBridge("list_retailers", { search, limit, offset });
      const rows: any[] = data.rows || [];

      // Annotate each row with a normalised premium flag based on the mapped field.
      const isTruthy = (raw: any): boolean => {
        if (raw == null) return false;
        const v = String(raw).toLowerCase().trim();
        if (v === "" || v === "0" || v === "n" || v === "no" || v === "false" || v === "off" || v === "null") return false;
        // EE checkboxes fields store values as \nLabel\n or comma-separated; any
        // non-empty value other than the explicit falsy list above counts as
        // checked. This also covers 'y'/'1'/'yes'/'true'/'on'/'premium'.
        return true;
      };

      const normalised = rows.map((r) => {
        let isPremium = false;
        if (premiumField && r[premiumField] != null) {
          isPremium = isTruthy(r[premiumField]);
        }
        return {
          entry_id: r.entry_id,
          title: r.title,
          url_title: r.url_title,
          status: r.status,
          entry_date: r.entry_date,
          edit_date: r.edit_date,
          view_count_one: Number(r.view_count_one) || 0,
          author_username: r.author_username,
          author_screen: r.author_screen,
          is_premium: isPremium,
          public_url: `https://www.stereonet.com/retailers/${r.url_title}`,
        };
      });

      // Filter by premium flag client-side post-annotation
      const filtered = normalised.filter((r) =>
        premiumOnly ? r.is_premium : standardOnly ? !r.is_premium : true
      );

      // Attach weekly hit + click counts (last 7 days) for the filtered set
      const ids = filtered.map((r) => r.entry_id);
      const counts = new Map<number, { hits: number; clicks: number }>();
      if (ids.length) {
        const placeholders = ids.map(() => "?").join(",");
        const hitRows = sqlite.prepare(`SELECT entry_id, COUNT(*) AS n FROM retailer_hits WHERE entry_id IN (${placeholders}) AND ts >= datetime('now','-7 days') GROUP BY entry_id`).all(...ids) as any[];
        const clickRows = sqlite.prepare(`SELECT entry_id, COUNT(*) AS n FROM retailer_clicks WHERE entry_id IN (${placeholders}) AND ts >= datetime('now','-7 days') GROUP BY entry_id`).all(...ids) as any[];
        for (const id of ids) counts.set(id, { hits: 0, clicks: 0 });
        for (const r of hitRows) counts.get(r.entry_id)!.hits = r.n;
        for (const r of clickRows) counts.get(r.entry_id)!.clicks = r.n;
      }
      const out = filtered.map((r) => ({ ...r, hits_7d: counts.get(r.entry_id)?.hits || 0, clicks_7d: counts.get(r.entry_id)?.clicks || 0 }));

      res.json({
        ok: true,
        total: data.total,
        limit: data.limit,
        offset: data.offset,
        premium_field: premiumField,
        rows: out,
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, message: e?.message || "Failed" });
    }
  });

  // GET /api/retailers/fields — list custom fields + which one is "premium"
  app.get("/api/retailers/fields", requireSession, async (_req: any, res: any) => {
    try {
      const fields = await callBridge("fields");
      const mapped = getMappedPremiumField();
      res.json({ ok: true, mapped_premium_field: mapped, ...fields });
    } catch (e: any) {
      res.status(500).json({ ok: false, message: e?.message });
    }
  });

  // POST /api/retailers/fields/premium { field } — admin sets the mapping
  app.post("/api/retailers/fields/premium", requireSession, (req: any, res: any) => {
    const field = String(req.body?.field || "");
    if (!/^field_id_\d+$/.test(field)) return res.status(400).json({ ok: false, message: "field must be field_id_NN" });
    setMappedPremiumField(field);
    res.json({ ok: true, field });
  });

  // POST /api/retailers/:id/premium { value: "yes"|"" } — toggle Premium
  app.post("/api/retailers/:id/premium", requireSession, async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id, 10);
      const rawValue = String(req.body?.value ?? "");
      const value = rawValue === "yes" ? "yes" : "";
      if (!id) return res.status(400).json({ ok: false, message: "id required" });
      const r = await callBridge("set_field_value", { entry_id: id, field_id: 133, value });
      res.json({ ok: true, result: r });
    } catch (e: any) {
      res.status(500).json({ ok: false, message: e?.message });
    }
  });

  // POST /api/retailers/:id/status { value } — change entry status
  app.post("/api/retailers/:id/status", requireSession, async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id, 10);
      const value = String(req.body?.value || "");
      if (!id) return res.status(400).json({ ok: false, message: "id required" });
      const r = await callBridge("set_entry_field", { entry_id: id, column: "status", value });
      res.json({ ok: true, result: r });
    } catch (e: any) {
      res.status(500).json({ ok: false, message: e?.message });
    }
  });

  // GET /api/retailers/:id — detail with custom fields + analytics
  app.get("/api/retailers/:id", requireSession, async (req: any, res: any) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ ok: false, message: "id required" });
      const row = await callBridge("get_retailer", { entry_id: id });
      if (row?.error) return res.status(404).json({ ok: false, message: row.error });

      const weeks = 12;
      const weekly = sqlite.prepare(`
        SELECT strftime('%Y-%W', ts) AS yw,
               COUNT(*) AS hits
          FROM retailer_hits
         WHERE entry_id = ?
           AND ts >= datetime('now','-${weeks * 7} days')
         GROUP BY yw
         ORDER BY yw ASC
      `).all(id) as any[];

      const weeklyClicks = sqlite.prepare(`
        SELECT strftime('%Y-%W', ts) AS yw,
               COUNT(*) AS clicks
          FROM retailer_clicks
         WHERE entry_id = ?
           AND ts >= datetime('now','-${weeks * 7} days')
         GROUP BY yw
         ORDER BY yw ASC
      `).all(id) as any[];

      const topUrls = sqlite.prepare(`
        SELECT url, COUNT(*) AS n
          FROM retailer_clicks
         WHERE entry_id = ?
           AND ts >= datetime('now','-30 days')
         GROUP BY url
         ORDER BY n DESC
         LIMIT 20
      `).all(id) as any[];

      const premiumField = getMappedPremiumField();
      const isTruthy = (raw: any): boolean => {
        if (raw == null) return false;
        const v = String(raw).toLowerCase().trim();
        if (v === "" || v === "0" || v === "n" || v === "no" || v === "false" || v === "off" || v === "null") return false;
        return true;
      };
      const isPremium = premiumField ? isTruthy(row[premiumField]) : false;

      res.json({
        ok: true,
        retailer: {
          ...row,
          is_premium: isPremium,
          premium_field: premiumField,
          public_url: `https://www.stereonet.com/retailers/${row.url_title}`,
        },
        analytics: {
          weeks,
          weekly_hits: weekly,
          weekly_clicks: weeklyClicks,
          top_outbound_urls: topUrls,
        },
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, message: e?.message });
    }
  });

  // GET /api/retailers/_diag — confirms PULSE can reach the bridge
  app.get("/api/retailers/_diag", requireSession, async (_req: any, res: any) => {
    try {
      const ping = await callBridge("ping");
      res.json({ ok: true, ping, bridge_url: EE_BRIDGE_URL });
    } catch (e: any) {
      res.json({ ok: false, message: e?.message, bridge_url: EE_BRIDGE_URL });
    }
  });
}
