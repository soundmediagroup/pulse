// Media Kits admin page — list, edit, share, analytics.
// Access: requires pitch_access view/edit/admin via session.
import React, { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/queryClient";
import { useToast } from "../hooks/use-toast";
import {
  FileText, Send, Eye, Copy, Trash2, RotateCcw, Save, Link as LinkIcon, Calendar,
  Globe, Pencil, X, ChevronRight, ChevronDown, AlertCircle, Plus, BarChart3,
  ArrowUp, ArrowDown, Layers, Settings as SettingsIcon, Share2, ExternalLink,
} from "lucide-react";

type Kit = {
  id: number;
  slug: string;
  kind: "trade" | "retailer";
  region: string | null;
  is_canonical: number;
  parent_kit_id: number | null;
  prospect_lead_id: number | null;
  label: string;
  subtitle: string | null;
  version_quarter: string | null;
  status: "draft" | "published" | "archived";
  base_currency: string;
  tax_suffix: string | null;
  intro_text: string | null;
  updated_at: string;
};

type Block = {
  id?: number;
  kit_id: number;
  block_key: string;
  position: number;
  is_override: number;
  is_visible: number;
  content: any;
  inherited: boolean;
  source: "own" | "inherited";
};

type Addon = {
  id: number;
  kind: "tier" | "bolton";
  addon_key: string;
  region: string | null;
  audience_kind: string;
  label: string;
  subtitle: string | null;
  description: string | null;
  price_value: number | null;
  price_currency: string;
  price_suffix: string | null;
  billing: string;
  inclusions: any;
  availability: "available" | "sold_out" | "coming_soon" | "not_available";
  position: number;
  is_visible: number;
  is_poa: number;
  example_url?: string | null;
};

type Share = {
  id: number;
  kit_id: number;
  slug: string;
  magic_token: string;
  prospect_name: string | null;
  prospect_email: string | null;
  prospect_company: string | null;
  note: string | null;
  expires_at: string | null;
  status: "active" | "revoked" | "expired";
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
};

const REGION_LABELS: Record<string, string> = {
  global: "Global",
  anz: "ANZ",
  uk_eu: "UK & EU",
  asia: "Southeast Asia",
  na: "North America",
};

const BLOCK_LABELS: Record<string, string> = {
  hero: "Hero",
  proposal: "Your Proposal (personalised header)",
  who_are_we: "Who Are We",
  why_us: "Why Us",
  audience: "We Found The Buyers",
  audience_stats: "Audience Stats (big numbers grid)",
  audience_grid: "Audience Snapshot (9-tile grid)",
  featured_article: "Featured Article / Manifesto",
  research_sources: "Where Audiophiles Research Purchases",
  offer: "What We Offer",
  investment: "Your Investment",
  casual: "Casual / Ad-hoc",
  boltons: "Bolt-on Promos",
  ready: "Are You Ready?",
  terms: "Terms & Conditions",
  contact: "Contact",
  who_we_are_not: "Who We Are NOT For",
  partner_quotes: "Partner Quotes (testimonials)",
  investment_callout: "Investment Callout (3% pull-quote)",
  analytics_proof: "Genuine Data & Analytics",
  find_a_store: "Find a Store (driving consumers to retailers)",
};

export default function MediaKits({ initialKitId, includeProspects = false, canCustomise = true }: { initialKitId?: number | null; includeProspects?: boolean; canCustomise?: boolean } = {}) {
  // When opening a specific kit (e.g. from a Lead's customised kit), we need
  // to include prospect clones in the list so it can be selected.
  const needsProspects = includeProspects || (initialKitId != null);
  const { data, isLoading, error } = useQuery<{ kits: Kit[] }>({
    queryKey: ["/api/media-kit/kits", needsProspects],
    queryFn: async () => {
      const qs = needsProspects ? "?include_prospects=1" : "";
      const r = await apiRequest("GET", `/api/media-kit/kits${qs}`);
      if (!r.ok) throw new Error(`Load failed (${r.status})`);
      return r.json();
    },
  });
  // selectedId === number  -> show that kit
  // selectedId === "history" -> show the global sent-shares history panel
  // selectedId === null     -> show nothing yet (initial)
  const [selectedId, setSelectedId] = useState<number | "history" | null>(initialKitId ?? null);

  // Honour incoming initialKitId changes (e.g. when parent switches which lead's kit to open)
  useEffect(() => {
    if (initialKitId != null && initialKitId !== selectedId) {
      setSelectedId(initialKitId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialKitId]);

  useEffect(() => {
    if (data?.kits && data.kits.length && selectedId == null) {
      // Default to canonical trade
      const canonical = data.kits.find(k => k.kind === "trade" && k.is_canonical);
      setSelectedId((canonical || data.kits[0]).id);
    }
  }, [data, selectedId]);

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading media kits…</div>;
  if (error) return <div className="p-8 text-red-400">{(error as Error).message}</div>;
  if (!data?.kits?.length) return <div className="p-8">No media kits found.</div>;

  const tradeCanonical = data.kits.find(k => k.kind === "trade" && k.is_canonical);
  const tradeRegional = data.kits.filter(k => k.kind === "trade" && !k.is_canonical && !k.prospect_lead_id);
  const retailer = data.kits.filter(k => k.kind === "retailer" && !k.prospect_lead_id);
  const prospects = data.kits.filter(k => !!k.prospect_lead_id);

  return (
    <div className="media-kits-page h-full flex bg-background overflow-hidden">
      <style>{`
        .media-kits-page .input {
          width: 100%;
          background: #131316;
          color: #f3f3f4;
          border: 1px solid #2a2a2f;
          border-radius: 6px;
          padding: 0.5rem 0.65rem;
          font-size: 0.875rem;
          outline: none;
          transition: border-color 0.15s ease;
          font-family: inherit;
        }
        .media-kits-page .input:focus { border-color: #e8312a; }
        .media-kits-page .input::placeholder { color: #555; }
        .media-kits-page textarea.input { resize: vertical; line-height: 1.5; }
        .media-kits-page select.input {
          appearance: none; -webkit-appearance: none;
          background-image: url("data:image/svg+xml;charset=US-ASCII,%3Csvg width='12' height='8' viewBox='0 0 12 8' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23ffffff80' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
          background-repeat: no-repeat; background-position: right 10px center;
          padding-right: 28px;
        }
        .media-kits-page select.input option, .media-kits-page .input option { background: #1a1a1d; color: #f3f3f4; }
        .media-kits-page select.input option:checked, .media-kits-page .input option:checked { background: #e8312a; color: white; }
        .media-kits-page code { font-size: 0.75em; background: rgba(255,255,255,0.08); padding: 1px 4px; border-radius: 3px; color: #e8312a; }
      `}</style>
      <aside className="w-72 border-r border-border bg-card flex-shrink-0 overflow-y-auto">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Media Kits</h2>
        </div>
        <div className="px-3 py-3 space-y-4">
          <div>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-muted-foreground/70">Trade</div>
            {tradeCanonical && <KitRow kit={tradeCanonical} selected={selectedId === tradeCanonical.id} onClick={() => setSelectedId(tradeCanonical.id)} />}
            {tradeRegional.map(k => (
              <KitRow key={k.id} kit={k} selected={selectedId === k.id} onClick={() => setSelectedId(k.id)} indent />
            ))}
          </div>
          {retailer.length > 0 && (
            <div>
              <div className="px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-muted-foreground/70">Retailer</div>
              {retailer.map(k => (
                <KitRow key={k.id} kit={k} selected={selectedId === k.id} onClick={() => setSelectedId(k.id)} />
              ))}
            </div>
          )}
          <div>
            <div className="px-2 py-1 text-[10px] uppercase tracking-wider font-bold text-muted-foreground/70">History</div>
            <button
              onClick={() => setSelectedId("history")}
              className={`w-full text-left px-2 py-1.5 rounded-md text-sm flex items-center gap-2 ${selectedId === "history" ? "bg-[#e8312a]/15 text-foreground border border-[#e8312a]/30" : "hover:bg-accent text-foreground/80"}`}
              title="Every Media Kit sent — Quick Send + proposal links"
            >
              <Share2 className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">Sent Media Kits</span>
            </button>
            {prospects.length > 0 && (
              <div className="mt-2">
                <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground/60">Prospect clones</div>
                {prospects.map(k => (
                  <KitRow key={k.id} kit={k} selected={selectedId === k.id} onClick={() => setSelectedId(k.id)} prospect />
                ))}
              </div>
            )}
          </div>
        </div>
      </aside>
      <main className="flex-1 overflow-y-auto">
        {selectedId === "history" && <HistoryPanel />}
        {typeof selectedId === "number" && <KitEditor key={selectedId} kitId={selectedId} canCustomise={canCustomise} onDeleted={() => setSelectedId(null)} />}
      </main>
    </div>
  );
}

function KitRow({ kit, selected, onClick, indent, prospect }: { kit: Kit; selected: boolean; onClick: () => void; indent?: boolean; prospect?: boolean }) {
  const regionLabel = kit.is_canonical ? "Global" : (kit.region ? REGION_LABELS[kit.region] : "—");
  // For prospect clones, prefer the kit's label (which includes the prospect's company name) over the region label.
  // Strip the leading "StereoNET <Region> Trade — " prefix added by customise-kit so just the prospect name shows.
  const primaryLabel = prospect
    ? (kit.label.replace(/^StereoNET\s+[^—]+—\s*/i, "").trim() || regionLabel)
    : regionLabel;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors flex items-center gap-2 ${
        selected ? "bg-[#e8312a]/15 text-foreground border border-[#e8312a]/40" : "hover:bg-accent/30 text-muted-foreground hover:text-foreground"
      } ${indent ? "ml-3" : ""}`}
    >
      {kit.is_canonical ? <Layers className="w-3.5 h-3.5 shrink-0" /> : null}
      <div className="flex-1 min-w-0">
        <div className="font-medium truncate flex items-center gap-1.5">
          {primaryLabel}
          {prospect && <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-[#e8312a]/20 text-[#e8312a]">Prospect</span>}
        </div>
        <div className="text-[10px] text-muted-foreground/70 truncate">
          {prospect && kit.region ? `${REGION_LABELS[kit.region] || kit.region} · ` : ""}{kit.base_currency} · {kit.version_quarter} · {kit.status}
        </div>
      </div>
    </button>
  );
}

// ─── Kit Editor ─────────────────────────────────────────────────────────────
function KitEditor({ kitId, canCustomise = true, onDeleted }: { kitId: number; canCustomise?: boolean; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, refetch } = useQuery<{ kit: Kit; blocks: Block[]; addons: { tiers: Addon[]; boltons: Addon[] } }>({
    queryKey: [`/api/media-kit/kits/${kitId}`],
    queryFn: async () => {
      // include_hidden=1 ensures hidden tiers/bolt-ons still appear in the
      // AddonsTab so admins can un-hide them. Public renders use a different endpoint.
      const r = await apiRequest("GET", `/api/media-kit/kits/${kitId}?include_hidden=1`);
      if (!r.ok) throw new Error(`Load failed (${r.status})`);
      return r.json();
    },
    staleTime: 0,
    refetchOnMount: "always",
  });
  const [tab, setTab] = useState<"blocks" | "addons" | "shares">("blocks");
  const [openBlockKey, setOpenBlockKey] = useState<string | null>(null);

  if (isLoading || !data) return <div className="p-8 text-muted-foreground">Loading…</div>;
  const { kit, blocks, addons } = data;

  return (
    <div>
      {/* Manager-mode banner: explains why edit affordances are limited */}
      {!canCustomise && (
        <div className="px-6 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-300 text-xs flex items-center gap-2">
          <span className="font-semibold">Manager view</span>
          <span className="text-amber-300/80">— you can generate, send, and respond to Media Kits. Editing kit content, tiers, and bolt-ons is reserved for Admins.</span>
        </div>
      )}
      {/* Header */}
      <div className="px-6 py-4 border-b border-border flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">{kit.label}</h1>
          <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
            <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold ${kit.status === "published" ? "bg-green-500/15 text-green-400" : "bg-zinc-500/15 text-zinc-400"}`}>{kit.status}</span>
            <span>{kit.kind === "trade" ? "Trade" : "Retailer"}</span>
            <span>·</span>
            <span>{kit.region ? REGION_LABELS[kit.region] : "Global"}</span>
            <span>·</span>
            <span>{kit.base_currency} ({kit.tax_suffix})</span>
            <span>·</span>
            <span>{kit.version_quarter}</span>
          </div>
        </div>
        <KitMeta kit={kit} canCustomise={canCustomise} onSaved={() => { qc.invalidateQueries({ queryKey: [`/api/media-kit/kits/${kitId}`] }); qc.invalidateQueries({ queryKey: ["/api/media-kit/kits"] }); }} onDeleted={() => { qc.removeQueries({ queryKey: [`/api/media-kit/kits/${kitId}`] }); qc.invalidateQueries({ queryKey: ["/api/media-kit/kits"] }); onDeleted?.(); }} />
      </div>

      {/* Tabs */}
      <div className="px-6 pt-4 flex items-center gap-1 border-b border-border">
        <TabBtn active={tab === "blocks"} onClick={() => setTab("blocks")} icon={<Layers className="w-3.5 h-3.5" />}>Content blocks</TabBtn>
        <TabBtn active={tab === "addons"} onClick={() => setTab("addons")} icon={<FileText className="w-3.5 h-3.5" />}>{kit.kind === "retailer" ? "Tiers" : "Tiers & Bolt-ons"}</TabBtn>
        <TabBtn active={tab === "shares"} onClick={() => setTab("shares")} icon={<Share2 className="w-3.5 h-3.5" />}>Shares & analytics</TabBtn>
      </div>

      {tab === "blocks" && (
        <SortableBlocks
          kit={kit}
          blocks={blocks}
          tiers={addons.tiers}
          boltons={addons.boltons}
          openBlockKey={openBlockKey}
          setOpenBlockKey={setOpenBlockKey}
          onChanged={() => refetch()}
        />
      )}

      {tab === "addons" && (
        <AddonsTab kit={kit} tiers={addons.tiers} boltons={addons.boltons} onChanged={() => refetch()} />
      )}

      {tab === "shares" && (
        <SharesTab kit={kit} />
      )}
    </div>
  );
}

function TabBtn({ active, onClick, icon, children }: any) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
        active ? "border-[#e8312a] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
      }`}
    >
      {icon}
      {children}
    </button>
  );
}

// ─── Kit metadata bar (status/version/currency picker) ──────────────────────
function KitMeta({ kit, onSaved, onDeleted, canCustomise = true }: { kit: Kit; onSaved: () => void; onDeleted?: () => void; canCustomise?: boolean }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState(kit.status);
  const [label, setLabel] = useState(kit.label || "");
  const [version, setVersion] = useState(kit.version_quarter || "");
  const [currency, setCurrency] = useState(kit.base_currency);
  const [taxSuffix, setTaxSuffix] = useState(kit.tax_suffix || "");
  const save = async () => {
    if (!label.trim()) { toast({ title: "Name required", variant: "destructive" }); return; }
    const r = await apiRequest("PATCH", `/api/media-kit/kits/${kit.id}`, { label: label.trim(), status, version_quarter: version, base_currency: currency, tax_suffix: taxSuffix });
    if (r.ok) { toast({ title: "Kit updated" }); setEditing(false); onSaved(); }
    else toast({ title: "Update failed", variant: "destructive" });
  };
  const [deleting, setDeleting] = useState(false);
  const remove = async () => {
    if (deleting) return;
    const ok = window.confirm(`Delete "${kit.label}"?\n\nThis cannot be undone. The kit's content blocks, draft shares, and any prospect clone pointers will be removed. Kits with sent shares are protected and cannot be deleted.`);
    if (!ok) return;
    setDeleting(true);
    try {
      const r = await apiRequest("DELETE", `/api/media-kit/kits/${kit.id}`);
      if (r.ok) {
        toast({ title: "Kit deleted", description: kit.label });
        // Tell the parent to drop the selection and refresh the sidebar.
        if (onDeleted) onDeleted(); else onSaved();
      } else {
        const j = await r.json().catch(() => ({}));
        toast({ title: "Delete failed", description: j?.message || `HTTP ${r.status}`, variant: "destructive" });
        console.error("[media-kit] delete failed:", r.status, j);
      }
    } catch (e: any) {
      toast({ title: "Delete failed", description: e?.message || "Network error", variant: "destructive" });
      console.error("[media-kit] delete exception:", e);
    } finally {
      setDeleting(false);
    }
  };
  const { toast: previewToast } = useToast();
  const openPreview = async () => {
    try {
      const r = await apiRequest("POST", `/api/media-kit/kits/${kit.id}/preview-share`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j?.magic_link) window.open(j.magic_link, "_blank", "noopener,noreferrer");
      else throw new Error("No magic link returned");
    } catch (e: any) {
      previewToast({ title: "Preview failed", description: e?.message || "Unknown error", variant: "destructive" });
    }
  };
  if (!editing) return (
    <div className="flex items-center gap-2">
      <button onClick={openPreview} className="px-3 py-1.5 rounded-md border border-border text-xs font-semibold hover:border-[#e8312a]" title="Open the public kit in a new tab"><Eye className="w-3 h-3 inline mr-1" /> Preview</button>
      {canCustomise && (
        <button onClick={() => setEditing(true)} className="px-3 py-1.5 rounded-md border border-border text-xs font-semibold hover:border-[#e8312a]"><Pencil className="w-3 h-3 inline mr-1" /> Edit kit</button>
      )}
    </div>
  );
  return (
    <div className="flex flex-col gap-2 items-end">
      <input
        className="input text-sm w-72"
        value={label}
        placeholder="Kit name (e.g. StereoNET ANZ Trade)"
        onChange={e => setLabel(e.target.value)}
      />
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <select className="input text-xs" value={status} onChange={e => setStatus(e.target.value as any)}>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </select>
        <input className="input text-xs w-24" value={version} placeholder="Q1 2026" onChange={e => setVersion(e.target.value)} />
        <select className="input text-xs" value={currency} onChange={e => setCurrency(e.target.value)}>
          {["USD", "AUD", "GBP", "EUR", "SGD"].map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <input className="input text-xs w-24" value={taxSuffix} placeholder="no tax" onChange={e => setTaxSuffix(e.target.value)} />
        <button onClick={save} className="px-3 py-1.5 rounded-md bg-[#e8312a] text-white text-xs font-semibold">Save</button>
        <button onClick={() => setEditing(false)} className="px-3 py-1.5 rounded-md border border-border text-xs">Cancel</button>
        <button onClick={remove} disabled={deleting} title="Delete this kit" className="px-2 py-1.5 rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-50 disabled:cursor-not-allowed text-xs flex items-center gap-1">
          <Trash2 className="w-3 h-3" /> {deleting ? "Deleting…" : "Delete"}
        </button>
      </div>
    </div>
  );
}

