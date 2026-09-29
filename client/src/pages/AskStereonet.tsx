import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface Source {
  title: string;
  url: string;
  section?: string;
}

interface QueryLogRow {
  id: number;
  ts: string;
  question: string;
  answer: string;
  backend: string;
  response_ms: number | null;
  sources: Source[];
  feedback: "up" | "down" | null;
  username: string | null;
  tier: "Lite" | "Pro";
  conversation_id: string | null;
  ip_hash: string | null;
}

// Conversation threading (added 28 Sep 2026, Marc's request - this was a
// flat list with no way to tell a follow-up question apart from a brand
// new, unrelated one). The widget sends one random conversation_id per
// panel-open session with every question asked in it; group rows by that
// id so a multi-turn conversation reads as one thread instead of N
// unrelated-looking rows scattered by pure recency. Rows logged before
// this shipped (or from a client that failed the beacon) have no
// conversation_id - each of those is its own singleton "thread", not an
// error case, since a null id has never been in the same conversation as
// any other row.
function groupIntoThreads(rows: QueryLogRow[]): QueryLogRow[][] {
  const groups = new Map<string, QueryLogRow[]>();
  let singletonSeq = 0;
  for (const r of rows) {
    const key = r.conversation_id || `__singleton_${singletonSeq++}`;
    const g = groups.get(key);
    if (g) g.push(r); else groups.set(key, [r]);
  }
  const threads = Array.from(groups.values()).map(g =>
    [...g].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
  );
  // Newest activity first, same ordering feel as the old flat list.
  threads.sort((a, b) => new Date(b[b.length - 1].ts).getTime() - new Date(a[a.length - 1].ts).getTime());
  return threads;
}

// Thumbs up/down feedback (added 23 Sep 2026, Jason Sexton's suggestion via
// Marc). Purely additive against the upstream /api/stats response - the
// server proxy above already spreads the whole payload through, so this
// field just needs to exist on the interface and get rendered.
interface FeedbackTally {
  up: number;
  down: number;
}

interface StatsResponse {
  ok: boolean;
  totals: { allTime: number; today: number; last7Days: number };
  avgResponseMsToday: number | null;
  byBackend: { backend: string; n: number }[];
  anthropicCapToday: { used: number; cap: number };
  feedback: { allTime: FeedbackTally; last7Days: FeedbackTally };
  recent: QueryLogRow[];
  message?: string;
}

const THREAD_RULE_COLOR = "border-[#e8312a]/30";

function fmtDate(ts: string) {
  const d = new Date(ts);
  return d.toLocaleString("en-AU", { timeZone: "Australia/Melbourne", dateStyle: "short", timeStyle: "short" });
}

