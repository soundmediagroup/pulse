import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/queryClient";

const STATUS_OPTIONS = ["open", "closed", "exported-open", "exported-closed", "draft", "submitted"];

type Retailer = {
  entry_id: number;
  title: string;
  url_title: string;
  status: string;
  entry_date: number;
  edit_date: number;
  view_count_one: number;
  author_username: string | null;
  author_screen: string | null;
  is_premium: boolean;
  public_url: string;
  hits_7d: number;
  clicks_7d: number;
};

function fmtNum(n: number): string {
  return new Intl.NumberFormat("en-AU").format(n || 0);
}

function fmtDate(epochOrYmd: any): string {
  if (!epochOrYmd) return "";
  // EE entry_date is a unix timestamp; edit_date is YYYYMMDDHHMMSS
  const s = String(epochOrYmd);
  if (/^\d{14}$/.test(s)) {
    return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  }
  const n = Number(epochOrYmd);
  if (n > 1000000000) {
    const d = new Date(n * 1000);
    return d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
  }
  return s;
}

export default function Retailers() {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "premium" | "standard">("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showFieldMapper, setShowFieldMapper] = useState(false);
  const [busyIds, setBusyIds] = useState<Record<number, boolean>>({});
  const qc = useQueryClient();

  const togglePremium = async (entryId: number, next: boolean) => {
    setBusyIds(b => ({ ...b, [entryId]: true }));
    try {
      await apiRequest("POST", `/api/retailers/${entryId}/premium`, { value: next ? "yes" : "" });
      qc.invalidateQueries({ queryKey: ["/api/retailers"] });
    } finally {
      setBusyIds(b => { const c = { ...b }; delete c[entryId]; return c; });
    }
  };

  const params = new URLSearchParams({ search, limit: "500" });
  if (filter === "premium") params.set("premium", "1");
  if (filter === "standard") params.set("standard", "1");

  const { data, isLoading, error, refetch } = useQuery<{
    ok: boolean;
    total: number;
    premium_field: string | null;
    rows: Retailer[];
  }>({
    queryKey: ["/api/retailers", search, filter],
    queryFn: () => apiRequest("GET", `/api/retailers?${params.toString()}`).then(r => r.json()),
  });

  const rows = data?.rows || [];
  const premiumCount = rows.filter(r => r.is_premium).length;
  const standardCount = rows.length - premiumCount;

  return (
    <div className="flex h-full">
      <div className={`${selectedId ? "w-1/2 border-r border-border" : "w-full"} flex flex-col overflow-hidden`}>
        <div className="px-6 py-4 border-b border-border flex items-center gap-3 flex-wrap">
          <h1 className="text-xl font-semibold">Partner Retailers</h1>
          <div className="text-sm text-muted-foreground">
            {data?.total ? `${rows.length} of ${data.total}` : ""}
            {rows.length > 0 && ` · ${premiumCount} Premium · ${standardCount} Standard`}
          </div>
          <div className="flex-1" />
          <button
            className="text-xs px-3 py-1.5 rounded border border-border hover:border-foreground/40"
            onClick={() => setShowFieldMapper(s => !s)}
            title="Tell PULSE which EE custom field is the Premium tickbox"
          >
            {data?.premium_field ? `Premium: ${data.premium_field}` : "Map Premium field"}
          </button>
        </div>

        {showFieldMapper && <FieldMapper onClose={() => { setShowFieldMapper(false); refetch(); }} />}

        <div className="px-6 py-3 border-b border-border flex items-center gap-3">
          <input
            className="input flex-1 max-w-md"
            placeholder="Search retailer name..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <div className="flex rounded-md border border-border overflow-hidden text-sm">
            {(["all", "premium", "standard"] as const).map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-3 py-1.5 ${filter === f ? "bg-[#e8312a] text-white" : "hover:bg-muted"}`}
              >
                {f === "all" ? "All" : f === "premium" ? "Premium" : "Standard"}
              </button>
            ))}
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          {isLoading && <div className="p-6 text-sm text-muted-foreground">Loading retailers...</div>}
          {error && <div className="p-6 text-sm text-red-500">Failed to load: {(error as Error).message}</div>}
          {!isLoading && !error && rows.length === 0 && (
            <div className="p-6 text-sm text-muted-foreground">
              No retailers match. Check the field mapping if Premium filter looks wrong.
            </div>
          )}
          {!isLoading && rows.length > 0 && (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background border-b border-border">
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2">Retailer</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Tier</th>
                  <th className="px-4 py-2 text-right">Lifetime views</th>
                  <th className="px-4 py-2 text-right">Hits 7d</th>
                  <th className="px-4 py-2 text-right">Clicks 7d</th>
                  <th className="px-4 py-2">Last edit</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr
                    key={r.entry_id}
                    onClick={() => setSelectedId(r.entry_id)}
                    className={`border-b border-border/50 hover:bg-muted/50 cursor-pointer ${selectedId === r.entry_id ? "bg-muted" : ""}`}
                  >
                    <td className="px-4 py-2 font-medium">{r.title}</td>
                    <td className="px-4 py-2 text-muted-foreground">{r.status}</td>
                    <td className="px-4 py-2" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => togglePremium(r.entry_id, !r.is_premium)}
                        disabled={!!busyIds[r.entry_id]}
                        title={`Click to ${r.is_premium ? "remove Premium" : "mark as Premium"}`}
                        className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded border transition-colors disabled:opacity-50 ${
                          r.is_premium
                            ? "bg-amber-500/15 text-amber-400 border-amber-500/30 hover:bg-amber-500/25"
                            : "bg-zinc-500/10 text-zinc-400 border-zinc-500/30 hover:bg-zinc-500/20"
                        }`}
                      >
                        {busyIds[r.entry_id] ? "…" : r.is_premium ? "Premium" : "Standard"}
                      </button>
                    </td>
                    <td className="px-4 py-2 text-right mono text-muted-foreground">{fmtNum(r.view_count_one)}</td>
                    <td className="px-4 py-2 text-right mono">{r.hits_7d}</td>
                    <td className="px-4 py-2 text-right mono">{r.clicks_7d}</td>
                    <td className="px-4 py-2 text-muted-foreground">{fmtDate(r.edit_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {selectedId && (
        <div className="w-1/2 overflow-auto">
          <RetailerDetail id={selectedId} onClose={() => setSelectedId(null)} />
        </div>
      )}
    </div>
  );
}

function FieldMapper({ onClose }: { onClose: () => void }) {
  const { data, isLoading } = useQuery<{ ok: boolean; mapped_premium_field: string | null; fields: any[] }>({
    queryKey: ["/api/retailers/fields"],
    queryFn: () => apiRequest("GET", "/api/retailers/fields").then(r => r.json()),
  });

  const [selected, setSelected] = useState<string>("");
  useEffect(() => { if (data?.mapped_premium_field) setSelected(data.mapped_premium_field); }, [data]);

  const save = async () => {
    if (!selected) return;
    await apiRequest("POST", "/api/retailers/fields/premium", { field: selected });
    onClose();
  };

  return (
    <div className="px-6 py-4 border-b border-border bg-muted/30">
      <div className="text-sm font-medium mb-2">Which EE custom field is the Premium / Preferred tickbox?</div>
      {isLoading && <div className="text-sm text-muted-foreground">Loading fields...</div>}
      {data && (
        <div className="flex items-center gap-2 flex-wrap">
          <select
            className="input max-w-md"
            style={{ backgroundColor: "#1a1a1a", color: "#fff" }}
            value={selected}
            onChange={e => setSelected(e.target.value)}
          >
            <option value="" style={{ backgroundColor: "#1a1a1a", color: "#fff" }}>— Select a field —</option>
            {(data.fields || []).map((f: any) => (
              <option key={f.field_id} value={`field_id_${f.field_id}`} style={{ backgroundColor: "#1a1a1a", color: "#fff" }}>
                {f.field_label || f.field_name} (field_id_{f.field_id}, {f.field_type})
              </option>
            ))}
          </select>
          <button className="cta-primary text-sm" onClick={save} disabled={!selected}>Save mapping</button>
          <button className="text-sm text-muted-foreground hover:text-foreground" onClick={onClose}>Cancel</button>
        </div>
      )}
    </div>
  );
}

function RetailerDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery<any>({
    queryKey: ["/api/retailers", id],
    queryFn: () => apiRequest("GET", `/api/retailers/${id}`).then(r => r.json()),
  });
  const [busy, setBusy] = useState(false);

  const togglePremium = async (next: boolean) => {
    setBusy(true);
    try {
      await apiRequest("POST", `/api/retailers/${id}/premium`, { value: next ? "yes" : "" });
      await refetch();
      qc.invalidateQueries({ queryKey: ["/api/retailers"] });
    } finally { setBusy(false); }
  };

  const changeStatus = async (value: string) => {
    setBusy(true);
    try {
      await apiRequest("POST", `/api/retailers/${id}/status`, { value });
      await refetch();
      qc.invalidateQueries({ queryKey: ["/api/retailers"] });
    } finally { setBusy(false); }
  };

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (error) return <div className="p-6 text-sm text-red-500">{(error as Error).message}</div>;
  if (!data?.ok) return <div className="p-6 text-sm text-red-500">{data?.message || "Failed"}</div>;

  const r = data.retailer;
  const a = data.analytics;

  // Pull out custom field columns (field_id_*) — skip empty ones
  const customFields = Object.entries(r)
    .filter(([k, v]) => /^field_id_\d+$/.test(k) && v != null && String(v).trim() !== "")
    .slice(0, 80);

  const maxH = Math.max(1, ...a.weekly_hits.map((w: any) => w.hits));
  const maxC = Math.max(1, ...a.weekly_clicks.map((w: any) => w.clicks));

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <h2 className="text-xl font-semibold">{r.title}</h2>
          <div className="text-sm text-muted-foreground">#{r.entry_id}</div>
          <a href={r.public_url} target="_blank" rel="noreferrer" className="text-sm text-[#e8312a] hover:underline">
            {r.public_url}
          </a>
        </div>
        <button className="text-sm text-muted-foreground hover:text-foreground" onClick={onClose}>Close</button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="border border-border rounded p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Lifetime views (EE)</div>
          <div className="text-xl font-semibold mt-1">{new Intl.NumberFormat("en-AU").format(Number(r.view_count_one) || 0)}</div>
        </div>
        <div className="border border-border rounded p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Hits (last 12 weeks)</div>
          <div className="text-xl font-semibold mt-1">{a.weekly_hits.reduce((s: number, w: any) => s + w.hits, 0)}</div>
        </div>
        <div className="border border-border rounded p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Outbound clicks (last 12 weeks)</div>
          <div className="text-xl font-semibold mt-1">{a.weekly_clicks.reduce((s: number, w: any) => s + w.clicks, 0)}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 border border-border rounded p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Premium</span>
          <button
            onClick={() => togglePremium(!r.is_premium)}
            disabled={busy}
            className={`text-xs px-3 py-1 rounded border transition-colors disabled:opacity-50 ${
              r.is_premium
                ? "bg-amber-500/15 text-amber-400 border-amber-500/30"
                : "bg-zinc-500/10 text-zinc-400 border-zinc-500/30"
            }`}
          >
            {busy ? "Saving…" : r.is_premium ? "On · click to turn off" : "Off · click to turn on"}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">Status</span>
          <select
            className="input text-sm"
            style={{ backgroundColor: "#1a1a1a", color: "#fff", minWidth: "160px" }}
            value={r.status}
            disabled={busy}
            onChange={e => changeStatus(e.target.value)}
          >
            {STATUS_OPTIONS.map(s => (
              <option key={s} value={s} style={{ backgroundColor: "#1a1a1a", color: "#fff" }}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="border border-border rounded p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Hits (last {a.weeks} weeks)</div>
          <div className="flex items-end gap-1 h-24">
            {a.weekly_hits.length === 0 && <div className="text-sm text-muted-foreground">No hits recorded yet.</div>}
            {a.weekly_hits.map((w: any) => (
              <div key={w.yw} className="flex-1 flex flex-col items-center gap-1" title={`${w.yw}: ${w.hits} hits`}>
                <div className="w-full bg-[#e8312a]" style={{ height: `${(w.hits / maxH) * 100}%` }} />
                <div className="text-[9px] text-muted-foreground">{w.yw.slice(-2)}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="border border-border rounded p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Outbound clicks (last {a.weeks} weeks)</div>
          <div className="flex items-end gap-1 h-24">
            {a.weekly_clicks.length === 0 && <div className="text-sm text-muted-foreground">No clicks recorded yet.</div>}
            {a.weekly_clicks.map((w: any) => (
              <div key={w.yw} className="flex-1 flex flex-col items-center gap-1" title={`${w.yw}: ${w.clicks} clicks`}>
                <div className="w-full bg-amber-500" style={{ height: `${(w.clicks / maxC) * 100}%` }} />
                <div className="text-[9px] text-muted-foreground">{w.yw.slice(-2)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {a.top_outbound_urls.length > 0 && (
        <div className="border border-border rounded p-4">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Top outbound URLs (last 30 days)</div>
          <table className="w-full text-sm">
            <tbody>
              {a.top_outbound_urls.map((u: any, i: number) => (
                <tr key={i} className="border-b border-border/50">
                  <td className="py-1.5 truncate max-w-[400px]" title={u.url}>{u.url || "(empty)"}</td>
                  <td className="py-1.5 text-right mono">{u.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border border-border rounded p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">EE custom fields</div>
        <table className="w-full text-sm">
          <tbody>
            {customFields.map(([k, v]) => (
              <tr key={k} className="border-b border-border/50">
                <td className="py-1.5 font-mono text-xs text-muted-foreground pr-3 align-top">{k}</td>
                <td className="py-1.5 whitespace-pre-wrap break-all">{String(v).slice(0, 500)}</td>
              </tr>
            ))}
            {customFields.length === 0 && <tr><td className="py-2 text-sm text-muted-foreground">No custom-field values stored.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