// ─── Block card ─────────────────────────────────────────────────────────────
function BlockCard({ block, kit, tiers, boltons, isOpen, onToggle, onChanged }: { block: Block; kit: Kit; tiers: Addon[]; boltons: Addon[]; isOpen: boolean; onToggle: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const [content, setContent] = useState<any>(block.content || {});
  const [visible, setVisible] = useState(block.is_visible === 1);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setContent(block.content || {}); setVisible(block.is_visible === 1); }, [block.content, block.is_visible]);

  // The canonical kit IS the source. By definition it can never "override"
  // anything, so don't show the OVERRIDE pill there even if the DB flag is 1.
  const isOverride = block.is_override === 1 && !block.inherited && !kit.is_canonical;
  const inheritsFromParent = !!kit.parent_kit_id;
  const isInherited = block.inherited;

  const save = async () => {
    setSaving(true);
    try {
      const r = await apiRequest("PUT", `/api/media-kit/kits/${kit.id}/blocks/${block.block_key}`, { content, is_visible: visible });
      if (!r.ok) { const j = await r.json().catch(() => ({} as any)); throw new Error(j.message || `Save failed (${r.status})`); }
      toast({ title: "Block saved" });
      onChanged();
    } catch (e: any) {
      toast({ title: "Save failed", description: e.message, variant: "destructive" });
    } finally { setSaving(false); }
  };

  const revert = async () => {
    if (!confirm(`Revert ${BLOCK_LABELS[block.block_key]} to inherit from the Global kit?`)) return;
    const r = await apiRequest("DELETE", `/api/media-kit/kits/${kit.id}/blocks/${block.block_key}`);
    if (r.ok) { toast({ title: "Reverted to Global" }); onChanged(); }
    else toast({ title: "Revert failed", variant: "destructive" });
  };

  return (
    <div className={`rounded-lg border ${isOverride ? "border-[#e8312a]/40 bg-[#e8312a]/[0.04]" : "border-border bg-card"}`}>
      <button onClick={onToggle} className="w-full px-4 py-3 flex items-center gap-3 text-left">
        {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        <div className="flex-1">
          <div className="font-semibold text-sm flex items-center gap-2">
            {BLOCK_LABELS[block.block_key] || block.block_key}
            {isOverride && (
              <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-[#e8312a]/15 text-[#e8312a]">OVERRIDE</span>
            )}
            {isInherited && inheritsFromParent && (
              <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-zinc-500/15 text-zinc-400" title="Inherited from Global kit">INHERITED</span>
            )}
            {!visible && (
              <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-zinc-500/15 text-zinc-400">HIDDEN</span>
            )}
          </div>
        </div>
      </button>
      {isOpen && (
        <div className="px-4 pb-4 space-y-3 border-t border-border/50 pt-3">
          {isInherited && inheritsFromParent && (
            <div className="rounded-md bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-xs text-amber-300">
              This block is inherited from the Global kit. Edits here will create a regional override.
            </div>
          )}
          <BlockEditor blockKey={block.block_key} content={content} setContent={setContent} tiers={tiers} boltons={boltons} />
          <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/50">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} className="accent-[#e8312a]" />
              Show this block on the kit
            </label>
            <div className="flex items-center gap-2">
              {isOverride && (
                <button onClick={revert} className="px-3 py-1.5 rounded-md border border-border text-xs font-semibold hover:border-amber-500 hover:text-amber-400">Revert to Global</button>
              )}
              <button onClick={save} disabled={saving} className="px-4 py-1.5 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 disabled:bg-[#e8312a]/50 text-white text-xs font-semibold">
                {saving ? "Saving…" : isInherited ? "Save as override" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Block editor (form fields per block type) ──────────────────────────────
function BlockEditor({ blockKey, content, setContent, tiers, boltons }: { blockKey: string; content: any; setContent: (c: any) => void; tiers: Addon[]; boltons: Addon[] }) {
  const set = (patch: any) => setContent({ ...content, ...patch });
  const setParagraphs = (paragraphs: string[]) => set({ paragraphs });
  const setBullets = (bullets: any[]) => set({ bullets });

  switch (blockKey) {
    case "proposal":
      return <ProposalEditor content={content} set={set} tiers={tiers} boltons={boltons} />;
    case "hero":
      return (
        <>
          <Field label="Region label (badge)"><input className="input text-sm" value={content.region_label || ""} onChange={e => set({ region_label: e.target.value })} /></Field>
          <Field label="Quarter / Version"><input className="input text-sm" value={content.quarter || ""} onChange={e => set({ quarter: e.target.value })} /></Field>
          <Field label="Background image (optional)">
            <BackgroundImageUploader
              url={content.background_image || ""}
              onChange={(url) => set({ background_image: url })}
            />
          </Field>
        </>
      );
    case "who_are_we":
    case "why_us":
    case "ready":
      return (
        <>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <Field label="Subheading"><input className="input text-sm" value={content.subheading || ""} onChange={e => set({ subheading: e.target.value })} /></Field>
          <Field label="Epigraph (quote)"><input className="input text-sm" value={content.epigraph || ""} onChange={e => set({ epigraph: e.target.value })} /></Field>
          <Field label="Epigraph attribution"><input className="input text-sm" value={content.epigraph_attribution || ""} onChange={e => set({ epigraph_attribution: e.target.value })} /></Field>
          <ParagraphsField paragraphs={content.paragraphs || []} onChange={setParagraphs} />
          {blockKey === "ready" && (
            <>
              <Field label="CTA label"><input className="input text-sm" value={content.cta_label || ""} onChange={e => set({ cta_label: e.target.value })} /></Field>
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={content.cta_enabled !== false} onChange={e => set({ cta_enabled: e.target.checked })} className="accent-[#e8312a]" />
                Show CTA button (links to PITCH proposal builder)
              </label>
            </>
          )}
        </>
      );
    case "audience":
      return (
        <>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <Field label="Subheading"><input className="input text-sm" value={content.subheading || ""} onChange={e => set({ subheading: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={content.use_live_ga4 !== false} onChange={e => set({ use_live_ga4: e.target.checked })} className="accent-[#e8312a]" />
            Use live GA4 numbers (recommended). When off, use the static region split below.
          </label>
          <RegionSplitField split={content.region_split || []} onChange={split => set({ region_split: split })} />
        </>
      );
    case "audience_grid":
      return (
        <>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <Field label="Subheading"><input className="input text-sm" value={content.subheading || ""} onChange={e => set({ subheading: e.target.value })} /></Field>
          <Field label="Footer note (source attribution)"><textarea className="input text-sm min-h-[60px]" value={content.footer_note || ""} onChange={e => set({ footer_note: e.target.value })} /></Field>
          <TilesField tiles={content.tiles || []} onChange={tiles => set({ tiles })} />
        </>
      );
    case "audience_stats":
      return (
        <>
          <p className="text-xs text-muted-foreground -mt-1">The big numbers grid (Audience Quality + AI Visibility) uses fixed values across all kits. You can edit the heading, byline and footnote here.</p>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} placeholder="The numbers brands want to see" /></Field>
          <Field label="Byline (orange subheading)"><input className="input text-sm" value={content.subheading || ""} onChange={e => set({ subheading: e.target.value })} placeholder="verified audience and AI visibility" /></Field>
          <Field label="Footnote (shown below the grid, prefixed with *)"><textarea className="input text-sm min-h-[70px]" value={content.footnote || ""} onChange={e => set({ footnote: e.target.value })} placeholder="Actual human traffic only — bots filtered. Source data: Google Analytics 4 (audience), Cloudflare (AI bot traffic)." /></Field>
        </>
      );
    case "featured_article":
      return (
        <>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={content.enabled !== false} onChange={e => set({ enabled: e.target.checked })} className="accent-[#e8312a]" />
            Show this block on the kit
          </label>
          <Field label="Eyebrow (small label above headline)"><input className="input text-sm" value={content.eyebrow || ""} onChange={e => set({ eyebrow: e.target.value })} /></Field>
          <Field label="Article headline"><input className="input text-sm" value={content.headline || ""} onChange={e => set({ headline: e.target.value })} /></Field>
          <Field label="Pull quote (large quoted text)"><textarea className="input text-sm min-h-[100px]" value={content.pull_quote || ""} onChange={e => set({ pull_quote: e.target.value })} /></Field>
          <Field label="Intro paragraph (context)"><textarea className="input text-sm min-h-[120px]" value={content.intro_paragraph || ""} onChange={e => set({ intro_paragraph: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Author"><input className="input text-sm" value={content.author || ""} onChange={e => set({ author: e.target.value })} /></Field>
            <Field label="Author role"><input className="input text-sm" value={content.author_role || ""} onChange={e => set({ author_role: e.target.value })} /></Field>
          </div>
          <Field label="Published date"><input className="input text-sm" value={content.published || ""} onChange={e => set({ published: e.target.value })} /></Field>
          <Field label="Article URL"><input className="input text-sm" value={content.url || ""} onChange={e => set({ url: e.target.value })} /></Field>
          <Field label="CTA button label"><input className="input text-sm" value={content.cta_label || ""} onChange={e => set({ cta_label: e.target.value })} /></Field>
        </>
      );
    case "research_sources":
      return (
        <>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <Field label="Subheading"><input className="input text-sm" value={content.subheading || ""} onChange={e => set({ subheading: e.target.value })} /></Field>
          <Field label="Footer note (source attribution)"><textarea className="input text-sm min-h-[60px]" value={content.footer_note || ""} onChange={e => set({ footer_note: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={content.show_highlight !== false} onChange={e => set({ show_highlight: e.target.checked })} className="accent-[#e8312a]" />
            Show "combined" highlight callout
          </label>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Highlight label"><input className="input text-sm" value={content.highlight_label || ""} onChange={e => set({ highlight_label: e.target.value })} /></Field>
            <Field label="Highlight %"><input type="number" className="input text-sm" value={content.highlight_pct ?? 0} onChange={e => set({ highlight_pct: Number(e.target.value) || 0 })} /></Field>
          </div>
          <ResearchSourcesField sources={content.sources || []} onChange={sources => set({ sources })} />
        </>
      );
    case "offer": {
      const bs = content.broadstreet || {};
      const setBs = (patch: any) => set({ broadstreet: { ...bs, ...patch } });
      return (
        <>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <Field label="Intro"><textarea className="input text-sm min-h-[120px]" value={content.intro || ""} onChange={e => set({ intro: e.target.value })} /></Field>
          <BulletsField bullets={content.bullets || []} onChange={setBullets} label="Inclusions list" />
          <BulletsField bullets={content.notes ? (content.notes as string[]).map((n: string) => ({ title: "", body: n })) : []} onChange={items => set({ notes: items.map((b: any) => b.body) })} label="Notes (banner specs etc.)" simple />
          <div className="rounded-md border border-border bg-zinc-500/5 p-3 space-y-2">
            <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Broadstreet Live Ads</div>
            <p className="text-[10px] text-muted-foreground">Enable to show live ad inventory in the kit. Leave zone IDs blank to hide that slot.</p>
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input type="checkbox" checked={!!bs.enabled} onChange={e => setBs({ enabled: e.target.checked })} className="accent-[#e8312a]" />
              Show live banners (Billboard, HPU, MREC) in the kit
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Billboard zone ID"><input className="input text-sm" value={bs.billboard_zone || ""} onChange={e => setBs({ billboard_zone: e.target.value })} placeholder="e.g. 49787" /></Field>
              <Field label="HPU zone ID"><input className="input text-sm" value={bs.hpu_zone || ""} onChange={e => setBs({ hpu_zone: e.target.value })} placeholder="e.g. 49786" /></Field>
              <Field label="MREC zone ID"><input className="input text-sm" value={bs.mrec_zone || ""} onChange={e => setBs({ mrec_zone: e.target.value })} placeholder="e.g. 82125" /></Field>
              <Field label="Masthead zone ID"><input className="input text-sm" value={bs.masthead_zone || ""} onChange={e => setBs({ masthead_zone: e.target.value })} placeholder="e.g. 49790" /></Field>
            </div>
            <p className="text-[10px] text-muted-foreground">Masthead is opt-in by the prospect via a toggle at the top of the kit. It is not shown by default.</p>
          </div>
        </>
      );
    }
    case "casual":
      return (
        <>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <Field label="Subheading"><input className="input text-sm" value={content.subheading || ""} onChange={e => set({ subheading: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={content.enabled !== false} onChange={e => set({ enabled: e.target.checked })} className="accent-[#e8312a]" />
            Show this section on the kit
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={content.hide_on_proposal !== false} onChange={e => set({ hide_on_proposal: e.target.checked })} className="accent-[#e8312a]" />
            Hide on PITCH proposals
            <span className="text-[10px] opacity-70">(default; proposals have tailored quotes)</span>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Price"><input className="input text-sm" value={content.price || ""} placeholder="USD $4,999" onChange={e => set({ price: e.target.value })} /></Field>
            <Field label="Period"><input className="input text-sm" value={content.price_period || ""} placeholder="/ 3 months" onChange={e => set({ price_period: e.target.value })} /></Field>
          </div>
          <Field label="Body"><textarea className="input text-sm min-h-[140px]" value={content.body || ""} onChange={e => set({ body: e.target.value })} /></Field>
          <BulletsField bullets={content.bullets || []} onChange={setBullets} label="Inclusions" />
          <Field label="Footer"><input className="input text-sm" value={content.footer || ""} onChange={e => set({ footer: e.target.value })} /></Field>
        </>
      );
    case "investment":
    case "boltons":
      return (
        <div className="rounded-md bg-zinc-500/10 border border-border px-3 py-3 text-xs text-muted-foreground">
          Pricing and tiers for this block are managed in the <strong>Tiers & Bolt-ons</strong> tab. Edit the heading/copy here.
          <div className="mt-3"><Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field></div>
          {blockKey === "boltons" && <Field label="Subheading"><input className="input text-sm" value={content.subheading || ""} onChange={e => set({ subheading: e.target.value })} /></Field>}
        </div>
      );
    case "terms":
      return (
        <>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <BulletsField bullets={(content.bullets || []).map((b: string) => ({ title: "", body: b }))} onChange={items => set({ bullets: items.map((b: any) => b.body) })} label="Terms" simple />
        </>
      );
    case "contact":
      return (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Publisher region"><input className="input text-sm" value={content.publisher || ""} onChange={e => set({ publisher: e.target.value })} /></Field>
          <Field label="Publisher name"><input className="input text-sm" value={content.publisher_name || ""} onChange={e => set({ publisher_name: e.target.value })} /></Field>
          <Field label="Publisher email"><input className="input text-sm" value={content.publisher_email || ""} onChange={e => set({ publisher_email: e.target.value })} /></Field>
          <Field label="Ad copy / creative email"><input className="input text-sm" value={content.ad_copy_email || ""} onChange={e => set({ ad_copy_email: e.target.value })} /></Field>
          <Field label="Company"><input className="input text-sm" value={content.company || ""} onChange={e => set({ company: e.target.value })} /></Field>
          <Field label="Managing director"><input className="input text-sm" value={content.managing_director || ""} onChange={e => set({ managing_director: e.target.value })} /></Field>
          <Field label="MD email"><input className="input text-sm" value={content.md_email || ""} onChange={e => set({ md_email: e.target.value })} /></Field>
        </div>
      );
    case "who_we_are_not":
      return (
        <>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <Field label="Subheading"><input className="input text-sm" value={content.subheading || ""} onChange={e => set({ subheading: e.target.value })} /></Field>
          <ParagraphsField paragraphs={content.paragraphs || []} onChange={setParagraphs} />
          <p className="text-[11px] text-muted-foreground">Paragraphs support **bold** and inline [link text](https://url) syntax.</p>
        </>
      );
    case "investment_callout":
      return (
        <>
          <Field label="Lead line (bold pull-quote)"><textarea className="input text-sm" rows={2} value={content.lead || ""} onChange={e => set({ lead: e.target.value })} /></Field>
          <Field label="Punch line (supporting)"><textarea className="input text-sm" rows={2} value={content.punch || ""} onChange={e => set({ punch: e.target.value })} /></Field>
        </>
      );
    case "find_a_store":
      return (
        <>
          <Field label="Enabled"><input type="checkbox" checked={content.enabled !== false} onChange={e => set({ enabled: e.target.checked })} /></Field>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <Field label="Intro paragraph"><textarea className="input text-sm" rows={3} value={content.intro || ""} onChange={e => set({ intro: e.target.value })} /></Field>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Steps</label>
            <button type="button" onClick={() => set({ steps: [...(content.steps || []), { title: "", body: "" }] })} className="text-xs px-2 py-1 rounded-md border border-border bg-card hover:bg-accent">+ Add step</button>
          </div>
          {(content.steps || []).map((s: any, i: number) => (
            <div key={i} className="border border-border rounded-md p-3 mb-2 space-y-2">
              <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground">Step {i + 1}</div>
              <Field label="Title"><input className="input text-sm" value={s.title || ""} onChange={e => { const next = [...(content.steps || [])]; next[i] = { ...next[i], title: e.target.value }; set({ steps: next }); }} /></Field>
              <Field label="Body"><textarea className="input text-sm" rows={3} value={s.body || ""} onChange={e => { const next = [...(content.steps || [])]; next[i] = { ...next[i], body: e.target.value }; set({ steps: next }); }} /></Field>
              <button type="button" onClick={() => set({ steps: (content.steps || []).filter((_: any, idx: number) => idx !== i) })} className="text-xs text-destructive hover:underline">Remove step</button>
            </div>
          ))}
          <Field label="Footer note (optional)"><textarea className="input text-sm" rows={2} value={content.footer_note || ""} onChange={e => set({ footer_note: e.target.value })} /></Field>
        </>
      );
    case "partner_quotes":
      return (
        <>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <Field label="Subheading (optional)"><input className="input text-sm" value={content.subheading || ""} onChange={e => set({ subheading: e.target.value })} /></Field>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Quotes</label>
            <button type="button" onClick={() => set({ quotes: [...(content.quotes || []), { quote: "", name: "", role: "", company: "" }] })} className="text-xs px-2 py-1 rounded-md border border-border bg-card hover:bg-accent">+ Add quote</button>
          </div>
          {(content.quotes || []).map((q: any, i: number) => (
            <div key={i} className="border border-border rounded-md p-3 mb-2 space-y-2">
              <Field label="Quote"><textarea className="input text-sm" rows={3} value={q.quote || ""} onChange={e => { const next = [...(content.quotes || [])]; next[i] = { ...next[i], quote: e.target.value }; set({ quotes: next }); }} /></Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Name"><input className="input text-sm" value={q.name || ""} onChange={e => { const next = [...(content.quotes || [])]; next[i] = { ...next[i], name: e.target.value }; set({ quotes: next }); }} /></Field>
                <Field label="Role"><input className="input text-sm" value={q.role || ""} onChange={e => { const next = [...(content.quotes || [])]; next[i] = { ...next[i], role: e.target.value }; set({ quotes: next }); }} /></Field>
                <Field label="Company"><input className="input text-sm" value={q.company || ""} onChange={e => { const next = [...(content.quotes || [])]; next[i] = { ...next[i], company: e.target.value }; set({ quotes: next }); }} /></Field>
              </div>
              <button type="button" onClick={() => set({ quotes: (content.quotes || []).filter((_: any, idx: number) => idx !== i) })} className="text-xs text-destructive hover:underline">Remove quote</button>
            </div>
          ))}
        </>
      );
    case "analytics_proof":
      return (
        <>
          <Field label="Heading"><input className="input text-sm" value={content.heading || ""} onChange={e => set({ heading: e.target.value })} /></Field>
          <Field label="Subheading"><input className="input text-sm" value={content.subheading || ""} onChange={e => set({ subheading: e.target.value })} /></Field>
          <Field label="Intro (supports blank-line paragraph breaks)"><textarea className="input text-sm" rows={4} value={content.intro || ""} onChange={e => set({ intro: e.target.value })} /></Field>
          <Field label="Example report URL"><input className="input text-sm" value={content.example_url || ""} onChange={e => set({ example_url: e.target.value })} /></Field>
          <Field label="Example report thumbnail URL"><input className="input text-sm" value={content.example_thumbnail || ""} onChange={e => set({ example_thumbnail: e.target.value })} /></Field>
          <Field label="Example caption"><input className="input text-sm" value={content.example_caption || ""} onChange={e => set({ example_caption: e.target.value })} /></Field>
          <Field label="Footer note"><textarea className="input text-sm" rows={2} value={content.footer_note || ""} onChange={e => set({ footer_note: e.target.value })} /></Field>
          <BulletsField bullets={content.bullets || []} onChange={setBullets} />
        </>
      );
    default:
      return <pre className="text-xs text-muted-foreground bg-zinc-500/5 p-3 rounded">{JSON.stringify(content, null, 2)}</pre>;
  }
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">{label}</label>
      {children}
    </div>
  );
}

// ─── Proposal Block Editor: select tier + bolt-ons + auto-total ──────────
// Drives what shows up in the personalised proposal card at the top of the kit
// and re-arranges the public page (tier section collapses to 'Your package',
// bolt-ons section splits into 'Included' + 'Explore more').
function ProposalEditor({ content, set, tiers, boltons }: { content: any; set: (patch: any) => void; tiers: Addon[]; boltons: Addon[] }) {
  const selectedTierKey = content.selected_tier_key || "";
  const selectedBoltonKeys: string[] = Array.isArray(content.selected_bolton_keys) ? content.selected_bolton_keys : [];
  const qty: Record<string, number> = (content.bolton_quantities && typeof content.bolton_quantities === "object") ? content.bolton_quantities : {};
  const autoTotal = content.auto_total !== false; // default ON

  const tier = selectedTierKey ? tiers.find(t => t.addon_key === selectedTierKey) : null;
  const selectedBoltons = selectedBoltonKeys.map(k => boltons.find(b => b.addon_key === k)).filter(Boolean) as Addon[];

  // Compute auto-total preview
  let computed = 0;
  let hasAnyPoa = false;
  if (tier) {
    if (tier.is_poa || tier.price_value == null) hasAnyPoa = true;
    else computed += Number(tier.price_value);
  }
  for (const b of selectedBoltons) {
    const q = Math.max(1, Number(qty[b.addon_key]) || 1);
    if (b.is_poa || b.price_value == null) hasAnyPoa = true;
    else computed += Number(b.price_value) * q;
  }

  const toggleBolton = (key: string) => {
    const next = new Set(selectedBoltonKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    set({ selected_bolton_keys: Array.from(next) });
  };
  const setQty = (key: string, q: number) => {
    const next = { ...qty, [key]: Math.max(1, q) };
    if (q <= 1) delete next[key];
    set({ bolton_quantities: next });
  };

  const fmt = (v: number | null, ccy: string) => {
    if (v == null) return "";
    return new Intl.NumberFormat("en-US", { style: "currency", currency: (ccy || "USD").toUpperCase(), maximumFractionDigits: 0 }).format(v);
  };
  const ccy = tier?.price_currency || selectedBoltons[0]?.price_currency || content.total_currency || "USD";

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground -mt-1">Define the scope of this prospect's proposal: pick one tier, the bolt-ons you're proposing, and the headline total. The public kit page will collapse the tier section to your selection and split bolt-ons into “included” vs “explore more”.</p>

      <Field label="Prepared for (company name)"><input className="input text-sm" value={content.prepared_for || ""} onChange={e => set({ prepared_for: e.target.value })} placeholder="Audiobro" /></Field>
      <Field label="Intro paragraph (1-2 lines under the heading)"><textarea className="input text-sm min-h-[60px]" value={content.subtitle || ""} onChange={e => set({ subtitle: e.target.value })} placeholder="A 12-month partnership built around your Q1 launch and ongoing distribution coverage in ANZ." /></Field>

      <div className="rounded-md border border-border bg-muted/20 p-3 space-y-3">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-bold uppercase tracking-wider text-foreground">Selected scope</div>
          {hasAnyPoa && <span className="text-[10px] text-amber-300">Contains POA items — total may be incomplete</span>}
        </div>

        <Field label="Recommended tier (pick one)">
          <select className="input text-sm" value={selectedTierKey} onChange={e => set({ selected_tier_key: e.target.value || null })}>
            <option value="">— No tier (custom only) —</option>
            {tiers.map(t => (
              <option key={t.addon_key} value={t.addon_key}>
                {t.label} · {t.is_poa ? "POA" : fmt(Number(t.price_value), t.price_currency)}{t.price_suffix ? " " + t.price_suffix : ""}
              </option>
            ))}
          </select>
        </Field>

        <div>
          <label className="block text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">Bolt-ons included in this proposal</label>
          <div className="space-y-1">
            {boltons.length === 0 && <p className="text-xs text-muted-foreground italic">No bolt-ons configured for this region.</p>}
            {boltons.map(b => {
              const isSelected = selectedBoltonKeys.includes(b.addon_key);
              const q = Math.max(1, Number(qty[b.addon_key]) || 1);
              return (
                <div key={b.addon_key} className={`flex items-center gap-2 px-2 py-1.5 rounded ${isSelected ? "bg-[#e8312a]/10 border border-[#e8312a]/30" : "hover:bg-muted/40 border border-transparent"}`}>
                  <input type="checkbox" checked={isSelected} onChange={() => toggleBolton(b.addon_key)} className="accent-[#e8312a]" />
                  <div className="flex-1 min-w-0 text-sm truncate">{b.label}</div>
                  {isSelected && (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-muted-foreground">qty</span>
                      <input type="number" min={1} step={1} value={q} onChange={e => setQty(b.addon_key, Number(e.target.value))} className="input text-xs w-14 text-center" />
                    </div>
                  )}
                  <div className="text-xs text-muted-foreground w-32 text-right">
                    {b.is_poa ? "POA" : fmt(Number(b.price_value), b.price_currency)}{b.price_suffix ? " " + b.price_suffix : ""}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={autoTotal} onChange={e => set({ auto_total: e.target.checked })} className="accent-[#e8312a]" />
        <span>Calculate total automatically from selected tier + bolt-ons</span>
      </label>
      {autoTotal && (
        <div className="rounded-md bg-[#e8312a]/[0.05] border border-[#e8312a]/30 px-3 py-2 text-sm">
          <span className="text-muted-foreground text-[11px] uppercase tracking-wider font-bold mr-2">Computed total</span>
          <span className="text-foreground font-bold">{fmt(computed, ccy)}</span>
          {hasAnyPoa && <span className="ml-2 text-amber-300 text-[11px]">+ POA items</span>}
        </div>
      )}

      {!autoTotal && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Total value (manual)"><input type="number" min={0} step={1} className="input text-sm" value={content.total_value ?? ""} onChange={e => set({ total_value: e.target.value === "" ? null : Number(e.target.value) })} placeholder="24000" /></Field>
          <Field label="Currency">
            <select className="input text-sm" value={content.total_currency || ccy} onChange={e => set({ total_currency: e.target.value })}>
              <option value="USD">USD</option>
              <option value="AUD">AUD</option>
              <option value="GBP">GBP</option>
              <option value="EUR">EUR</option>
            </select>
          </Field>
          <Field label="Period (e.g. /12 months)"><input className="input text-sm" value={content.total_period || ""} onChange={e => set({ total_period: e.target.value })} placeholder="/ 12 months" /></Field>
        </div>
      )}
      {autoTotal && (
        <Field label="Period (e.g. /12 months, /3 months, each)"><input className="input text-sm" value={content.total_period || ""} onChange={e => set({ total_period: e.target.value })} placeholder="/ 3 months" /></Field>
      )}

      <Field label="Valid until"><input type="date" className="input text-sm" value={content.valid_until || ""} onChange={e => set({ valid_until: e.target.value })} /></Field>
      <Field label="Notes (optional, shown below the summary)"><textarea className="input text-sm min-h-[60px]" value={content.notes || ""} onChange={e => set({ notes: e.target.value })} placeholder="Optional notes — e.g. start date, exclusions, payment terms." /></Field>
    </div>
  );
}

function BackgroundImageUploader({ url, onChange }: { url: string; onChange: (url: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/media-kit/upload-image", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || `Upload failed (${res.status})`);
      }
      const { url: newUrl } = await res.json();
      onChange(newUrl);
    } catch (e: any) {
      setError(e.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      {url && (
        <div className="flex items-center gap-3 p-2 border border-border rounded bg-muted/30">
          <img src={url} alt="" className="h-16 w-24 object-cover rounded" />
          <div className="flex-1 min-w-0">
            <div className="text-xs text-muted-foreground truncate">{url}</div>
          </div>
          <button
            type="button"
            onClick={() => onChange("")}
            className="text-xs text-red-500 hover:text-red-400 px-2 py-1"
          >
            Remove
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          disabled={uploading}
          onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          className="text-xs file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:bg-[#e8312a] file:text-white file:cursor-pointer file:text-xs hover:file:bg-[#d12822]"
        />
        {uploading && <span className="text-xs text-muted-foreground">Uploading…</span>}
      </div>
      {error && <div className="text-xs text-red-500">{error}</div>}
      <details className="text-[10px] text-muted-foreground">
        <summary className="cursor-pointer hover:text-foreground">Or paste URL</summary>
        <input
          className="input text-sm mt-1"
          value={url}
          onChange={e => onChange(e.target.value)}
          placeholder="https://..."
        />
      </details>
    </div>
  );
}

function ParagraphsField({ paragraphs, onChange }: { paragraphs: string[]; onChange: (p: string[]) => void }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">Paragraphs</label>
      <p className="text-[10px] text-muted-foreground mb-2">Supports <code>**bold**</code>, <code>*italic*</code>, and bullet lines starting with <code>-&nbsp;</code> or <code>*&nbsp;</code>.</p>
      <div className="space-y-2">
        {paragraphs.map((p, i) => (
          <div key={i} className="flex items-start gap-2">
            <textarea
              className="input text-sm flex-1 min-h-[180px] leading-relaxed"
              value={p}
              onChange={e => { const next = [...paragraphs]; next[i] = e.target.value; onChange(next); }}
            />
            <div className="flex flex-col gap-1">
              <button onClick={() => { if (i === 0) return; const next = [...paragraphs]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; onChange(next); }} className="text-xs text-muted-foreground hover:text-foreground p-1" disabled={i === 0}><ArrowUp className="w-3 h-3" /></button>
              <button onClick={() => { if (i === paragraphs.length - 1) return; const next = [...paragraphs]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; onChange(next); }} className="text-xs text-muted-foreground hover:text-foreground p-1" disabled={i === paragraphs.length - 1}><ArrowDown className="w-3 h-3" /></button>
              <button onClick={() => { onChange(paragraphs.filter((_, j) => j !== i)); }} className="text-xs text-red-400 hover:text-red-300 p-1"><X className="w-3 h-3" /></button>
            </div>
          </div>
        ))}
        <button onClick={() => onChange([...paragraphs, ""])} className="text-xs text-[#e8312a] hover:text-[#e8312a]/80 flex items-center gap-1"><Plus className="w-3 h-3" /> Add paragraph</button>
      </div>
    </div>
  );
}

function BulletsField({ bullets, onChange, label, simple }: { bullets: { title?: string; body?: string }[]; onChange: (b: { title?: string; body?: string }[]) => void; label: string; simple?: boolean }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">{label}</label>
      <div className="space-y-2">
        {bullets.map((b, i) => (
          <div key={i} className="flex items-start gap-2 border border-border/50 rounded-md p-2">
            <div className="flex-1 space-y-1">
              {!simple && <input className="input text-xs font-semibold" placeholder="Title" value={b.title || ""} onChange={e => { const next = [...bullets]; next[i] = { ...b, title: e.target.value }; onChange(next); }} />}
              <textarea className="input text-xs min-h-[90px] leading-relaxed" placeholder={simple ? "Item" : "Body"} value={b.body || ""} onChange={e => { const next = [...bullets]; next[i] = { ...b, body: e.target.value }; onChange(next); }} />
            </div>
            <div className="flex flex-col gap-1">
              <button onClick={() => { if (i === 0) return; const next = [...bullets]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; onChange(next); }} className="text-xs text-muted-foreground hover:text-foreground p-1" disabled={i === 0}><ArrowUp className="w-3 h-3" /></button>
              <button onClick={() => { if (i === bullets.length - 1) return; const next = [...bullets]; [next[i + 1], next[i]] = [next[i], next[i + 1]]; onChange(next); }} className="text-xs text-muted-foreground hover:text-foreground p-1" disabled={i === bullets.length - 1}><ArrowDown className="w-3 h-3" /></button>
              <button onClick={() => onChange(bullets.filter((_, j) => j !== i))} className="text-xs text-red-400 p-1"><X className="w-3 h-3" /></button>
            </div>
          </div>
        ))}
        <button onClick={() => onChange([...bullets, { title: "", body: "" }])} className="text-xs text-[#e8312a] flex items-center gap-1"><Plus className="w-3 h-3" /> Add item</button>
      </div>
    </div>
  );
}

function RegionSplitField({ split, onChange }: { split: { region: string; pct: number }[]; onChange: (s: { region: string; pct: number }[]) => void }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">Static region split (used if live GA4 is off)</label>
      <div className="space-y-1">
        {split.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            <input className="input text-xs flex-1" value={r.region} onChange={e => { const next = [...split]; next[i] = { ...r, region: e.target.value }; onChange(next); }} />
            <input type="number" step="0.01" className="input text-xs w-24" value={r.pct} onChange={e => { const next = [...split]; next[i] = { ...r, pct: Number(e.target.value) }; onChange(next); }} />
            <span className="text-xs text-muted-foreground">%</span>
            <button onClick={() => onChange(split.filter((_, j) => j !== i))} className="text-red-400 p-1"><X className="w-3 h-3" /></button>
          </div>
        ))}
        <button onClick={() => onChange([...split, { region: "", pct: 0 }])} className="text-xs text-[#e8312a] flex items-center gap-1"><Plus className="w-3 h-3" /> Add region</button>
      </div>
    </div>
  );
}

function TilesField({ tiles, onChange }: { tiles: { label: string; value: string; note?: string }[]; onChange: (t: { label: string; value: string; note?: string }[]) => void }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">Tiles (9 recommended)</label>
      <p className="text-[10px] text-muted-foreground mb-2">Each tile shows a big value, a label, and an optional small note for the source.</p>
      <div className="space-y-2">
        {tiles.map((t, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-start bg-zinc-500/5 p-2 rounded">
            <input className="input text-xs col-span-5" placeholder="Label" value={t.label} onChange={e => { const next = [...tiles]; next[i] = { ...t, label: e.target.value }; onChange(next); }} />
            <input className="input text-xs col-span-2" placeholder="Value" value={t.value} onChange={e => { const next = [...tiles]; next[i] = { ...t, value: e.target.value }; onChange(next); }} />
            <input className="input text-xs col-span-4" placeholder="Note (source)" value={t.note || ""} onChange={e => { const next = [...tiles]; next[i] = { ...t, note: e.target.value }; onChange(next); }} />
            <button onClick={() => onChange(tiles.filter((_, j) => j !== i))} className="text-red-400 p-1 col-span-1 justify-self-end"><X className="w-3 h-3" /></button>
          </div>
        ))}
        <button onClick={() => onChange([...tiles, { label: "", value: "", note: "" }])} className="text-xs text-[#e8312a] flex items-center gap-1"><Plus className="w-3 h-3" /> Add tile</button>
      </div>
    </div>
  );
}

function ResearchSourcesField({ sources, onChange }: { sources: { name: string; pct: number; highlight?: boolean }[]; onChange: (s: { name: string; pct: number; highlight?: boolean }[]) => void }) {
  return (
    <div>
      <label className="block text-[11px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">Research sources (ranked)</label>
      <p className="text-[10px] text-muted-foreground mb-2">Tick "highlight" on the bars that combine into the headline stat.</p>
      <div className="space-y-1">
        {sources.map((s, i) => (
          <div key={i} className="flex items-center gap-2">
            <input className="input text-xs flex-1" placeholder="Source name" value={s.name} onChange={e => { const next = [...sources]; next[i] = { ...s, name: e.target.value }; onChange(next); }} />
            <input type="number" className="input text-xs w-16" value={s.pct} onChange={e => { const next = [...sources]; next[i] = { ...s, pct: Number(e.target.value) || 0 }; onChange(next); }} />
            <span className="text-xs text-muted-foreground">%</span>
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <input type="checkbox" checked={!!s.highlight} onChange={e => { const next = [...sources]; next[i] = { ...s, highlight: e.target.checked }; onChange(next); }} className="accent-[#e8312a]" />
              highlight
            </label>
            <button onClick={() => onChange(sources.filter((_, j) => j !== i))} className="text-red-400 p-1"><X className="w-3 h-3" /></button>
          </div>
        ))}
        <button onClick={() => onChange([...sources, { name: "", pct: 0 }])} className="text-xs text-[#e8312a] flex items-center gap-1"><Plus className="w-3 h-3" /> Add source</button>
      </div>
    </div>
  );
}

// ─── Addons Tab ─────────────────────────────────────────────────────────────
function SortableBlocks({
  kit, blocks, tiers, boltons, openBlockKey, setOpenBlockKey, onChanged,
}: {
  kit: Kit; blocks: Block[]; tiers: Addon[]; boltons: Addon[];
  openBlockKey: string | null; setOpenBlockKey: (k: string | null) => void; onChanged: () => void;
}) {
  const { toast } = useToast();
  const [order, setOrder] = useState<Block[]>(blocks);
  useEffect(() => { setOrder(blocks); }, [blocks.map(b => b.block_key).join(",")]);
  const dragKeyRef = useRef<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const persist = async (newOrder: Block[]) => {
    const r = await apiRequest("PATCH", `/api/media-kit/kits/${kit.id}/blocks/reorder`, {
      block_keys: newOrder.map(b => b.block_key),
    });
    if (!r.ok) {
      toast({ title: "Reorder failed", variant: "destructive" });
      setOrder(blocks);
    } else {
      toast({ title: "Order saved" });
      onChanged();
    }
  };
  const resetOrder = async () => {
    if (!confirm("Reset to default order? Custom order will be cleared.")) return;
    const r = await apiRequest("DELETE", `/api/media-kit/kits/${kit.id}/blocks/reorder`);
    if (r.ok) { toast({ title: "Reset to default order" }); onChanged(); }
    else toast({ title: "Reset failed", variant: "destructive" });
  };

  const onDragStart = (key: string) => (e: React.DragEvent) => {
    dragKeyRef.current = key;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", key);
  };
  const onDragOver = (key: string) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overKey !== key) setOverKey(key);
  };
  const onDragLeave = () => setOverKey(null);
  const onDrop = (targetKey: string) => (e: React.DragEvent) => {
    e.preventDefault();
    const srcKey = dragKeyRef.current;
    setOverKey(null);
    dragKeyRef.current = null;
    if (!srcKey || srcKey === targetKey) return;
    const srcIdx = order.findIndex(b => b.block_key === srcKey);
    const tgtIdx = order.findIndex(b => b.block_key === targetKey);
    if (srcIdx < 0 || tgtIdx < 0) return;
    const next = [...order];
    const [moved] = next.splice(srcIdx, 1);
    next.splice(tgtIdx, 0, moved);
    setOrder(next);
    persist(next);
  };
  const onDragEnd = () => { dragKeyRef.current = null; setOverKey(null); };

  return (
    <div className="px-6 py-5 max-w-4xl">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Drag the ⋮⋮ handle to reorder. Order is per-kit.</span>
        <button onClick={resetOrder} className="text-xs text-muted-foreground hover:text-foreground underline">Reset to default order</button>
      </div>
      <div className="space-y-3">
        {order.map(b => (
          <div
            key={b.block_key}
            draggable
            onDragStart={onDragStart(b.block_key)}
            onDragOver={onDragOver(b.block_key)}
            onDragLeave={onDragLeave}
            onDrop={onDrop(b.block_key)}
            onDragEnd={onDragEnd}
            className={`relative transition-all ${overKey === b.block_key ? "ring-2 ring-[#e8312a] ring-offset-1 ring-offset-background rounded-lg" : ""}`}
          >
            <div className="absolute left-1 top-1/2 -translate-y-1/2 z-10 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-foreground px-1 select-none" title="Drag to reorder">⋮⋮</div>
            <div className="pl-6">
              <BlockCard
                block={b}
                kit={kit}
                tiers={tiers}
                boltons={boltons}
                isOpen={openBlockKey === b.block_key}
                onToggle={() => setOpenBlockKey(openBlockKey === b.block_key ? null : b.block_key)}
                onChanged={onChanged}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AddonsTab({ kit, tiers, boltons, onChanged }: { kit: Kit; tiers: Addon[]; boltons: Addon[]; onChanged: () => void }) {
  // Retailer kits don't sell bolt-ons; only show the Tier Packages section.
  const isRetailer = kit.kind === "retailer";
  return (
    <div className="px-6 py-5 space-y-6 max-w-5xl">
      <section>
        <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground mb-3">Tier Packages</h2>
        <div className="space-y-2">
          {tiers.map(t => <AddonRow key={t.id} addon={t} onChanged={onChanged} kitKind={kit.kind} />)}
          {tiers.length === 0 && <p className="text-xs text-muted-foreground">No tiers configured for this kit's region.</p>}
        </div>
      </section>
      {!isRetailer && (
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-bold uppercase tracking-wide text-muted-foreground">Bolt-on Promos</h2>
            <span className="text-[10px] text-muted-foreground/70">Drag rows to reorder</span>
          </div>
          <SortableAddons addons={boltons} onChanged={onChanged} kitId={kit.id} />
          {boltons.length === 0 && <p className="text-xs text-muted-foreground">No bolt-ons configured for this kit's region.</p>}
        </section>
      )}
    </div>
  );
}

function SortableAddons({ addons, onChanged, kitId }: { addons: Addon[]; onChanged: () => void; kitId: number }) {
  const { toast } = useToast();
  // Local order — synced from props but allows optimistic reordering before server confirms.
  const [order, setOrder] = useState<Addon[]>(addons);
  useEffect(() => { setOrder(addons); }, [addons.map(a => a.id).join(",")]);
  const dragIdRef = useRef<number | null>(null);
  const [overId, setOverId] = useState<number | null>(null);

  const persist = async (newOrder: Addon[]) => {
    const r = await apiRequest("PATCH", `/api/media-kit/addons/reorder`, { ids: newOrder.map(a => a.id), kit_id: kitId });
    if (!r.ok) {
      toast({ title: "Reorder failed", variant: "destructive" });
      setOrder(addons); // revert
    } else {
      onChanged();
    }
  };

  const onDragStart = (id: number) => (e: React.DragEvent) => {
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
    // Required for Firefox
    e.dataTransfer.setData("text/plain", String(id));
  };
  const onDragOver = (id: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overId !== id) setOverId(id);
  };
  const onDragLeave = () => setOverId(null);
  const onDrop = (targetId: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const srcId = dragIdRef.current;
    setOverId(null);
    dragIdRef.current = null;
    if (srcId == null || srcId === targetId) return;
    const srcIdx = order.findIndex(a => a.id === srcId);
    const tgtIdx = order.findIndex(a => a.id === targetId);
    if (srcIdx < 0 || tgtIdx < 0) return;
    const next = [...order];
    const [moved] = next.splice(srcIdx, 1);
    next.splice(tgtIdx, 0, moved);
    setOrder(next);
    persist(next);
  };
  const onDragEnd = () => { dragIdRef.current = null; setOverId(null); };

  return (
    <div className="space-y-2">
      {order.map(b => (
        <div
          key={b.id}
          draggable
          onDragStart={onDragStart(b.id)}
          onDragOver={onDragOver(b.id)}
          onDragLeave={onDragLeave}
          onDrop={onDrop(b.id)}
          onDragEnd={onDragEnd}
          className={`relative transition-all ${overId === b.id ? "ring-2 ring-[#e8312a] ring-offset-1 ring-offset-background rounded-lg" : ""}`}
        >
          <div className="absolute left-1 top-1/2 -translate-y-1/2 z-10 cursor-grab active:cursor-grabbing text-muted-foreground/40 hover:text-foreground px-1 select-none" title="Drag to reorder">⋮⋮</div>
          <div className="pl-6"><AddonRow addon={b} onChanged={onChanged} /></div>
        </div>
      ))}
    </div>
  );
}

function AddonRow({ addon, onChanged, kitKind }: { addon: Addon; onChanged: () => void; kitKind?: string }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(addon.label);
  const [subtitle, setSubtitle] = useState(addon.subtitle || "");
  const [description, setDescription] = useState(addon.description || "");
  const [priceValue, setPriceValue] = useState<string>(addon.price_value != null ? String(addon.price_value) : "");
  const [currency, setCurrency] = useState(addon.price_currency);
  const [suffix, setSuffix] = useState(addon.price_suffix || "");
  const [billing, setBilling] = useState(addon.billing);
  const [availability, setAvailability] = useState(addon.availability);
  const [isPoa, setIsPoa] = useState(addon.is_poa === 1);
  const [visible, setVisible] = useState(addon.is_visible === 1);
  const [exampleUrl, setExampleUrl] = useState(addon.example_url || "");
  // Inclusions — only used for tier rows. Edits the comparison-matrix values
  // per tier (Banners count, News & PR yes/no, etc.). Stored as a JSON blob on
  // media_kit_addons.inclusions_json.
  const [inclusions, setInclusions] = useState<Record<string, any>>(addon.inclusions || {});
  const setIncl = (key: string, value: any) => setInclusions(prev => ({ ...prev, [key]: value }));
  const save = async () => {
    const r = await apiRequest("PATCH", `/api/media-kit/addons/${addon.id}`, {
      label, subtitle, description,
      price_value: isPoa ? null : (priceValue === "" ? null : Number(priceValue)),
      price_currency: currency, price_suffix: suffix, billing, availability,
      is_poa: isPoa ? 1 : 0, is_visible: visible ? 1 : 0,
      example_url: exampleUrl.trim() || null,
      // Only send inclusions_json for tier rows.
      ...(addon.kind === "tier" ? { inclusions_json: JSON.stringify(inclusions) } : {}),
    });
    if (r.ok) { toast({ title: "Saved" }); setOpen(false); onChanged(); }
    else toast({ title: "Save failed", variant: "destructive" });
  };
  const priceLabel = isPoa || addon.price_value == null
    ? "POA"
    : `${currency} ${Number(priceValue || 0).toLocaleString()} ${suffix}`;
  const isHidden = addon.is_visible === 0;
  return (
    <div className={`rounded-lg border bg-card ${isHidden ? "border-zinc-700/60 opacity-60" : "border-border"}`}>
      <button onClick={() => setOpen(!open)} className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left">
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
          <span className={`font-semibold text-sm ${isHidden ? "line-through text-muted-foreground" : ""}`}>{label}</span>
          {isHidden && (
            <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400" title="This tier/bolt-on is hidden from prospects. Expand and tick Visible to bring it back.">Hidden</span>
          )}
          <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${availability === "available" ? "bg-green-500/15 text-green-400" : availability === "sold_out" ? "bg-red-500/15 text-red-400" : "bg-zinc-500/15 text-zinc-400"}`}>{availability.replace("_", " ")}</span>
        </div>
        <span className="text-sm text-muted-foreground font-mono">{priceLabel}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 grid grid-cols-2 gap-3 border-t border-border/50 pt-3">
          <Field label="Label"><input className="input text-sm" value={label} onChange={e => setLabel(e.target.value)} /></Field>
          <Field label="Subtitle"><input className="input text-sm" value={subtitle} onChange={e => setSubtitle(e.target.value)} /></Field>
          <Field label="Description"><textarea className="input text-sm min-h-[100px]" value={description} onChange={e => setDescription(e.target.value)} /></Field>
          <Field label="Example URL (optional)">
            <input
              className="input text-sm"
              type="url"
              value={exampleUrl}
              onChange={e => setExampleUrl(e.target.value)}
              placeholder="https://www.stereonet.com/news/article-example"
            />
          </Field>
          <div className="grid grid-cols-3 gap-2">
            <Field label="Currency">
              <select className="input text-sm" value={currency} onChange={e => setCurrency(e.target.value)}>
                {["USD", "AUD", "GBP", "EUR", "SGD"].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Price">
              <input className="input text-sm" type="text" inputMode="decimal" value={priceValue} disabled={isPoa} onChange={e => setPriceValue(e.target.value.replace(/[^0-9.]/g, ""))} />
            </Field>
            <Field label="Suffix"><input className="input text-sm" value={suffix} onChange={e => setSuffix(e.target.value)} placeholder="no tax" /></Field>
          </div>
          <Field label="Billing">
            <select className="input text-sm" value={billing} onChange={e => setBilling(e.target.value)}>
              <option value="monthly">Monthly</option>
              <option value="annual">Annual</option>
              <option value="one_off">One-off</option>
              <option value="3_month">3-Month Special</option>
              <option value="poa">POA</option>
            </select>
          </Field>
          <Field label="Availability">
            <select className="input text-sm" value={availability} onChange={e => setAvailability(e.target.value as any)}>
              <option value="available">Available</option>
              <option value="sold_out">Sold out</option>
              <option value="coming_soon">Coming soon</option>
              <option value="not_available">Not available</option>
            </select>
          </Field>
          {addon.kind === "tier" && (
            <div className="col-span-2 pt-3 border-t border-border/50">
              <h3 className="text-xs font-bold uppercase tracking-wide text-muted-foreground mb-3">Inclusions · comparison matrix values</h3>
              {kitKind === "retailer" ? (
                <>
                  <div className="grid grid-cols-1 gap-3 max-w-xs">
                    <Field label="Additional Advertising Discount %"><input type="number" min={0} max={100} className="input text-sm" value={inclusions.discount_pct ?? ""} onChange={e => setIncl("discount_pct", e.target.value === "" ? null : Number(e.target.value))} placeholder="0" /></Field>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    {[
                      ["store_listed", "Your store listed in Find a Store page"],
                      ["forum_access", "Global Commercial Forum Access"],
                      ["sponsor_forum", "Your very own Retailer Sponsor Forum"],
                      ["competitions", "Competitions & Giveaways"],
                      ["event_coverage", "Event Coverage & Promotion"],
                      ["display_banners", "Display Advertising Banners"],
                      ["classifieds_access", "Commercial Classifieds Access"],
                      ["ai_discoverability", "AI Discoverability & LLM Surfacing"],
                      ["newsletter_social", "Newsletter & Social Media Coverage"],
                    ].map(([key, lbl]) => (
                      <label key={key} className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 px-2.5 py-1.5 rounded border border-border/50 cursor-pointer hover:border-border">
                        <input type="checkbox" checked={!!inclusions[key]} onChange={e => setIncl(key, e.target.checked)} className="accent-[#e8312a]" />
                        <span>{lbl}</span>
                      </label>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Display Banner Sets (number)"><input type="number" min={0} className="input text-sm" value={inclusions.banners ?? ""} onChange={e => setIncl("banners", e.target.value === "" ? null : Number(e.target.value))} placeholder="0" /></Field>
                    <Field label="Ad Weighting (multiplier x)"><input type="number" step="0.1" className="input text-sm" value={inclusions.ad_weighting ?? ""} onChange={e => setIncl("ad_weighting", e.target.value === "" ? null : Number(e.target.value))} placeholder="1" /></Field>
                    <Field label="Review Slots per 12 months"><input type="number" min={0} className="input text-sm" value={inclusions.reviews_per_year ?? ""} onChange={e => setIncl("reviews_per_year", e.target.value === "" ? null : Number(e.target.value))} placeholder="0" /></Field>
                    <Field label="Additional Advertising Discount %"><input type="number" min={0} max={100} className="input text-sm" value={inclusions.discount_pct ?? ""} onChange={e => setIncl("discount_pct", e.target.value === "" ? null : Number(e.target.value))} placeholder="0" /></Field>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    {[
                      ["news_pr", "Unlimited News & PR with Editorial Priority"],
                      ["newsletter_social", "Newsletter & Social Media Coverage"],
                      ["brand_distributor_pages", "Brand & Distributor Pages"],
                      ["exclusive_forum", "Exclusive Global Sponsor Forum"],
                      ["classifieds_access", "Commercial Classifieds Access"],
                      ["ai_discoverability", "AI Discoverability & LLM Surfacing"],
                    ].map(([key, lbl]) => (
                      <label key={key} className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/30 px-2.5 py-1.5 rounded border border-border/50 cursor-pointer hover:border-border">
                        <input type="checkbox" checked={!!inclusions[key]} onChange={e => setIncl(key, e.target.checked)} className="accent-[#e8312a]" />
                        <span>{lbl}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
          <div className="col-span-2 flex items-center justify-between pt-2 border-t border-border/50">
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={isPoa} onChange={e => setIsPoa(e.target.checked)} className="accent-[#e8312a]" /> Price on Application (POA)</label>
              <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={visible} onChange={e => setVisible(e.target.checked)} className="accent-[#e8312a]" /> Visible</label>
            </div>
            <button onClick={save} className="px-4 py-1.5 rounded-md bg-[#e8312a] text-white text-xs font-semibold">Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Shares Tab ─────────────────────────────────────────────────────────────
function SharesTab({ kit }: { kit: Kit }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, refetch } = useQuery<{ shares: Share[] }>({
    queryKey: [`/api/media-kit/kits/${kit.id}/shares`],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/media-kit/kits/${kit.id}/shares`);
      if (!r.ok) throw new Error(`Load failed (${r.status})`);
      return r.json();
    },
  });
  const [showNew, setShowNew] = useState(false);

  const shares = data?.shares || [];
  return (
    <div className="px-6 py-5 max-w-5xl">
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-muted-foreground">Create a personalised, token-gated link for each prospect.</p>
        <button onClick={() => setShowNew(true)} className="px-3 py-1.5 rounded-md bg-[#e8312a] text-white text-xs font-semibold flex items-center gap-1.5"><Plus className="w-3.5 h-3.5" /> New share link</button>
      </div>
      {showNew && <NewShareForm kitId={kit.id} onCreated={() => { setShowNew(false); refetch(); }} onCancel={() => setShowNew(false)} />}
      <div className="space-y-2 mt-4">
        {shares.map(s => <ShareRow key={s.id} share={s} onChanged={refetch} />)}
        {shares.length === 0 && <p className="text-xs text-muted-foreground">No shares created yet.</p>}
      </div>
    </div>
  );
}

function NewShareForm({ kitId, onCreated, onCancel }: { kitId: number; onCreated: () => void; onCancel: () => void }) {
  const { toast } = useToast();
  const [company, setCompany] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [days, setDays] = useState(90);
  const [creating, setCreating] = useState(false);
  const submit = async () => {
    setCreating(true);
    try {
      const expiry = new Date(); expiry.setDate(expiry.getDate() + days);
      const r = await apiRequest("POST", `/api/media-kit/kits/${kitId}/shares`, {
        prospect_company: company, prospect_name: name, prospect_email: email, note,
        expires_at: expiry.toISOString(),
      });
      if (!r.ok) throw new Error("Create failed");
      toast({ title: "Share link created" });
      onCreated();
    } catch (e: any) {
      toast({ title: "Failed", description: e.message, variant: "destructive" });
    } finally { setCreating(false); }
  };
  return (
    <div className="rounded-lg border border-[#e8312a]/40 bg-[#e8312a]/[0.04] p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Prospect company"><input className="input text-sm" value={company} onChange={e => setCompany(e.target.value)} placeholder="Innuos" /></Field>
        <Field label="Contact name (optional)"><input className="input text-sm" value={name} onChange={e => setName(e.target.value)} placeholder="Nuno Vitorino" /></Field>
        <Field label="Contact email (optional)"><input className="input text-sm" value={email} onChange={e => setEmail(e.target.value)} placeholder="nuno@innuos.com" /></Field>
        <Field label="Expires in (days)"><input type="number" min={1} max={365} className="input text-sm" value={days} onChange={e => setDays(Math.max(1, Math.min(365, Number(e.target.value) || 30)))} /></Field>
      </div>
      <Field label="Internal note (only you see this)"><textarea className="input text-sm min-h-[80px]" value={note} onChange={e => setNote(e.target.value)} /></Field>
      <div className="flex items-center gap-2">
        <button onClick={submit} disabled={creating || !company} className="px-4 py-1.5 rounded-md bg-[#e8312a] disabled:bg-[#e8312a]/40 text-white text-xs font-semibold">{creating ? "Creating…" : "Create share link"}</button>
        <button onClick={onCancel} className="px-3 py-1.5 rounded-md border border-border text-xs">Cancel</button>
      </div>
    </div>
  );
}

function ShareRow({ share, onChanged }: { share: Share; onChanged: () => void }) {
  const { toast } = useToast();
  const [showViews, setShowViews] = useState(false);
  const url = `${window.location.origin}/kit/${share.slug}?t=${encodeURIComponent(share.magic_token)}`;
  const expired = share.expires_at && new Date(share.expires_at).getTime() < Date.now();
  const statusLabel = share.status === "revoked" ? "REVOKED" : expired ? "EXPIRED" : share.status.toUpperCase();
  const statusColor = share.status === "revoked" || expired
    ? "bg-zinc-500/15 text-zinc-400"
    : share.view_count > 0 ? "bg-green-500/15 text-green-400" : "bg-blue-500/15 text-blue-400";

  const copy = () => { navigator.clipboard.writeText(url); toast({ title: "Link copied" }); };
  const revoke = async () => {
    if (!confirm("Revoke this share link? The prospect will no longer be able to view it.")) return;
    const r = await apiRequest("PATCH", `/api/media-kit/shares/${share.id}`, { status: "revoked" });
    if (r.ok) { toast({ title: "Link revoked" }); onChanged(); }
  };
  const regenerate = async () => {
    if (!confirm("Generate a new magic token? The old link will stop working.")) return;
    const r = await apiRequest("POST", `/api/media-kit/shares/${share.id}/regenerate-token`, {});
    if (r.ok) { toast({ title: "New link generated" }); onChanged(); }
  };
  const remove = async () => {
    if (!confirm("Permanently delete this share link and all its analytics?")) return;
    const r = await apiRequest("DELETE", `/api/media-kit/shares/${share.id}`);
    if (r.ok) { toast({ title: "Share deleted" }); onChanged(); }
  };

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-semibold text-sm truncate">{share.prospect_company || share.prospect_name || "Untitled share"}</span>
            <span className={`text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded ${statusColor}`}>{statusLabel}</span>
          </div>
          <div className="text-[11px] text-muted-foreground flex items-center gap-3 flex-wrap">
            <span>{share.view_count} {share.view_count === 1 ? "view" : "views"}</span>
            {share.last_viewed_at && <span>· Last opened {new Date(share.last_viewed_at).toLocaleString()}</span>}
            {share.expires_at && <span>· Expires {new Date(share.expires_at).toLocaleDateString()}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={copy} title="Copy link" className="p-1.5 rounded hover:bg-accent/30"><Copy className="w-3.5 h-3.5" /></button>
          <a href={url} target="_blank" rel="noreferrer" title="Open" className="p-1.5 rounded hover:bg-accent/30"><ExternalLink className="w-3.5 h-3.5" /></a>
          <button onClick={() => setShowViews(!showViews)} title="View analytics" className="p-1.5 rounded hover:bg-accent/30"><BarChart3 className="w-3.5 h-3.5" /></button>
          {share.status === "active" && (
            <button onClick={revoke} title="Revoke" className="p-1.5 rounded hover:bg-amber-500/20 text-amber-400"><RotateCcw className="w-3.5 h-3.5" /></button>
          )}
          <button onClick={regenerate} title="Regenerate token" className="p-1.5 rounded hover:bg-accent/30"><LinkIcon className="w-3.5 h-3.5" /></button>
          <button onClick={remove} title="Delete" className="p-1.5 rounded hover:bg-red-500/20 text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
        </div>
      </div>
      {showViews && <ShareViewsPanel shareId={share.id} />}
    </div>
  );
}

function ShareViewsPanel({ shareId }: { shareId: number }) {
  const { data } = useQuery<{ views: any[] }>({
    queryKey: [`/api/media-kit/shares/${shareId}/views`],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/media-kit/shares/${shareId}/views`);
      if (!r.ok) throw new Error("Load failed");
      return r.json();
    },
  });
  const views = data?.views || [];
  return (
    <div className="border-t border-border/50 px-4 py-3 bg-zinc-500/5">
      <div className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2">Recent views</div>
      {views.length === 0 && <p className="text-xs text-muted-foreground">No views recorded yet.</p>}
      <div className="space-y-1">
        {views.slice(0, 10).map(v => (
          <div key={v.id} className="text-xs text-muted-foreground flex justify-between font-mono">
            <span>{new Date(v.viewed_at).toLocaleString()}</span>
            <span>{v.time_on_page_seconds ? `${v.time_on_page_seconds}s` : "—"} {v.scroll_depth_pct ? `· ${v.scroll_depth_pct}% scroll` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── HistoryPanel ─────────────────────────────────────────────────────────
// Global view of every Media Kit sent — Quick Send + proposal links.
// Each row shows recipient, source (Quick Send vs Proposal), open count, and
// expands to a per-recipient IP/country/UA log identical to PITCH's view-activity.
function fmtDateAEST(s?: string | null): string {
  if (!s) return "—";
  // SQLite datetime('now') returns UTC without a marker — coerce to ISO Z.
  let iso = s;
  if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    iso = s.replace(" ", "T") + "Z";
  }
  return new Date(iso).toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

type HistoryShare = {
  id: number;
  kit_id: number;
  slug: string;
  magic_token: string;
  prospect_name: string | null;
  prospect_email: string | null;
  prospect_company: string | null;
  note: string | null;
  created_at: string;
  sent_at: string | null;
  expires_at: string | null;
  proposal_state: string;
  first_viewed_at: string | null;
  last_viewed_at: string | null;
  view_count: number;
  kit_label: string;
  kit_region: string | null;
  kit_kind: string;
  kit_is_canonical: number;
  created_by_username: string | null;
  proposal_id: number | null;
  source: "proposal" | "quick_send";
  link: string;
};

type HistoryView = {
  id: number;
  viewed_at: string;
  ip: string | null;
  user_agent: string | null;
  is_bot: boolean;
  bot_reason: string | null;
  recipient_email: string | null;
  country: string | null;
  country_code: string | null;
};

function HistoryPanel() {
  const { toast } = useToast();
  const [filter, setFilter] = useState<"all" | "quick_send" | "proposal" | "opened" | "unopened">("all");
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const { data, isLoading, error, refetch } = useQuery<{ shares: HistoryShare[] }>({
    queryKey: ["/api/media-kit/history"],
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/media-kit/history");
      if (!r.ok) throw new Error(`Load failed (${r.status})`);
      return r.json();
    },
  });

  const revokeShare = async (s: HistoryShare) => {
    if (!window.confirm(`Revoke the magic link for ${s.prospect_email || s.prospect_name || "this recipient"}?\n\nThe link will stop working immediately. The history row stays for your records.`)) return;
    const r = await apiRequest("POST", `/api/media-kit/shares/${s.id}/revoke`);
    if (r.ok) { toast({ title: "Link revoked" }); refetch(); }
    else { const j = await r.json().catch(() => ({})); toast({ title: "Revoke failed", description: j?.message || `(${r.status})`, variant: "destructive" }); }
  };

  const deleteShare = async (s: HistoryShare) => {
    if (!window.confirm(`Permanently DELETE this send to ${s.prospect_email || s.prospect_name || "this recipient"}?\n\nThis removes the share row AND all its view history. Cannot be undone.`)) return;
    const r = await apiRequest("DELETE", `/api/media-kit/shares/${s.id}`);
    if (r.ok) { toast({ title: "Deleted" }); refetch(); }
    else { const j = await r.json().catch(() => ({})); toast({ title: "Delete failed", description: j?.message || `(${r.status})`, variant: "destructive" }); }
  };

  const shares = data?.shares || [];
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return shares.filter(row => {
      if (filter === "quick_send" && row.source !== "quick_send") return false;
      if (filter === "proposal" && row.source !== "proposal") return false;
      if (filter === "opened" && (row.view_count || 0) === 0) return false;
      if (filter === "unopened" && (row.view_count || 0) > 0) return false;
      if (s) {
        const hay = `${row.prospect_name || ""} ${row.prospect_email || ""} ${row.prospect_company || ""} ${row.kit_label || ""}`.toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [shares, filter, search]);

  if (isLoading) return <div className="p-8 text-muted-foreground">Loading history…</div>;
  if (error) return <div className="p-8 text-red-400">{(error as Error).message}</div>;

  const total = shares.length;
  const opened = shares.filter(s => (s.view_count || 0) > 0).length;
  const quickSendCount = shares.filter(s => s.source === "quick_send").length;

  return (
    <div className="px-6 py-5 max-w-6xl">
      <div className="mb-5">
        <h1 className="text-2xl font-bold">Sent Media Kits</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Every Media Kit ever sent — Quick Send and proposal-linked. {total} total · {opened} opened · {quickSendCount} via Quick Send.
        </p>
      </div>

      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <input
          type="text"
          placeholder="Search by name, email, company, kit…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="px-3 py-2 rounded-md bg-background border border-border text-sm flex-1 min-w-[260px]"
        />
        {(["all", "quick_send", "proposal", "opened", "unopened"] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-xs px-3 py-1.5 rounded-md border ${filter === f ? "bg-[#e8312a]/15 border-[#e8312a]/40 text-[#e8312a]" : "bg-card border-border hover:bg-accent text-muted-foreground"}`}
          >
            {f === "all" ? "All" : f === "quick_send" ? "Quick Send" : f === "proposal" ? "Proposals" : f === "opened" ? "Opened" : "Not opened"}
          </button>
        ))}
        <button onClick={() => refetch()} className="text-xs px-3 py-1.5 rounded-md border border-border bg-card hover:bg-accent text-muted-foreground">Refresh</button>
      </div>

      {filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground italic py-8 text-center">No sent Media Kits match the current filter.</div>
      ) : (
        <div className="border border-border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="text-left px-3 py-2 font-medium">Sent (AEST)</th>
                <th className="text-left px-3 py-2 font-medium">Recipient</th>
                <th className="text-left px-3 py-2 font-medium">Kit</th>
                <th className="text-left px-3 py-2 font-medium">Source</th>
                <th className="text-left px-3 py-2 font-medium">Opens</th>
                <th className="text-left px-3 py-2 font-medium">By</th>
                <th className="text-right px-3 py-2 font-medium">Link</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <React.Fragment key={s.id}>
                  <tr
                    className={`border-t border-border cursor-pointer hover:bg-accent/30 ${expandedId === s.id ? "bg-accent/30" : ""}`}
                    onClick={() => setExpandedId(expandedId === s.id ? null : s.id)}
                  >
                    <td className="px-3 py-2 font-mono text-xs">{fmtDateAEST(s.sent_at)}</td>
                    <td className="px-3 py-2">
                      <div className="font-semibold">{s.prospect_name || "—"}</div>
                      <div className="text-xs text-muted-foreground">{s.prospect_email || "—"}{s.prospect_company ? ` · ${s.prospect_company}` : ""}</div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="text-xs">{s.kit_label}</div>
                      <div className="text-[10px] text-muted-foreground uppercase">{s.kit_region || "global"}</div>
                    </td>
                    <td className="px-3 py-2">
                      <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${s.source === "quick_send" ? "bg-blue-500/15 text-blue-400 border border-blue-500/30" : "bg-purple-500/15 text-purple-400 border border-purple-500/30"}`}>
                        {s.source === "quick_send" ? "Quick Send" : "Proposal"}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      {(s.view_count || 0) > 0 ? (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                          Opened · {s.view_count}×
                        </span>
                      ) : (
                        <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400 border border-zinc-600">
                          Not opened
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{s.created_by_username || "—"}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => {
                            const url = `${window.location.origin}${s.link}`;
                            navigator.clipboard.writeText(url).catch(() => {});
                            toast({ title: "Link copied" });
                          }}
                          className="text-xs px-2 py-1 rounded border border-border hover:bg-accent"
                          title="Copy magic link"
                          disabled={s.proposal_state === "revoked"}
                        >
                          <Copy className="w-3 h-3 inline" /> Copy
                        </button>
                        {s.proposal_state !== "revoked" && (
                          <button
                            onClick={() => revokeShare(s)}
                            className="text-xs px-2 py-1 rounded border border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                            title="Revoke magic link (recipient loses access; history kept)"
                          >
                            Revoke
                          </button>
                        )}
                        <button
                          onClick={() => deleteShare(s)}
                          className="text-xs px-2 py-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10"
                          title="Delete this send and all its view history (permanent)"
                        >
                          <Trash2 className="w-3 h-3 inline" />
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === s.id && (
                    <tr className="border-t border-border bg-zinc-900/30">
                      <td colSpan={7} className="px-3 py-4">
                        <ShareActivity shareId={s.id} share={s} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ShareActivity({ shareId, share }: { shareId: number; share: HistoryShare }) {
  const { data, isLoading } = useQuery<{ views: HistoryView[] }>({
    queryKey: ["/api/media-kit/shares", shareId, "view-activity"],
    queryFn: async () => {
      const r = await apiRequest("GET", `/api/media-kit/shares/${shareId}/view-activity`);
      if (!r.ok) throw new Error(`Load failed (${r.status})`);
      return r.json();
    },
  });
  const views = data?.views || [];
  const real = views.filter(v => !v.is_bot);
  const bots = views.filter(v => v.is_bot);

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted-foreground flex items-center gap-4 flex-wrap">
        <span>First opened: <strong className="text-foreground">{fmtDateAEST(share.first_viewed_at)}</strong></span>
        <span>Last opened: <strong className="text-foreground">{fmtDateAEST(share.last_viewed_at)}</strong></span>
        <span>Magic link: <code className="text-[11px]">{share.slug}</code></span>
        <a href={share.link} target="_blank" rel="noopener noreferrer" className="text-[#e8312a] hover:underline inline-flex items-center gap-1"><ExternalLink className="w-3 h-3" /> Open kit</a>
      </div>
      {isLoading && <div className="text-xs text-muted-foreground">Loading view log…</div>}
      {!isLoading && views.length === 0 && <div className="text-xs text-muted-foreground italic">No views recorded yet.</div>}
      {!isLoading && views.length > 0 && (
        <>
          <div className="text-xs text-muted-foreground">
            {real.length} real open{real.length !== 1 ? "s" : ""}{bots.length > 0 ? ` · ${bots.length} bot/scanner row${bots.length !== 1 ? "s" : ""} (faded)` : ""}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-muted-foreground border-b border-border">
                  <th className="py-1.5 pr-4 font-medium">When (AEST)</th>
                  <th className="py-1.5 pr-4 font-medium">IP</th>
                  <th className="py-1.5 pr-4 font-medium">Country</th>
                  <th className="py-1.5 pr-4 font-medium">Source</th>
                </tr>
              </thead>
              <tbody>
                {views.map(v => {
                  const ua = String(v.user_agent || "");
                  const browser =
                    /Edg\//.test(ua) ? "Edge" :
                    /Chrome\//.test(ua) ? "Chrome" :
                    /Firefox\//.test(ua) ? "Firefox" :
                    /Safari\//.test(ua) ? "Safari" :
                    v.is_bot ? "Bot" : "Other";
                  const device = /iPhone|Android|Mobile/i.test(ua) ? "Mobile" : "Desktop";
                  return (
                    <tr key={v.id} className={`border-b border-border/40 ${v.is_bot ? "opacity-50" : ""}`}>
                      <td className="py-1.5 pr-4 font-mono text-zinc-300">{fmtDateAEST(v.viewed_at)}</td>
                      <td className="py-1.5 pr-4 font-mono text-zinc-300">{v.ip || "—"}</td>
                      <td className="py-1.5 pr-4 text-zinc-200">
                        {v.country ? (
                          <span>
                            {v.country_code && (<span className="inline-block mr-1.5 text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">{v.country_code}</span>)}
                            {v.country}
                          </span>
                        ) : "—"}
                      </td>
                      <td className="py-1.5 pr-4">
                        {v.is_bot ? (
                          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30" title={v.bot_reason || ""}>
                            Bot · {v.bot_reason || "unknown"}
                          </span>
                        ) : (
                          <span className="text-zinc-300">{browser} · {device}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
