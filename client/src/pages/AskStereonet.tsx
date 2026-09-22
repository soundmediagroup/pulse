import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface Source {
  title: string;
  url: string;
  section?: string;
}

interface QueryLogRow {
  ts: string;
  question: string;
  answer: string;
  backend: string;
  response_ms: number | null;
  sources: Source[];
}

interface StatsResponse {
  ok: boolean;
  totals: { allTime: number; today: number; last7Days: number };
  avgResponseMsToday: number | null;
  byBackend: { backend: string; n: number }[];
  anthropicCapToday: { used: number; cap: number };
  recent: QueryLogRow[];
  message?: string;
}

function fmtDate(ts: string) {
  const d = new Date(ts);
  return d.toLocaleString("en-AU", { timeZone: "Australia/Melbourne", dateStyle: "short", timeStyle: "short" });
}

function backendLabel(backend: string) {
  if (backend.startsWith("anthropic/")) return { text: backend.replace("anthropic/", "Claude "), color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
  if (backend.includes("fallback")) return { text: backend.replace("gpubox/", "gpubox: "), color: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
  return { text: backend.replace("gpubox/", "gpubox: "), color: "bg-zinc-500/10 text-zinc-400 border-zinc-500/30" };
}

export default function AskStereonet() {
  const [selected, setSelected] = useState<QueryLogRow | null>(null);

  const { data, isLoading, error, refetch } = useQuery<StatsResponse>({
    queryKey: ["/api/ask-stereonet/stats"],
    queryFn: () => apiRequest("GET", "/api/ask-stereonet/stats?limit=100").then(r => r.json()),
    refetchInterval: 60000,
  });

  const capPct = data?.anthropicCapToday ? Math.round((data.anthropicCapToday.used / data.anthropicCapToday.cap) * 100) : 0;

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
          </div>

          {/* Recent query history */}
          <div className="flex-1 overflow-auto flex">
            <div className="flex-1 overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background border-b border-border">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2">Time</th>
                    <th className="px-4 py-2">Question</th>
                    <th className="px-4 py-2">Backend</th>
                    <th className="px-4 py-2 text-right">Response</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map((r, i) => {
                    const l = backendLabel(r.backend);
                    return (
                      <tr
                        key={i}
                        onClick={() => setSelected(r)}
                        className={`border-b border-border/50 hover:bg-muted/50 cursor-pointer ${selected === r ? "bg-muted" : ""}`}
                      >
                        <td className="px-4 py-2 text-muted-foreground whitespace-nowrap">{fmtDate(r.ts)}</td>
                        <td className="px-4 py-2 max-w-md truncate">{r.question}</td>
                        <td className="px-4 py-2">
                          <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border ${l.color}`}>
                            {l.text}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right mono text-muted-foreground">
                          {r.response_ms ? `${(r.response_ms / 1000).toFixed(1)}s` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                  {data.recent.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-6 text-muted-foreground text-center">No queries yet</td></tr>
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
                <div className="text-xs text-muted-foreground mb-1">{fmtDate(selected.ts)}</div>
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
