// Ask StereoNET usage/history module — proxies PULSE's frontend to the
// ask-stereonet backend's internal /api/stats endpoint (usage counts,
// backend/model breakdown, daily Anthropic spend-cap status, and recent
// question/answer history). The upstream endpoint requires a shared secret
// token that only server-to-server calls should ever see, so PULSE's own
// backend holds that token and the frontend never does.

import type { Express } from "express";

const ASK_STEREONET_BASE_URL = process.env.ASK_STEREONET_BASE_URL || "https://ask.stereonet.com";
const ASK_STEREONET_STATS_TOKEN = process.env.ASK_STEREONET_STATS_TOKEN || "";

async function fetchStats(limit: number): Promise<any> {
  if (!ASK_STEREONET_STATS_TOKEN) {
    throw new Error("ASK_STEREONET_STATS_TOKEN not configured on PULSE server");
  }
  const r = await fetch(`${ASK_STEREONET_BASE_URL}/api/stats?limit=${limit}`, {
    headers: { "x-stats-token": ASK_STEREONET_STATS_TOKEN },
  });
  const text = await r.text();
  let j: any;
  try { j = JSON.parse(text); } catch { throw new Error(`Non-JSON response (${r.status}): ${text.slice(0, 200)}`); }
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

export function registerAskStereonetRoutes(app: Express) {
  const requireSession = (req: any, res: any, next: any) => {
    if (!req.session?.username) return res.status(401).json({ message: "Auth required" });
    next();
  };

  // GET /api/ask-stereonet/stats?limit=N — usage totals + recent Q&A history
  app.get("/api/ask-stereonet/stats", requireSession, async (req: any, res: any) => {
    try {
      const limit = Math.min(200, parseInt(String(req.query.limit || "50"), 10) || 50);
      const data = await fetchStats(limit);
      res.json({ ok: true, ...data });
    } catch (e: any) {
      res.status(500).json({ ok: false, message: e?.message || "Failed to reach Ask StereoNET" });
    }
  });
}
