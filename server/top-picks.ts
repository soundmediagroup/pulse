// AI-driven "Top Picks Today" for Article Discovery.
// Uses Claude Sonnet 4.6 to pick the 3 most write-worthy stories from the day's
// Active items, with a short rationale and suggested angle for each.

import { storage } from "./storage";

import { cfg } from "./config";
function getApiKey() { return cfg("ANTHROPIC_API_KEY"); }
const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-6";
export const TOP_PICKS_VERSION = "1.0";

export interface TopPick {
  articleId: number;
  title: string;
  site: string;
  rationale: string;     // 2-3 sentences on why this is write-worthy
  angle: string;         // Suggested angle for StereoNET coverage
  score: number;         // 1-10 relative importance
}

interface TopPicksResult {
  date: string;
  generatedAt: string;
  picks: TopPick[];
  examined: number;      // Number of candidate articles considered
}

// Returns today's picks if they exist (does not generate)
export function getTopPicks(): TopPicksResult | null {
  const today = todayIsoDate();
  const row = storage.getTopPicks(today);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.picks_json);
    return {
      date: row.date,
      generatedAt: row.generated_at.endsWith("Z") ? row.generated_at : row.generated_at.replace(" ", "T") + "Z",
      picks: parsed.picks || [],
      examined: parsed.examined || 0,
    };
  } catch {
    return null;
  }
}

function todayIsoDate(): string {
  // Brisbane is UTC+10, no DST. Use Brisbane-local date so picks refresh at AEST midnight.
  const now = new Date();
  const brisbane = new Date(now.getTime() + 10 * 60 * 60 * 1000);
  return brisbane.toISOString().slice(0, 10);
}

// Generates today's Top Picks by calling Claude Sonnet 4.6.
// Caches the result in the DB (one row per day) so subsequent calls are free.
export async function generateTopPicks(opts?: { force?: boolean }): Promise<TopPicksResult | { error: string }> {
  const API_KEY = getApiKey();
  if (!API_KEY) {
    return { error: "ANTHROPIC_API_KEY not configured" };
  }

  const today = todayIsoDate();
  if (!opts?.force) {
    const existing = getTopPicks();
    if (existing) return existing;
  }

  // Pull the top 40 active discovery articles (uncovered + not-dismissed)
  const candidates = storage.getDiscoveryArticles({ limit: 100 })
    .filter((a: any) => !a.covered)
    .slice(0, 40);

  if (candidates.length === 0) {
    const result: TopPicksResult = { date: today, generatedAt: new Date().toISOString(), picks: [], examined: 0 };
    storage.setTopPicks(today, JSON.stringify({ picks: [], examined: 0 }));
    return result;
  }

  // Build a compact prompt — just enough for the model to evaluate
  const list = candidates.map((a: any, i: number) =>
    `[${a.id}] "${a.title}" — ${a.site}${a.description ? ` | ${String(a.description).slice(0, 180)}` : ""}`
  ).join("\n");

  const prompt = `You are the Editor-in-Chief's assistant at StereoNET, a high-end audio / hi-fi / home cinema publication. Your job is to scan today's industry news from competitor sites and press releases, and pick the 3 most write-worthy stories for StereoNET's writers.

Criteria for a pick:
- Relevance to the audiophile / hi-fi / AV enthusiast reader
- Newsworthiness (new product, major announcement, industry shift, exclusive scoop)
- Prefer stories with a clear angle (not just a rehash)
- Skip: generic consumer tech, pure spec sheets with no news value, items obviously promotional with no editorial hook
- Bias toward stories competitors are already running with (ride the news cycle)

Here are today's candidate articles (format: [id] "title" — site | snippet):

${list}

Return EXACTLY this JSON structure (no prose, no markdown fences):
{
  "picks": [
    {
      "articleId": <number from brackets>,
      "rationale": "2-3 concise sentences on why this matters to StereoNET readers",
      "angle": "One sentence suggesting a specific StereoNET angle",
      "score": <1-10 importance>
    }
  ]
}

Return exactly 3 picks, ranked by score descending. If fewer than 3 stories are genuinely write-worthy, return fewer.`;

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      return { error: `Anthropic API ${res.status}: ${text.slice(0, 300)}` };
    }
    const data: any = await res.json();
    const rawText: string = data.content?.[0]?.text || "";
    // Extract JSON — the model occasionally wraps in backticks
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { error: `Model returned non-JSON response: ${rawText.slice(0, 200)}` };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    const rawPicks: any[] = Array.isArray(parsed.picks) ? parsed.picks : [];

    // Enrich picks with title/site from candidates
    const byId = new Map(candidates.map((a: any) => [a.id, a]));
    const enriched: TopPick[] = rawPicks
      .filter(p => byId.has(p.articleId))
      .map(p => {
        const a = byId.get(p.articleId)!;
        return {
          articleId: p.articleId,
          title: a.title,
          site: a.site,
          rationale: String(p.rationale || "").slice(0, 500),
          angle: String(p.angle || "").slice(0, 300),
          score: Math.max(1, Math.min(10, Number(p.score) || 5)),
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const payload = { picks: enriched, examined: candidates.length };
    storage.setTopPicks(today, JSON.stringify(payload));
    console.log(`[top-picks] Generated ${enriched.length} picks from ${candidates.length} candidates`);

    return {
      date: today,
      generatedAt: new Date().toISOString(),
      picks: enriched,
      examined: candidates.length,
    };
  } catch (e: any) {
    return { error: `Generation failed: ${e.message}` };
  }
}