function backendLabel(backend: string) {
  if (backend.startsWith("anthropic/")) return { text: backend.replace("anthropic/", "Claude "), color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
  if (backend.includes("fallback")) return { text: backend.replace("gpubox/", "gpubox: "), color: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
  return { text: backend.replace("gpubox/", "gpubox: "), color: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30" };
}

// Anonymous-user IP grouping (added 29 Sep 2026, Marc's request). Anonymous
// rows have no username; identify each by a short stable token derived from
// the upstream's already-hashed (salted SHA-256, irreversible) IP so multiple
// queries from the same anonymous IP read as one person/group instead of an
// indistinguishable wall of "Anonymous". The raw dotted IP is never available
// client-side - only the hash - so this token IS the grouping key, and each
// gets a stable colour per IP so same-IP rows link at a glance across separate
// conversation threads.
function anonLabel(ipHash: string | null): string {
  return ipHash ? `anon-${ipHash.slice(0, 6)}` : "anon-?";
}
const ANON_COLORS = [
  "bg-sky-500/15 text-sky-400 border-sky-500/30",
  "bg-violet-500/15 text-violet-400 border-violet-500/30",
  "bg-amber-500/15 text-amber-400 border-amber-500/30",
  "bg-teal-500/15 text-teal-400 border-teal-500/30",
  "bg-pink-500/15 text-pink-400 border-pink-500/30",
  "bg-lime-500/15 text-lime-400 border-lime-500/30",
];
function anonColor(ipHash: string | null): string {
  if (!ipHash) return "bg-zinc-500/10 text-zinc-400 border-zinc-500/30";
  let h = 0;
  for (let i = 0; i < ipHash.length; i++) h = (h * 31 + ipHash.charCodeAt(i)) >>> 0;
  return ANON_COLORS[h % ANON_COLORS.length];
}

export default function AskStereonet() {
  const [selected, setSelected] = useState<QueryLogRow | null>(null);

  const { data, isLoading, error, refetch } = useQuery<StatsResponse>({
    queryKey: ["/api/ask-stereonet/stats"],
    queryFn: () => apiRequest("GET", "/api/ask-stereonet/stats?limit=100").then(r => r.json()),
    refetchInterval: 60000,
  });

  const capPct = data?.anthropicCapToday ? Math.round((data.anthropicCapToday.used / data.anthropicCapToday.cap) * 100) : 0;
  const threads = data?.recent ? groupIntoThreads(data.recent) : [];

  return (
    <div className="flex flex-col h-full">
      <div className="px-6 py-4 border-b border-border flex items-center gap-3 flex-wrap">
        <h1 className="text-xl font-semibold">Ask StereoNET</h1>
        <div className="text-sm text-muted-foreground">Usage &amp; search history</div>
        <div className="flex-1" />
        <button
          className="text-xs px-3 py-1.5 rounded border border-border hover:border-foreground/40"
          onClick={() => refetch()}
        >
          Refresh
        </button>
      </div>

      {isLoading && <div className="p-6 text-sm text-muted-foreground">Loading...</div>}
      {error && <div className="p-6 text-sm text-red-500">Failed to load: {(error as Error).message}</div>}
      {data && !data.ok && (
        <div className="p-6 text-sm text-red-500">{data.message || "Ask StereoNET unreachable"}</div>
      )}

      {data && data.ok && (
        <>
          {/* Summary cards */}
          <div className="px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-4 border-b border-border">
            <div className="rounded-lg border border-border p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Today</div>
              <div className="text-2xl font-semibold mt-1">{data.totals.today}</div>
            </div>
            <div className="rounded-lg border border-border p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Last 7 days</div>
              <div className="text-2xl font-semibold mt-1">{data.totals.last7Days}</div>
            </div>
            <div className="rounded-lg border border-border p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">All time</div>
              <div className="text-2xl font-semibold mt-1">{data.totals.allTime}</div>
            </div>
            <div className="rounded-lg border border-border p-4">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Avg response (today)</div>
              <div className="text-2xl font-semibold mt-1">
                {data.avgResponseMsToday ? `${(data.avgResponseMsToday / 1000).toFixed(1)}s` : "—"}
              </div>
            </div>
          </div>

          {/* Backend breakdown + spend cap */}
          <div className="px-6 py-4 flex flex-wrap gap-6 border-b border-border">
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">By backend (all time)</div>
              <div className="flex gap-2 flex-wrap">
                {data.byBackend.map(b => {
                  const l = backendLabel(b.backend);
                  return (
                    <span key={b.backend} className={`text-xs px-2 py-1 rounded border ${l.color}`}>
                      {l.text}: {b.n}
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="min-w-[200px]">
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">
                Daily Anthropic cap ({data.anthropicCapToday.used}/{data.anthropicCapToday.cap})
              </div>
              <div className="w-full h-2 rounded bg-muted overflow-hidden">
                <div
                  className={`h-full ${capPct > 80 ? "bg-red-500" : capPct > 50 ? "bg-amber-500" : "bg-emerald-500"}`}
                  style={{ width: `${Math.min(capPct, 100)}%` }}
                />
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Feedback (last 7 days)</div>
              <div className="flex gap-3 items-center">
                <span className="text-sm">👍 {data.feedback.last7Days.up}</span>
                <span className="text-sm">👎 {data.feedback.last7Days.down}</span>
                <span className="text-xs text-muted-foreground">
                  {data.feedback.last7Days.up + data.feedback.last7Days.down > 0
                    ? `${Math.round((data.feedback.last7Days.up / (data.feedback.last7Days.up + data.feedback.last7Days.down)) * 100)}% positive`
                    : "No votes yet"}
                </span>
                <span className="text-xs text-muted-foreground/60">
                  (all time: 👍 {data.feedback.allTime.up} / 👎 {data.feedback.allTime.down})
                </span>
              </div>
            </div>
          </div>

          {/* Recent query history */}
          <div className="flex-1 overflow-auto flex">
            <div className="flex-1 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background border-b border-border">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2">Time</th>
                    <th className="px-4 py-2">User</th>
                    <th className="px-4 py-2">Question</th>
                    <th className="px-4 py-2">Backend</th>
                    <th className="px-4 py-2 text-center">Feedback</th>
                    <th className="px-4 py-2 text-right">Response</th>
                  </tr>
                </thead>
                <tbody>
                  {threads.map((thread, ti) => (
                    <Fragment key={thread[0].conversation_id ?? `s${ti}`}>
                      {thread.map((r, ri) => {
                        const l = backendLabel(r.backend);
                        const isFollowup = ri > 0;
                        return (
                          <tr
                            key={ri}
                            onClick={() => setSelected(r)}
                            className={`border-b border-border/50 hover:bg-muted/50 cursor-pointer ${selected === r ? "bg-muted" : ""} ${isFollowup ? "bg-muted/20" : ""}`}
                          >
                            <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">
                              <div>{fmtDate(r.ts)}</div>
                              <div className="text-[10px] font-mono text-muted-foreground/50">#{r.id}</div>
                            </td>
                            <td className="px-4 py-2 whitespace-nowrap">
                              {isFollowup ? (
                                <span className="text-muted-foreground/40">&mdash;</span>
                              ) : r.username ? (
                                <span className="flex items-center gap-1.5">
                                  {r.username}
                                  {r.tier === "Pro" && (
                                    <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded border bg-[#e8312a]/15 text-[#e8312a] border-[#e8312a]/30">Pro</span>
                                  )}
                                </span>
                              ) : (
                                <span
                                  className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border font-mono ${anonColor(r.ip_hash)}`}
                                  title={r.ip_hash ? `Anonymous · same IP group: ${r.ip_hash}` : "Anonymous (no IP recorded)"}
                                >
                                  {anonLabel(r.ip_hash)}
                                </span>
                              )}
                            </td>
                            <td className={`px-4 py-2 max-w-md truncate ${isFollowup ? `pl-6 border-l-2 ${THREAD_RULE_COLOR}` : ""}`}>
                              {isFollowup && <span className="text-muted-foreground/50 mr-1">&#8627;</span>}
                              {r.question}
                            </td>
                            <td className="px-4 py-2">
                              <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${l.color}`}>
                                {l.text}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-center">
                              {r.feedback === "up" ? "👍" : r.feedback === "down" ? "👎" : <span className="text-muted-foreground/40">—</span>}
                            </td>
                            <td className="px-4 py-2 text-right mono text-muted-foreground">
                              {r.response_ms ? `${(r.response_ms / 1000).toFixed(1)}s` : "—"}
                            </td>
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))}
                  {threads.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-6 text-muted-foreground text-center">No queries yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Detail panel */}
            {selected && (
              <div className="w-[420px] border-l border-border p-4 overflow-auto shrink-0">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-xs uppercase tracking-wide text-muted-foreground">Detail</div>
                  <button className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setSelected(null)}>Close</button>
                </div>
                <div className="text-xs text-muted-foreground mb-1 flex items-center gap-1.5 flex-wrap">
                  <span className="font-mono px-1.5 py-0.5 rounded border bg-muted text-foreground/80" title="Shareable query reference">#{selected.id}</span>
                  {fmtDate(selected.ts)}
                  <span>&middot;</span>
                  {selected.username ? (
                    <span className="flex items-center gap-1.5">
                      {selected.username}
                      {selected.tier === "Pro" && (
                        <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded border bg-[#e8312a]/15 text-[#e8312a] border-[#e8312a]/30">Pro</span>
                      )}
                    </span>
                  ) : (
                    <span
                      className={`font-mono px-1 py-0.5 rounded border ${anonColor(selected.ip_hash)}`}
                      title={selected.ip_hash ? `Anonymous · same IP group: ${selected.ip_hash}` : "Anonymous (no IP recorded)"}
                    >
                      {anonLabel(selected.ip_hash)}
                    </span>
                  )}
                </div>
                <div className="font-medium mb-3">{selected.question}</div>
                <div className="text-sm whitespace-pre-wrap mb-4">{selected.answer}</div>
                {selected.sources?.length > 0 && (
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Sources</div>
                    <div className="flex flex-col gap-1">
                      {selected.sources.map((s, si) => (
                        <a key={si} href={s.url} target="_blank" rel="noreferrer" className="text-xs text-[#e8312a] hover:underline truncate">
                          {s.title}{s.section ? ` (${s.section})` : ""}
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
