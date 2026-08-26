// PITCH admin page — list, create (wizard), edit, send, revoke, clone.
// Internal to PULSE. Permission-gated.

import React, { useState, useMemo, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/queryClient";
import { useToast } from "../hooks/use-toast";
import LeadsEmbedded from "./Leads";
import MediaKitsEmbedded from "./MediaKits";
import {
  FilePlus2, Send, Eye, Copy, Trash2, RotateCcw, Save, Link as LinkIcon,
  Pencil, X, ChevronRight, ChevronDown, ChevronUp, Sparkles, Settings as SettingsIcon,
  ArrowUp, ArrowDown, GripVertical, Calendar,
} from "lucide-react";

type Proposal = {
  id: number;
  slug: string;
  client_name: string;
  client_logo_url?: string | null;
  client_contact_name?: string | null;
  client_contact_email?: string | null;
  client_region?: string | null;
  base_tier: string;
  currency: string;
  fx_rate_to_usd: number;
  fx_rate_date?: string | null;
  contract_months: number;
  override_discount_pct: number;
  discount_label_override?: string | null;
  pricing_posture?: string | null;
  target_monthly_usd?: number | null;
  intro_text?: string | null;
  status: string;
  expires_at?: string | null;
  created_at: string;
  sent_at?: string | null;
  first_viewed_at?: string | null;
  last_viewed_at?: string | null;
  view_count: number;
  decision?: string | null;
  decision_name?: string | null;
  decided_at?: string | null;
  levers: string[];
  competitors: string[];
  brands: string[];
  notify_emails: string[];
  regions: string[];
  billing_company_name?: string | null;
  billing_address?: string | null;
  accounts_contacts: { name: string; email: string }[];
};

const REGIONS = [
  { key: "na",    label: "North America" },
  { key: "uk_eu", label: "UK & Europe" },
  { key: "asia",  label: "Asia" },
  { key: "anz",   label: "Australia & NZ" },
];

type LineItem = {
  id?: number;
  sort_order?: number;
  category: "core" | "bolt-on" | "discount";
  label: string;
  description?: string | null;
  qty: number;
  unit?: string | null;
  unit_price_usd: number;
  is_complimentary?: boolean;
  original_unit_price_usd?: number | null;
  included: number | boolean;
  notes?: string | null;
};

// Wizard-region → media_kits.region (DB) mapping. Global maps to NULL = canonical Trade kit.
const WIZARD_REGION_TO_KIT_REGION: Record<string, string | null> = {
  "": null,         // "— All —" defaults to the canonical Global kit
  "global": null,
  "uk-eu": "uk_eu",
  "na": "na",
  "anz": "anz",
  "sea": "asia",    // wizard says "Southeast Asia", DB stores it as 'asia'
};

// Fallback used when the live Media Kit lookup fails. Keep these conservative —
// real prices are pulled from the kit's tier addons (USD-quoted Global kit).
const FALLBACK_TIERS = [
  { key: "partner",  label: "Partner",  monthly: 0, currency: "USD", is_poa: true },
  { key: "bronze",   label: "Bronze",   monthly: 0, currency: "USD", is_poa: true },
  { key: "silver",   label: "Silver",   monthly: 0, currency: "USD", is_poa: true },
  { key: "gold",     label: "Gold",     monthly: 0, currency: "USD", is_poa: true },
  { key: "platinum", label: "Platinum", monthly: 0, currency: "USD", is_poa: true },
];

const POSTURES = [
  { key: "match_competitor", label: "Match competitor pricing", desc: "Client says we're more expensive than competitors. Trim entitlements to hit a target." },
  { key: "trial",             label: "Trial / market entry",     desc: "Introductory deal to win the relationship." },
  { key: "premium",           label: "Premium positioning",      desc: "Hold the price; lean on value." },
  { key: "renewal",           label: "Renewal / upsell",         desc: "Build on history; push to next tier." },
];

const LEVERS = [
  { key: "lower_ad_weighting",   label: "Lower ad weighting" },
  { key: "fewer_reviews",        label: "Fewer reviews per year" },
  { key: "drop_edm",             label: "Drop EDM / newsletter" },
  { key: "shorter_contract",     label: "Reduce contract length (<6 months)" },
  { key: "drop_social",          label: "Drop social media coverage" },
  { key: "flat_discount",        label: "Apply flat % discount" },
];

const DEFAULT_COMPETITORS = [
  "ecoustics", "hifipig", "stereophile", "darko", "twitteringmachines",
  "enjoythemusic", "hifiplus", "parttimeaudiophile", "absolutesound",
  "hifinews", "audiostream",
];

const CURRENCIES = ["USD", "AUD", "GBP", "EUR", "CAD", "NZD", "SGD", "JPY"];

function fmtMoney(usd: number, currency: string, rate: number) {
  const v = usd * (rate || 1);
  return new Intl.NumberFormat("en-AU", { style: "currency", currency, currencyDisplay: "narrowSymbol", maximumFractionDigits: 0 }).format(v);
}

function fmtDate(s?: string | null) {
  if (!s) return "—";
  // SQLite's datetime('now') returns UTC as "YYYY-MM-DD HH:MM:SS" with no
  // timezone marker. JS interprets that as LOCAL time which is wrong — it's
  // really UTC. Coerce to ISO-8601 with Z so Date() parses correctly, then
  // force the AEST display so it's consistent regardless of the viewer's
  // browser locale.
  let iso = s;
  if (typeof s === "string" && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    iso = s.replace(" ", "T") + "Z";
  }
  return new Date(iso).toLocaleString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
    hour12: false,
  });
}

export default function Pitch() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showWizard, setShowWizard] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showQuickSend, setShowQuickSend] = useState(false);
  const [showProposalTypeChooser, setShowProposalTypeChooser] = useState(false);
  const [showRetailerProposal, setShowRetailerProposal] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editingOpenViews, setEditingOpenViews] = useState(false);
  type PitchTab = "proposals" | "leads" | "kits" | "partnership" | "inclusions";
  const VALID_TABS: PitchTab[] = ["proposals", "leads", "kits", "partnership", "inclusions"];
  const [activeTab, setActiveTab] = useState<PitchTab>(() => {
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      const fromUrl = url.searchParams.get("tab") as PitchTab;
      if (VALID_TABS.includes(fromUrl)) return fromUrl;
      const stored = window.localStorage.getItem("pitch_active_tab") as PitchTab;
      if (VALID_TABS.includes(stored)) return stored;
    }
    return "proposals";
  });
  React.useEffect(() => {
    try { window.localStorage.setItem("pitch_active_tab", activeTab); } catch {}
  }, [activeTab]);
  // When Leads asks us to open a customised kit, switch to the kits tab and tell MediaKits to focus that kit.
  const [pendingKitId, setPendingKitId] = useState<number | null>(null);
  const openKitFromLead = (kitId: number) => {
    setPendingKitId(kitId);
    setActiveTab("kits");
  };

  // Lead count for the tab badge
  const { data: leadsCounts } = useQuery<{ counts: Record<string, number> }>({
    queryKey: ["/api/leads", "counts-only"],
    queryFn: () => apiRequest("GET", "/api/leads").then(r => r.json()),
    refetchInterval: 60000,
  });
  const newLeadCount = leadsCounts?.counts?.new || 0;

  const { data, isLoading } = useQuery<{ proposals: Proposal[]; my_access: string }>({
    queryKey: ["/api/pitch"],
    queryFn: () => apiRequest("GET", "/api/pitch").then(r => r.json()),
  });

  const proposals = data?.proposals || [];
  const myAccess = data?.my_access || "none";
  const canEdit = myAccess === "edit" || myAccess === "admin";
  // Managers (edit) can send & respond; only Admins can override/customise kit content.
  const canCustomise = myAccess === "admin";

  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading PITCH…</div>;
  }

  if (myAccess === "none") {
    return (
      <div className="p-8 max-w-2xl mx-auto text-center">
        <Sparkles className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
        <h2 className="text-xl font-semibold mb-2">PITCH access required</h2>
        <p className="text-muted-foreground">
          You don't have access to PITCH yet. Ask an admin to grant you view or edit access.
        </p>
      </div>
    );
  }

  if (editingId !== null) {
    return <PitchEditor id={editingId} onBack={() => { setEditingId(null); setEditingOpenViews(false); }} openViewsOnMount={editingOpenViews} />;
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-6 py-5 border-b border-border flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">PITCH</h1>
          <p className="text-sm text-muted-foreground">Customised digital advertising proposals.</p>
        </div>
        <div className="flex items-center gap-2">
          {myAccess === "admin" && (
            <button onClick={() => setShowSettings(true)} className="flex items-center gap-2 px-3 py-2 rounded-md border border-border hover:bg-accent text-sm">
              <SettingsIcon className="w-4 h-4" /> Settings
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => setShowQuickSend(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-md border border-border hover:bg-accent text-sm font-semibold"
              title="Quick Send: deliver a Media Kit to a recipient without creating a lead"
            >
              <Send className="w-4 h-4" /> Quick Send
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => setShowProposalTypeChooser(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 active:scale-95 transition-all text-white text-sm font-semibold"
            >
              <FilePlus2 className="w-4 h-4" /> New Proposal
            </button>
          )}
        </div>
      </div>

      {showWizard && (
        <PitchWizard
          onClose={() => setShowWizard(false)}
          onCreated={(id) => { setShowWizard(false); setEditingId(id); qc.invalidateQueries({ queryKey: ["/api/pitch"] }); }}
        />
      )}
      {showProposalTypeChooser && (
        <ProposalTypeChooser
          onClose={() => setShowProposalTypeChooser(false)}
          onPickTrade={() => { setShowProposalTypeChooser(false); setShowWizard(true); }}
          onPickRetailer={() => { setShowProposalTypeChooser(false); setShowRetailerProposal(true); }}
        />
      )}
      {showRetailerProposal && (
        <RetailerProposalModal
          onClose={() => setShowRetailerProposal(false)}
          onCreated={() => {
            setShowRetailerProposal(false);
            qc.invalidateQueries({ queryKey: ["/api/leads"] });
            qc.invalidateQueries({ queryKey: ["/api/media-kit/kits"] });
            setActiveTab("leads");
          }}
        />
      )}
      {showSettings && <PitchSettingsModal onClose={() => setShowSettings(false)} />}
      {showQuickSend && <QuickSendModal onClose={() => setShowQuickSend(false)} onSent={() => { setShowQuickSend(false); qc.invalidateQueries({ queryKey: ["/api/media-kit/kits"] }); }} />}

      {/* Sub-tabs: Proposals | Inbound Leads | Media Kits */}
      <div className="border-b border-border px-6">
        <div className="flex gap-1">
          <button
            onClick={() => setActiveTab("proposals")}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors -mb-px ${activeTab === "proposals" ? "border-[#e8312a] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            Proposals
            <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-zinc-500/15">{proposals.length}</span>
          </button>
          <button
            onClick={() => setActiveTab("leads")}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors -mb-px ${activeTab === "leads" ? "border-[#e8312a] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            Inbound Leads
            {newLeadCount > 0 && (
              <span className="ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold bg-[#e8312a] text-white">{newLeadCount} new</span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("kits")}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors -mb-px ${activeTab === "kits" ? "border-[#e8312a] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            Media Kits
          </button>
          <button
            onClick={() => setActiveTab("partnership")}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors -mb-px ${activeTab === "partnership" ? "border-[#e8312a] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            Partnership Menu
          </button>
          <button
            onClick={() => setActiveTab("inclusions")}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors -mb-px ${activeTab === "inclusions" ? "border-[#e8312a] text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
          >
            Tier Inclusions
          </button>
        </div>
      </div>

      {activeTab === "proposals" && (
        <div className="p-6">
          {proposals.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <p>No proposals yet.</p>
              {canEdit && <p className="text-sm mt-2">Click <strong>New Proposal</strong> to create your first one.</p>}
            </div>
          ) : (
            <div className="grid gap-3">
              {proposals.map(p => (
                <ProposalRow
                  key={p.id}
                  p={p}
                  onOpen={() => { setEditingOpenViews(false); setEditingId(p.id); }}
                  onOpenWithViews={() => { setEditingOpenViews(true); setEditingId(p.id); }}
                  canEdit={canEdit}
                />
              ))}
            </div>
          )}
        </div>
      )}
      {activeTab === "leads" && (
        <div className="flex-1 min-h-0">
          <LeadsEmbedded onOpenKit={openKitFromLead} />
        </div>
      )}
      {activeTab === "kits" && (
        <div className="flex-1 min-h-0">
          <MediaKitsEmbedded initialKitId={pendingKitId} includeProspects canCustomise={canCustomise} />
        </div>
      )}
      {activeTab === "partnership" && (
        <div className="flex-1 min-h-0 overflow-auto">
          <PartnershipMenuEditor canEdit={canEdit} />
        </div>
      )}
      {activeTab === "inclusions" && (
        <div className="flex-1 min-h-0 overflow-auto">
          <TierInclusionsEditor canEdit={canEdit} />
        </div>
      )}
    </div>
  );
}

function statusBadge(status: string) {
  const map: Record<string, string> = {
    draft:    "bg-muted text-muted-foreground",
    sent:     "bg-blue-500/15 text-blue-400 border border-blue-500/30",
    viewed:   "bg-amber-500/15 text-amber-400 border border-amber-500/30",
    accepted: "bg-green-500/15 text-green-400 border border-green-500/30",
    declined: "bg-red-500/15 text-red-400 border border-red-500/30",
    expired:  "bg-zinc-500/15 text-zinc-400 border border-zinc-500/30",
    revoked:  "bg-zinc-700/30 text-zinc-500 border border-zinc-700/40",
  };
  return map[status] || "bg-muted text-muted-foreground";
}

function ProposalRow({ p, onOpen, canEdit }: { p: Proposal; onOpen: () => void; onOpenWithViews?: () => void; canEdit: boolean }) {
  return (
    <button
      onClick={onOpen}
      className="text-left w-full p-4 rounded-lg border border-border bg-card hover:border-[#e8312a]/40 hover:bg-accent/40 active:scale-[0.99] transition-all flex items-center gap-4"
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="font-semibold truncate">{p.client_name}</span>
          <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${statusBadge(p.status)}`}>{p.status}</span>
          <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{p.base_tier}</span>
          {p.status === "sent" && (
            p.view_count && p.view_count > 0 ? (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
                Opened · {p.view_count}
              </span>
            ) : (
              <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-zinc-700/50 text-zinc-400 border border-zinc-600">
                Not opened
              </span>
            )
          )}
        </div>
        <div className="text-xs text-muted-foreground flex items-center gap-3">
          <span>Created {fmtDate(p.created_at)}</span>
          {p.sent_at && <span>· Sent {fmtDate(p.sent_at)}</span>}
          {p.last_viewed_at && <span>· Last viewed {fmtDate(p.last_viewed_at)}</span>}
          {p.view_count > 0 && <span>· {p.view_count} view{p.view_count !== 1 ? "s" : ""}</span>}
        </div>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Wizard
// ─────────────────────────────────────────────────────────────────────────────

function PitchWizard({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<any>({
    proposal_type: "proposal", // 'proposal' (monthly base + tier + contract) | 'casual' (one-off, no tier, no contract)
    client_name: "",
    client_logo_url: "",
    client_contact_name: "",
    client_contact_email: "",
    client_region: "",
    brands: [] as string[],
    base_tier: "silver",
    pricing_posture: "premium",
    levers: [] as string[],
    target_monthly_usd: null as number | null,
    competitors: DEFAULT_COMPETITORS,
    notify_emails: ["admin@stereonet.com"],
    contract_months: 6,
    proposed_start_date: "",
    currency: "USD",
    regions: ["na", "uk_eu", "asia", "anz"],
  });
  // Local string states for comma-separated text fields — only split on save so
  // the user can type commas normally without state thrashing every keystroke.
  const [brandsInput, setBrandsInput] = useState("");
  const [competitorsInput, setCompetitorsInput] = useState(DEFAULT_COMPETITORS.join(", "));
  const [emailsInput, setEmailsInput] = useState("admin@stereonet.com");

  const update = (patch: any) => setForm((s: any) => ({ ...s, ...patch }));

  // ── Live tier pricing from the Media Kit matching the chosen focus region ──
  // Falls back to FALLBACK_TIERS when the kit can't be resolved.
  const targetKitRegion = WIZARD_REGION_TO_KIT_REGION[form.client_region as string];
  const { data: kitsList } = useQuery<{ kits: any[] }>({
    queryKey: ["/api/media-kit/kits", { wizard: 1 }],
    queryFn: () => apiRequest("GET", "/api/media-kit/kits").then(r => r.json()),
  });
  const matchedKit = (kitsList?.kits || []).find((k: any) =>
    k.kind === "trade" && k.status === "published" && (targetKitRegion === null ? k.region == null : k.region === targetKitRegion)
  );
  const { data: kitDetail } = useQuery<{ kit: any; addons: { tiers: any[] } }>({
    queryKey: ["/api/media-kit/kits", matchedKit?.id, "wizard-tiers"],
    enabled: !!matchedKit?.id,
    queryFn: () => apiRequest("GET", `/api/media-kit/kits/${matchedKit!.id}`).then(r => r.json()),
  });
  const liveTiers = (() => {
    const rows = kitDetail?.addons?.tiers || [];
    if (rows.length === 0) return FALLBACK_TIERS;
    return rows.filter((t: any) => t.is_visible !== 0).map((t: any) => ({
      key: String(t.addon_key || t.label || "").toLowerCase().replace(/[^a-z0-9]+/g, "_"),
      label: t.label,
      monthly: t.price_value || 0,
      currency: t.price_currency || "USD",
      is_poa: t.is_poa === 1 || t.price_value == null,
    }));
  })();
  // If the user changes region and the previously-selected tier no longer exists,
  // reset to the first available tier so submission stays valid.
  useEffect(() => {
    if (!liveTiers.length) return;
    if (!liveTiers.some((t: any) => t.key === form.base_tier)) {
      setForm((s: any) => ({ ...s, base_tier: liveTiers[0].key }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedKit?.id, kitDetail?.kit?.id]);

  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      // If the user picked a specific Region focus (e.g. ANZ), narrow the
      // proposal's regions[] to just that region so the linked kit clone
      // inherits from the matching regional Media Kit — not the canonical
      // Global one. Mapping mirrors WIZARD_REGION_TO_KIT_REGION above.
      const wizardToProposalRegion: Record<string, string> = {
        "uk-eu": "uk_eu",
        "na": "na",
        "anz": "anz",
        "sea": "asia",
      };
      const narrowedRegions = form.client_region && wizardToProposalRegion[form.client_region]
        ? [wizardToProposalRegion[form.client_region]]
        : form.regions;
      // For casual proposals, force a sane base_tier value (server ignores it
      // when proposal_type='casual') and skip seeding line items.
      const isCasual = form.proposal_type === "casual";
      const payload = {
        ...form,
        regions: narrowedRegions,
        base_tier: isCasual ? "partner" : form.base_tier,
        contract_months: isCasual ? null : form.contract_months,
        brands: brandsInput.split(",").map((s: string) => s.trim()).filter(Boolean),
        competitors: competitorsInput.split(",").map((s: string) => s.trim()).filter(Boolean),
        notify_emails: emailsInput.split(",").map((s: string) => s.trim()).filter(Boolean),
      };
      const r = await apiRequest("POST", "/api/pitch", payload);
      const j = await r.json();
      onCreated(j.id);
    } catch (e: any) {
      alert("Failed to create proposal: " + (e?.message || e));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">New PITCH Proposal</h2>
            <p className="text-xs text-muted-foreground">Step {step} of 5</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
          {step === 1 && (
            <div className="space-y-3">
              <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Proposal type</h3>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => update({ proposal_type: "proposal" })}
                  className={`p-3 rounded-md border text-left transition-all ${form.proposal_type === "proposal" ? "border-[#e8312a] bg-[#e8312a]/10" : "border-border hover:border-foreground/40"}`}
                >
                  <div className="font-semibold text-sm">Full proposal</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">Bronze → Gold tier + contract length. Recurring monthly investment.</div>
                </button>
                <button
                  type="button"
                  onClick={() => update({ proposal_type: "casual" })}
                  className={`p-3 rounded-md border text-left transition-all ${form.proposal_type === "casual" ? "border-[#e8312a] bg-[#e8312a]/10" : "border-border hover:border-foreground/40"}`}
                >
                  <div className="font-semibold text-sm">Casual / Ad-hoc</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">No tier, no contract. One-off bolt-ons priced individually — e.g. masthead buy, EDM, one review.</div>
                </button>
              </div>
              <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground pt-2">Client basics</h3>
              <Field label="Client name *">
                <input className="input" autoFocus value={form.client_name} onChange={e => update({ client_name: e.target.value })} placeholder="Innuos" />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Contact name">
                  <input className="input" value={form.client_contact_name} onChange={e => update({ client_contact_name: e.target.value })} placeholder="Nuno Vitorino" />
                </Field>
                <Field label="Contact email">
                  <input className="input" value={form.client_contact_email} onChange={e => update({ client_contact_email: e.target.value })} placeholder="nuno@innuos.com" />
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <LogoUploader value={form.client_logo_url} onChange={url => update({ client_logo_url: url })} />
                <Field label="Region focus">
                  <select className="input" value={form.client_region} onChange={e => update({ client_region: e.target.value })}>
                    <option value="">— All —</option>
                    <option value="global">Global</option>
                    <option value="uk-eu">UK & Europe</option>
                    <option value="na">North America</option>
                    <option value="anz">Australia / NZ</option>
                    <option value="sea">Southeast Asia</option>
                  </select>
                </Field>
              </div>
              <Field label="Brands to feature (comma separated)">
                <input className="input" value={brandsInput} onChange={e => setBrandsInput(e.target.value)} placeholder="Innuos, Innuos Statement" />
              </Field>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-3">
              {form.proposal_type === "casual" ? (
                <div className="rounded-md border border-[#e8312a]/30 bg-[#e8312a]/5 p-3 text-xs text-muted-foreground">
                  <strong className="text-foreground">Casual / Ad-hoc proposal</strong> — no tier selection. You'll add bolt-on line items (masthead, EDM, reviews, etc.) one by one in the editor after creation.
                </div>
              ) : (
              <>
              <div className="flex items-baseline justify-between">
                <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Starting tier</h3>
                {matchedKit && (
                  <span className="text-[11px] text-muted-foreground">
                    From <strong className="text-foreground">{matchedKit.label}</strong>
                  </span>
                )}
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
                {liveTiers.map((t: any) => (
                  <button
                    key={t.key}
                    onClick={() => update({ base_tier: t.key })}
                    className={`p-3 rounded-md border text-center transition-all ${
                      form.base_tier === t.key
                        ? "border-[#e8312a] bg-[#e8312a]/10"
                        : "border-border hover:border-foreground/40"
                    }`}
                  >
                    <div className="text-xs font-semibold uppercase">{t.label}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {t.is_poa ? "P.O.A" : `${t.currency || "USD"} ${Number(t.monthly).toLocaleString()}/mo`}
                    </div>
                  </button>
                ))}
              </div>
              </>
              )}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Proposed start date">
                  <input
                    type="date"
                    className="input"
                    value={form.proposed_start_date || ""}
                    onChange={e => update({ proposed_start_date: e.target.value })}
                  />
                </Field>
                {form.proposal_type !== "casual" && (
                  <Field label="Contract duration">
                    <select className="input" value={form.contract_months} onChange={e => update({ contract_months: Number(e.target.value) })}>
                      <option value={3}>3 months</option>
                      <option value={6}>6 months (standard)</option>
                      <option value={12}>12 months</option>
                      <option value={24}>24 months</option>
                    </select>
                  </Field>
                )}
              </div>
              <Field label="Currency">
                <select className="input" value={form.currency} onChange={e => update({ currency: e.target.value })}>
                  {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </Field>
              <Field label="Regions included (uncheck any that aren't relevant)">
                <div className="grid grid-cols-2 gap-1.5">
                  {REGIONS.map(r => (
                    <label key={r.key} className="flex items-center gap-2 text-sm p-2 rounded hover:bg-accent/40 cursor-pointer border border-border">
                      <input
                        type="checkbox"
                        checked={form.regions.includes(r.key)}
                        onChange={e => update({
                          regions: e.target.checked
                            ? [...form.regions, r.key]
                            : form.regions.filter((k: string) => k !== r.key)
                        })}
                      />
                      <span>{r.label}</span>
                    </label>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">All four selected = the proposal will show <strong>Global</strong>. Otherwise, the selected regions are listed by name.</p>
              </Field>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Pricing posture</h3>
              <div className="grid gap-2">
                {POSTURES.map(p => (
                  <button
                    key={p.key}
                    onClick={() => update({ pricing_posture: p.key })}
                    className={`text-left p-3 rounded-md border transition-all ${
                      form.pricing_posture === p.key ? "border-[#e8312a] bg-[#e8312a]/10" : "border-border hover:border-foreground/40"
                    }`}
                  >
                    <div className="font-semibold text-sm">{p.label}</div>
                    <div className="text-xs text-muted-foreground">{p.desc}</div>
                  </button>
                ))}
              </div>

              {(form.pricing_posture === "match_competitor" || form.pricing_posture === "trial") && (
                <Field label="Target monthly figure (USD, optional)">
                  <input
                    type="number"
                    className="input"
                    value={form.target_monthly_usd ?? ""}
                    onChange={e => update({ target_monthly_usd: e.target.value ? Number(e.target.value) : null })}
                    placeholder="e.g. 1500"
                  />
                </Field>
              )}

              <Field label="Negotiation levers the client wants">
                <div className="grid grid-cols-2 gap-1.5">
                  {LEVERS.map(l => (
                    <label key={l.key} className="flex items-center gap-2 text-sm p-2 rounded hover:bg-accent/40 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.levers.includes(l.key)}
                        onChange={e => update({
                          levers: e.target.checked
                            ? [...form.levers, l.key]
                            : form.levers.filter((k: string) => k !== l.key)
                        })}
                      />
                      <span>{l.label}</span>
                    </label>
                  ))}
                </div>
              </Field>
            </div>
          )}

          {step === 4 && (
            <div className="space-y-3">
              <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Competitor benchmark set</h3>
              <p className="text-xs text-muted-foreground">These publications will be charted against StereoNET in the cadence comparison.</p>
              <Field label="Competitors (comma-separated site keys)">
                <textarea
                  className="input min-h-[80px]"
                  value={competitorsInput}
                  onChange={e => setCompetitorsInput(e.target.value)}
                />
              </Field>
              <p className="text-[11px] text-muted-foreground">Defaults: ecoustics · hifipig · stereophile · darko · twitteringmachines · enjoythemusic · hifiplus · parttimeaudiophile · absolutesound · hifinews · audiostream</p>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-4">
              <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">Notify on accept / decline</h3>
              <Field label="Email recipients (comma separated)">
                <textarea
                  className="input min-h-[60px]"
                  value={emailsInput}
                  onChange={e => setEmailsInput(e.target.value)}
                />
              </Field>
              <div className="text-xs text-muted-foreground p-3 rounded-md bg-muted/30 border border-border space-y-1">
                <div>Proposal will be created as a <strong>draft</strong>. Magic link expires 30 days after you click <strong>Send</strong>.</div>
                <div>The client supplies their <strong>billing company name, address and invoicing contacts</strong> on the proposal page before they accept.</div>
              </div>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-border flex items-center justify-between">
          <button
            onClick={() => step > 1 ? setStep(step - 1) : onClose()}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
          >
            {step > 1 ? "Back" : "Cancel"}
          </button>
          {step < 5 ? (
            <button
              onClick={() => setStep(step + 1)}
              disabled={step === 1 && !form.client_name}
              className="px-5 py-2 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 text-white text-sm font-semibold disabled:opacity-50"
            >
              Next
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <button
                onClick={async () => {
                  try {
                    const payload = {
                      ...form,
                      brands: brandsInput.split(",").map((s: string) => s.trim()).filter(Boolean),
                      competitors: competitorsInput.split(",").map((s: string) => s.trim()).filter(Boolean),
                      notify_emails: emailsInput.split(",").map((s: string) => s.trim()).filter(Boolean),
                    };
                    const r = await apiRequest("POST", "/api/pitch/preview-kit", payload);
                    const j = await r.json();
                    if (j?.magic_link) {
                      window.open(j.magic_link, "_blank");
                    } else {
                      alert("Preview failed: no link returned");
                    }
                  } catch (e: any) {
                    alert("Preview failed: " + (e?.message || e));
                  }
                }}
                disabled={submitting}
                className="px-5 py-2 rounded-md border border-border bg-transparent text-foreground hover:border-[#e8312a] text-sm font-semibold disabled:opacity-50"
              >
                Preview
              </button>
              <button
                onClick={submit}
                disabled={submitting}
                className="px-5 py-2 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 disabled:bg-[#e8312a]/60 disabled:cursor-wait text-white text-sm font-semibold inline-flex items-center gap-2 transition-all active:scale-[0.97]"
              >
                {submitting && (
                  <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                    <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                )}
                {submitting ? "Creating draft…" : "Create Draft"}
              </button>
            </div>
          )}
        </div>
      </div>

      <style>{`
        .input { width: 100%; padding: 8px 10px; border-radius: 6px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); color: hsl(var(--foreground)); font-size: 13px; }
        .input::placeholder { color: rgba(255,255,255,0.35); }
        .input:focus { outline: 2px solid rgba(232,49,42,0.4); border-color: #e8312a; }
        .input:disabled { opacity: 0.6; }
        select.input { appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml;charset=US-ASCII,%3Csvg width='12' height='8' viewBox='0 0 12 8' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23ffffff80' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px; }
        select.input option, .input option { background: #1a1a1d; color: #f3f3f4; padding: 6px 10px; }
        select.input option:checked, .input option:checked { background: #e8312a; color: white; }
      `}</style>
    </div>
  );
}

function BoltonPicker({ proposalId, region, onAdded }: { proposalId: number; region: string | null; onAdded: () => void }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState<number | null>(null);
  const { data } = useQuery<{ addons: any[] }>({
    queryKey: [`/api/pitch/addons${region ? `?region=${region}` : ""}`],
    queryFn: async () => {
      const url = region ? `/api/pitch/addons?region=${encodeURIComponent(region)}` : "/api/pitch/addons";
      const r = await apiRequest("GET", url);
      if (!r.ok) throw new Error("Load failed");
      return r.json();
    },
    enabled: open,
  });
  const add = async (id: number) => {
    setAdding(id);
    try {
      const r = await apiRequest("POST", `/api/pitch/${proposalId}/line-items/from-addon`, { addon_id: id, qty: 1 });
      if (!r.ok) throw new Error("Failed");
      toast({ title: "Bolt-on added" });
      onAdded();
    } catch (e: any) {
      toast({ title: "Failed", variant: "destructive" });
    } finally { setAdding(null); }
  };
  return (
    <div className="relative">
      <button onClick={() => setOpen(!open)} className="text-xs px-2 py-1 rounded bg-[#e8312a]/15 border border-[#e8312a]/40 text-[#e8312a] hover:bg-[#e8312a]/25 font-semibold">
        + From Catalogue
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-[420px] max-h-[420px] overflow-y-auto bg-card border border-border rounded-md shadow-xl z-50 p-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-bold px-2 py-1">Bolt-ons {region ? `(${region.toUpperCase()})` : "(Global)"}</div>
          {(data?.addons || []).map(a => (
            <button key={a.id} onClick={() => add(a.id)} disabled={adding === a.id} className="w-full text-left px-2 py-2 rounded hover:bg-accent/40 flex items-center justify-between gap-2 disabled:opacity-50">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold truncate">{a.label}</div>
                {a.description && <div className="text-[10px] text-muted-foreground truncate">{a.description}</div>}
              </div>
              <div className="text-xs font-mono text-[#e8312a] flex-shrink-0">
                {a.is_poa || a.price_value == null ? "POA" : `${a.price_currency} ${Number(a.price_value).toLocaleString()}`}
              </div>
            </button>
          ))}
          {(!data?.addons || data.addons.length === 0) && <p className="text-xs text-muted-foreground p-3">No bolt-ons available for this region.</p>}
        </div>
      )}
    </div>
  );
}

// Additional recipients editor. Primary contact is captured separately above.
// Each entry is { name, email }. Empty rows are filtered at save-time.
function RecipientList({ value, onChange }: { value: Array<{ name?: string; email: string }>; onChange: (next: Array<{ name?: string; email: string }>) => void }) {
  const safe = Array.isArray(value) ? value : [];
  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs uppercase tracking-wide text-muted-foreground font-medium">Additional recipients</label>
        <button
          type="button"
          onClick={() => onChange([...safe, { name: "", email: "" }])}
          className="text-xs px-2 py-1 rounded-md border border-border bg-card hover:bg-accent"
        >
          + Add recipient
        </button>
      </div>
      <div className="text-[11px] text-muted-foreground mb-2">Each recipient gets their own copy of the proposal email with their unique opening tracked separately.</div>
      {safe.length === 0 && (
        <div className="text-xs text-muted-foreground italic py-2">No additional recipients. Only the primary contact will receive this proposal.</div>
      )}
      {safe.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2 mb-2">
          <input
            className="input"
            placeholder="Name (optional)"
            value={r.name || ""}
            onChange={(e) => { const next = [...safe]; next[i] = { ...next[i], name: e.target.value }; onChange(next); }}
          />
          <input
            type="email"
            className="input"
            placeholder="email@example.com"
            value={r.email || ""}
            onChange={(e) => { const next = [...safe]; next[i] = { ...next[i], email: e.target.value }; onChange(next); }}
          />
          <button
            type="button"
            onClick={() => onChange(safe.filter((_, idx) => idx !== i))}
            className="px-2 py-1 rounded-md border border-border bg-card hover:bg-destructive/10 hover:text-destructive text-xs"
            title="Remove"
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}

function LogoUploader({ value, onChange, label = "Logo (optional)" }: { value: string; onChange: (url: string) => void; label?: string }) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    setError(null);
    if (!/^image\//.test(file.type)) { setError("Image files only (PNG, JPG, SVG, WebP)."); return; }
    if (file.size > 5 * 1024 * 1024) { setError("Logo must be under 5 MB."); return; }
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await fetch("/api/pitch/upload-logo", { method: "POST", body: fd, credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || `Upload failed (${r.status})`);
      onChange(j.url);
    } catch (e: any) {
      setError(e.message || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      <div className="flex items-center gap-3">
        <div className="flex h-14 w-14 items-center justify-center rounded-md border border-border bg-[#131316] overflow-hidden flex-shrink-0">
          {value ? (
            <img src={value} alt="logo" className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-[10px] text-muted-foreground">No logo</span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="px-3 py-1.5 text-xs font-semibold rounded-md border border-border bg-[#131316] hover:border-[#e8312a] disabled:opacity-60 disabled:cursor-wait"
            >
              {uploading ? "Uploading…" : value ? "Replace" : "Upload image"}
            </button>
            {value && (
              <button
                type="button"
                onClick={() => onChange("")}
                className="px-3 py-1.5 text-xs font-semibold rounded-md border border-border hover:border-[#e8312a]"
              >
                Remove
              </button>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
              hidden
              onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
            />
          </div>
          <input
            type="text"
            className="input mt-1.5 text-xs"
            placeholder="…or paste an image URL"
            value={value}
            onChange={e => onChange(e.target.value)}
          />
          {error && <p className="text-xs text-[#e8312a] mt-1">{error}</p>}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return (
    <div>
      <label className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      {children}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor (Phase 1 minimal — preview link generation, line items table, save)
// ─────────────────────────────────────────────────────────────────────────────

function PitchEditor({ id, onBack, openViewsOnMount }: { id: number; onBack: () => void; openViewsOnMount?: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, refetch } = useQuery<{ proposal: Proposal; line_items: LineItem[] }>({
    queryKey: ["/api/pitch", id],
    queryFn: () => apiRequest("GET", `/api/pitch/${id}`).then(r => r.json()),
  });

  const [items, setItems] = useState<LineItem[] | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  // sendState drives the Send + Copy Link button's UI — idle / sending
  // (spinner + disabled) / sent (green tick for 2 seconds) / error (red flash).
  // Declared up here above the early-return so React sees the same hook order
  // on every render (otherwise React error #310 "Rendered more hooks than
  // during the previous render" fires after the data loads).
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  // Save button feedback — same pattern as sendState. Idle / saving (spinner)
  // / saved (green tick for 2s) / error (red flash). Declared above the
  // early-return so React sees the same hook order on every render.
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  // SENT-FREEZE unlock: when a proposal is sent the server rejects PATCH unless
  // we send force=true. The user must explicitly click Unlock to opt-in.
  const [unlocked, setUnlocked] = useState(false);
  // View-activity panel for sent proposals (IP + country log).
  const [showViews, setShowViews] = useState(false);
  const [views, setViews] = useState<Array<{ id: number; viewed_at: string; ip: string; user_agent: string; is_bot: boolean; bot_reason: string | null; recipient_email: string | null; country: string | null; country_code: string | null }> | null>(null);
  const [viewsLoading, setViewsLoading] = useState(false);

  useEffect(() => {
    if (data && !items) setItems(data.line_items);
    if (data && !proposal) setProposal(data.proposal);
  }, [data]);

  // If the editor was opened from the Opened pill on the list, auto-expand
  // the view-activity panel and trigger its fetch.
  useEffect(() => {
    if (!openViewsOnMount || !proposal) return;
    if (proposal.status !== "sent" || !proposal.view_count) return;
    if (showViews || views !== null) return;
    setShowViews(true);
    (async () => {
      setViewsLoading(true);
      try {
        const r = await apiRequest("GET", `/api/pitch/${proposal.id}/views`);
        const j = await r.json();
        setViews(j.views || []);
      } catch (e) { console.warn("[pitch] views fetch failed", e); }
      finally { setViewsLoading(false); }
    })();
  }, [openViewsOnMount, proposal]);

  if (isLoading || !data || !items || !proposal) {
    return (
      <div className="p-8">
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground mb-4">← Back to list</button>
        <div>Loading…</div>
      </div>
    );
  }

  // Complimentary lines have unit_price_usd forced to 0 server-side, so the
  // subtotal naturally skips them. (We keep the helper explicit for clarity.)
  const monthlyTotalUsd = items.filter(i => i.included).reduce((s, i) => s + ((i.is_complimentary ? 0 : i.unit_price_usd) * i.qty), 0);
  const discount = proposal.override_discount_pct || 0;
  const monthlyAfterDiscount = monthlyTotalUsd * (1 - discount / 100);
  const fx = proposal.fx_rate_to_usd || 1;

  const saveAll = async () => {
    if (saveState === "saving") return;
    setSaveState("saving");
    try {
      const isSent = proposal.status === "sent";
      const r = await apiRequest("PATCH", `/api/pitch/${id}`, {
        client_name: proposal.client_name,
        client_logo_url: proposal.client_logo_url,
        client_contact_name: proposal.client_contact_name,
        client_contact_email: proposal.client_contact_email,
        client_region: proposal.client_region,
        currency: proposal.currency,
        fx_rate_to_usd: proposal.fx_rate_to_usd,
        contract_months: proposal.contract_months,
        proposed_start_date: proposal.proposed_start_date || null,
        override_discount_pct: proposal.override_discount_pct,
        discount_label_override: (proposal.discount_label_override ?? "").toString().trim() || null,
        intro_text: proposal.intro_text,
        competitors: proposal.competitors,
        brands: proposal.brands,
        notify_emails: proposal.notify_emails,
        additional_recipients: ((proposal as any).additional_recipients || []).filter((r: any) => r?.email && r.email.trim()),
        regions: proposal.regions,
        line_items: items,
        // Only sent + explicitly-unlocked saves carry force=true. Drafts stay
        // unaffected; server-side guard is the source of truth.
        force: isSent && unlocked ? true : undefined,
      });
      if (r.status === 409) {
        const j = await r.json().catch(() => ({}));
        setSaveState("error");
        toast({
          title: "Proposal is sent and frozen",
          description: j?.message || "Click Unlock to edit a sent proposal.",
          variant: "destructive",
        });
        setTimeout(() => setSaveState("idle"), 2500);
        return;
      }
      if (!r.ok) throw new Error(`Save failed (${r.status})`);
      toast({ title: "Saved" });
      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
      refetch();
    } catch (e: any) {
      setSaveState("error");
      toast({ title: "Save failed", description: e?.message || "Try again", variant: "destructive" });
      setTimeout(() => setSaveState("idle"), 2500);
    }
  };

  const sendProposal = async () => {
    if (sendState === "sending") return;
    setSendState("sending");
    try {
      await saveAll();
      const r = await apiRequest("POST", `/api/pitch/${id}/send`);
      const j = await r.json();
      await navigator.clipboard.writeText(j.link).catch(() => {});
      // Show different toasts depending on whether the prospect email actually
      // delivered. The server returns email_status with sent + error fields.
      if (j.email_status?.sent) {
        const results: Array<{ sent: boolean; to?: string; error?: string | null }> = j.email_status.results || [];
        const okList = results.filter(x => x.sent).map(x => x.to).filter(Boolean);
        const failList = results.filter(x => !x.sent);
        const total = j.email_status.total ?? okList.length;
        const delivered = j.email_status.delivered ?? okList.length;
        const titleSummary =
          okList.length === 1 ? `Sent to ${okList[0]} — link copied` :
          okList.length > 1 ? `Sent to ${delivered}/${total} recipients — link copied` :
          "Sent — link copied";
        const description = [
          okList.length > 1 ? `Delivered: ${okList.join(", ")}` : null,
          failList.length ? `Failed: ${failList.map(x => `${x.to || "?"} (${x.error || "unknown"})`).join(", ")}` : null,
          j.link,
        ].filter(Boolean).join("\n");
        toast({ title: titleSummary, description });
      } else {
        const firstErr = (j.email_status?.results || [])[0]?.error || j.email_status?.error || "No recipients on proposal";
        toast({
          title: "Link copied — email NOT sent",
          description: firstErr,
          variant: "destructive",
        });
      }
      setSendState("sent");
      setTimeout(() => setSendState("idle"), 2200);
      refetch();
    } catch (e: any) {
      setSendState("error");
      toast({ title: "Send failed", description: e?.message || "Try again", variant: "destructive" });
      setTimeout(() => setSendState("idle"), 2500);
    }
  };

  const revoke = async () => {
    if (!confirm("Revoke this proposal? The link will stop working.")) return;
    await apiRequest("POST", `/api/pitch/${id}/revoke`);
    toast({ title: "Revoked" });
    refetch();
  };

  const addLine = (category: "core" | "bolt-on" | "discount") => {
    setItems([...items!, {
      category,
      label: category === "bolt-on" ? "New bolt-on" : "New line item",
      qty: 1,
      unit: "per month",
      unit_price_usd: 0,
      included: 1,
    }]);
  };

  const removeLine = (idx: number) => setItems(items!.filter((_, i) => i !== idx));
  const updateLine = (idx: number, patch: Partial<LineItem>) =>
    setItems(items!.map((it, i) => i === idx ? { ...it, ...patch } : it));

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-muted-foreground hover:text-foreground">← Back to list</button>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${statusBadge(proposal.status)}`}>{proposal.status}</span>
          {proposal.status === "sent" && (
            <button
              onClick={() => {
                if (!unlocked) {
                  if (window.confirm("This proposal has been sent to the prospect. Editing it now will overwrite the quote they were given.\n\nUnlock for manual edits?")) {
                    setUnlocked(true);
                  }
                } else {
                  setUnlocked(false);
                }
              }}
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-semibold border ${
                unlocked
                  ? "bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border-amber-500/30"
                  : "bg-zinc-800/60 hover:bg-zinc-800 text-zinc-300 border-zinc-700"
              }`}
              title={unlocked ? "Sent proposal unlocked for editing. Click to re-lock." : "Sent proposal is frozen. Click to unlock for manual edits."}
            >
              {unlocked ? "Unlocked · editing sent" : "Frozen · Unlock to edit"}
            </button>
          )}
          {proposal.status === "sent" && (
            proposal.view_count && proposal.view_count > 0 ? (
              <button
                onClick={async () => {
                  const next = !showViews;
                  setShowViews(next);
                  if (next && !views) {
                    setViewsLoading(true);
                    try {
                      const r = await apiRequest("GET", `/api/pitch/${proposal.id}/views`);
                      const j = await r.json();
                      setViews(j.views || []);
                    } catch (e) {
                      console.warn("[pitch] views fetch failed", e);
                    } finally {
                      setViewsLoading(false);
                    }
                  }
                }}
                className="text-[10px] uppercase tracking-wide px-2 py-1 rounded bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-400 border border-emerald-500/30 font-semibold"
                title="Click to see who opened this proposal (IP + country)"
              >
                Opened · {proposal.view_count}× →
              </button>
            ) : (
              <span className="text-[10px] uppercase tracking-wide px-2 py-1 rounded bg-zinc-700/50 text-zinc-400 border border-zinc-600">
                Not opened yet
              </span>
            )
          )}
          <button
            onClick={() => {
              // Prefer the unified Media Kit link if available; fall back to /pitch/.
              const kitSlug = (proposal as any).media_kit_share_slug;
              const kitToken = (proposal as any).media_kit_share_token;
              if (kitSlug && kitToken) {
                window.open(`/kit/${kitSlug}?t=${encodeURIComponent(kitToken)}`, "_blank");
              } else if (proposal.slug && proposal.magic_token) {
                window.open(`/pitch/${proposal.slug}?t=${encodeURIComponent(proposal.magic_token)}`, "_blank");
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-transparent hover:border-[#e8312a] text-xs font-semibold"
          >
            <Eye className="w-3.5 h-3.5" /> Preview
          </button>
          <button
            onClick={saveAll}
            disabled={saveState === "saving"}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-white text-xs font-semibold transition-all active:scale-[0.97] disabled:cursor-wait ${
              saveState === "saved" ? "bg-green-600 hover:bg-green-600" :
              saveState === "error" ? "bg-red-700" :
              "bg-zinc-700 hover:bg-zinc-600"
            }`}
          >
            {saveState === "saving" && (
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            )}
            {saveState === "saved" && <span aria-hidden="true" className="text-base leading-none">✓</span>}
            {saveState === "error" && <span aria-hidden="true" className="text-base leading-none">!</span>}
            {saveState === "idle"  && <Save className="w-3.5 h-3.5" />}
            {saveState === "saving" ? "Saving…" :
             saveState === "saved"  ? "Saved" :
             saveState === "error"  ? "Save failed" :
             "Save"}
          </button>
          <button
            onClick={sendProposal}
            disabled={sendState === "sending"}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-white text-xs font-semibold transition-all active:scale-[0.97] disabled:cursor-wait ${
              sendState === "sent"  ? "bg-green-600 hover:bg-green-600" :
              sendState === "error" ? "bg-red-700" :
              "bg-[#e8312a] hover:bg-[#e8312a]/90"
            }`}
          >
            {sendState === "sending" && (
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            )}
            {sendState === "sent"    && <span aria-hidden="true" className="text-base leading-none">✓</span>}
            {sendState === "error"   && <span aria-hidden="true" className="text-base leading-none">!</span>}
            {sendState === "idle"    && <Send className="w-3.5 h-3.5" />}
            {sendState === "sending" ? "Sending…" :
             sendState === "sent"    ? "Sent — link copied" :
             sendState === "error"   ? "Send failed" :
             (proposal.status === "draft" ? "Send + Copy Link" : "Regenerate Link")}
          </button>
          {proposal.status !== "revoked" && proposal.status !== "draft" && (
            <button onClick={revoke} className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 text-xs font-semibold border border-amber-500/30">
              <RotateCcw className="w-3.5 h-3.5" /> Revoke
            </button>
          )}
          <button
            onClick={async () => {
              try {
                const r = await apiRequest("POST", `/api/pitch/${id}/renew-expiry`);
                if (!r.ok) {
                  const j = await r.json().catch(() => ({} as any));
                  throw new Error(j.message || `Renew failed (${r.status})`);
                }
                const j = await r.json();
                qc.invalidateQueries({ queryKey: ["/api/pitch"] });
                qc.invalidateQueries({ queryKey: [`/api/pitch/${id}`] });
                toast({ title: "Expiry renewed", description: `New expiry: ${new Date(j.expires_at).toLocaleDateString()}` });
                refetch();
              } catch (e: any) {
                toast({ title: "Renew failed", description: e?.message || "Unknown error", variant: "destructive" });
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border bg-transparent hover:border-[#e8312a] text-xs font-semibold"
            title="Push the expiry forward by the default validity window"
          >
            <Calendar className="w-3.5 h-3.5" /> Renew expiry
          </button>
          <button
            onClick={async () => {
              if (!confirm(`Permanently delete proposal for "${proposal.client_name}"? This cannot be undone.`)) return;
              try {
                const r = await apiRequest("DELETE", `/api/pitch/${id}`);
                if (!r.ok) {
                  const j = await r.json().catch(() => ({} as any));
                  throw new Error(j.message || `Delete failed (${r.status})`);
                }
                // Drop the list cache so the parent refetches and the row vanishes.
                qc.removeQueries({ queryKey: ["/api/pitch"] });
                qc.invalidateQueries({ queryKey: ["/api/pitch"] });
                toast({ title: "Proposal deleted" });
                onBack();
              } catch (e: any) {
                toast({ title: "Delete failed", description: e?.message || "Unknown error", variant: "destructive" });
              }
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-500/15 hover:bg-red-500/25 text-red-400 text-xs font-semibold border border-red-500/30"
            title="Permanently delete this proposal"
          >
            <Trash2 className="w-3.5 h-3.5" /> Delete
          </button>
        </div>
      </div>

      {/* View activity panel — shown when the Opened pill is clicked */}
      {showViews && proposal.status === "sent" && (
        <div className="px-6 py-4 border-b border-border bg-zinc-900/40">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs uppercase tracking-wide font-semibold text-zinc-300">View activity</div>
            <button onClick={() => setShowViews(false)} className="text-xs text-muted-foreground hover:text-foreground">Close</button>
          </div>
          {viewsLoading && <div className="text-xs text-muted-foreground">Loading…</div>}
          {!viewsLoading && views && views.length > 0 && (() => {
            const real = views.filter(v => !v.is_bot).length;
            const bots = views.length - real;
            return (
              <div className="text-xs text-muted-foreground mb-2">
                {real} real open{real !== 1 ? "s" : ""}{bots > 0 ? ` · ${bots} bot/scanner row${bots !== 1 ? "s" : ""} (faded)` : ""}
              </div>
            );
          })()}
          {!viewsLoading && views && views.length === 0 && <div className="text-xs text-muted-foreground">No non-owner views recorded yet.</div>}
          {!viewsLoading && views && views.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground border-b border-border">
                    <th className="py-1.5 pr-4 font-medium">When (AEST)</th>
                    <th className="py-1.5 pr-4 font-medium">Recipient</th>
                    <th className="py-1.5 pr-4 font-medium">IP</th>
                    <th className="py-1.5 pr-4 font-medium">Country</th>
                    <th className="py-1.5 pr-4 font-medium">Source</th>
                  </tr>
                </thead>
                <tbody>
                  {views.map((v) => {
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
                        <td className="py-1.5 pr-4 font-mono text-zinc-300">{fmtDate(v.viewed_at)}</td>
                        <td className="py-1.5 pr-4 text-zinc-200">
                          {v.recipient_email ? (
                            <span className="font-mono">{v.recipient_email}</span>
                          ) : (
                            <span className="text-zinc-500 italic">unknown</span>
                          )}
                        </td>
                        <td className="py-1.5 pr-4 font-mono text-zinc-300">{v.ip || "—"}</td>
                        <td className="py-1.5 pr-4 text-zinc-200">
                          {v.country ? (
                            <span>
                              {v.country_code && (
                                <span className="inline-block mr-1.5 text-[10px] px-1 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono">{v.country_code}</span>
                              )}
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
          )}
        </div>
      )}

      <div className="px-6 py-5 space-y-5 max-w-5xl">
        <div className="max-w-md">
          <LogoUploader
            value={proposal.client_logo_url || ""}
            onChange={url => setProposal({ ...proposal, client_logo_url: url })}
            label="Client logo"
          />
        </div>
        <div className="grid grid-cols-2 gap-3 max-w-3xl">
          <Field label="Primary contact name">
            <input
              className="input"
              value={proposal.client_contact_name || ""}
              onChange={e => setProposal({ ...proposal, client_contact_name: e.target.value })}
              placeholder="e.g. Nuno Vitorino"
            />
          </Field>
          <Field label="Primary contact email">
            <input
              type="email"
              className="input"
              value={proposal.client_contact_email || ""}
              onChange={e => setProposal({ ...proposal, client_contact_email: e.target.value })}
              placeholder="e.g. nuno@innuos.com"
            />
          </Field>
        </div>
        <RecipientList
          value={(proposal as any).additional_recipients || []}
          onChange={(next) => setProposal({ ...proposal, additional_recipients: next } as any)}
        />
        <div className="grid grid-cols-3 gap-3">
          <Field label="Client name">
            <input className="input" value={proposal.client_name} onChange={e => setProposal({ ...proposal, client_name: e.target.value })} />
          </Field>
          {(proposal as any).proposal_type !== "casual" && (
            <Field label="Tier">
              <TierPicker
                value={proposal.base_tier}
                regions={proposal.regions || []}
                onChange={(newTier) => setProposal({ ...proposal, base_tier: newTier })}
                onReload={async (newTier) => {
                  if (!confirm(`Replace all current line items with the default inclusions for "${newTier}"? Custom edits on this proposal will be lost.`)) return;
                  const r = await apiRequest("POST", `/api/pitch/${id}/reload-tier`, { base_tier: newTier });
                  const j = await r.json();
                  if (j.ok) {
                    setProposal(j.proposal);
                    setItems(j.line_items);
                    toast({ title: `Reloaded ${newTier} defaults` });
                  }
                }}
              />
            </Field>
          )}
          {(proposal as any).proposal_type === "casual" && (
            <Field label="Proposal type">
              <div className="input flex items-center text-sm text-muted-foreground" style={{ pointerEvents: "none" }}>
                Casual / Ad-hoc (one-off)
              </div>
            </Field>
          )}
          <Field label="Proposed start date">
            <input
              type="date"
              className="input"
              value={proposal.proposed_start_date ? proposal.proposed_start_date.slice(0, 10) : ""}
              onChange={e => setProposal({ ...proposal, proposed_start_date: e.target.value })}
            />
          </Field>
          {(proposal as any).proposal_type !== "casual" && (
            <Field label="Contract duration (months)">
              <input type="number" className="input" value={proposal.contract_months} onChange={e => setProposal({ ...proposal, contract_months: Number(e.target.value) })} />
            </Field>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Field label="Currency">
            <select className="input" value={proposal.currency} onChange={e => setProposal({ ...proposal, currency: e.target.value })}>
              {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="FX rate (to USD)">
            <input type="number" step="0.0001" className="input" value={proposal.fx_rate_to_usd} onChange={e => setProposal({ ...proposal, fx_rate_to_usd: Number(e.target.value) })} />
          </Field>
          <Field label="Override discount %">
            <input
              type="text"
              inputMode="decimal"
              className="input no-spinner"
              value={proposal.override_discount_pct ?? ""}
              onChange={e => {
                const v = e.target.value.replace(/[^0-9.]/g, "");
                setProposal({ ...proposal, override_discount_pct: v === "" ? 0 : Number(v) });
              }}
              placeholder="0"
            />
          </Field>
        </div>
        <Field label="Discount label (shown next to the discount on the proposal)">
          <input
            className="input"
            value={proposal.discount_label_override ?? ""}
            onChange={e => setProposal({ ...proposal, discount_label_override: e.target.value })}
            placeholder="e.g. Distributor partnership rate — leave blank to use the global default"
          />
          <p className="text-[11px] text-muted-foreground mt-1">Falls back to the PITCH Settings default when empty.</p>
        </Field>

        <Field label="Custom intro paragraph (shown on proposal hero)">
          <textarea className="input min-h-[120px]" value={proposal.intro_text || ""} onChange={e => setProposal({ ...proposal, intro_text: e.target.value })} placeholder="A few personalised sentences that open the proposal…" />
          <p className="text-[11px] text-muted-foreground mt-1">Leave a blank line between paragraphs. Supports <code>**bold**</code>, <code>*italic*</code> and lines starting with <code>-&nbsp;</code> for bullets.</p>
        </Field>

        <Field label="Regions included">
          <div className="flex flex-wrap gap-1.5">
            {REGIONS.map(r => {
              const checked = (proposal.regions || []).includes(r.key);
              return (
                <button
                  key={r.key}
                  onClick={() => setProposal({
                    ...proposal,
                    regions: checked
                      ? (proposal.regions || []).filter(k => k !== r.key)
                      : [...(proposal.regions || []), r.key]
                  })}
                  className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-all ${
                    checked ? "border-[#e8312a] bg-[#e8312a]/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </Field>

        {/* Billing info — submitted by the client on the proposal page, displayed here read-only */}
        {(proposal.billing_company_name || proposal.billing_address || (proposal.accounts_contacts && proposal.accounts_contacts.length > 0)) && (
          <div className="p-4 rounded-lg border border-border bg-muted/20">
            <h3 className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Billing details (client-supplied)</h3>
            {proposal.billing_company_name && <div className="text-sm font-medium">{proposal.billing_company_name}</div>}
            {proposal.billing_address && <div className="text-sm text-muted-foreground whitespace-pre-line">{proposal.billing_address}</div>}
            {proposal.accounts_contacts && proposal.accounts_contacts.length > 0 && (
              <ul className="mt-2 space-y-0.5">
                {proposal.accounts_contacts.map((c, i) => (
                  <li key={i} className="text-sm">{c.name} — <span className="text-muted-foreground">{c.email}</span></li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold text-sm">Line items</h3>
            <div className="flex gap-2">
              <BoltonPicker proposalId={id} region={proposal.client_region || (proposal.regions && proposal.regions[0]) || null} onAdded={() => refetch()} />
              <button onClick={() => addLine("core")} className="text-xs px-2 py-1 rounded border border-border hover:bg-accent">+ Core</button>
              <button onClick={() => addLine("bolt-on")} className="text-xs px-2 py-1 rounded border border-border hover:bg-accent">+ Custom Bolt-on</button>
              <button onClick={() => addLine("discount")} className="text-xs px-2 py-1 rounded border border-border hover:bg-accent">+ Discount</button>
            </div>
          </div>
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="text-left p-2 font-semibold">Cat</th>
                  <th className="text-left p-2 font-semibold">Label</th>
                  <th className="text-right p-2 font-semibold w-16">Qty</th>
                  <th className="text-left p-2 font-semibold w-28">Unit</th>
                  <th className="text-right p-2 font-semibold w-28">Unit USD</th>
                  <th className="text-right p-2 font-semibold w-28">Total USD</th>
                  <th className="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i} className={`border-t border-border ${!it.included ? "opacity-40" : ""}`}>
                    <td className="p-2">
                      <select value={it.category} onChange={e => updateLine(i, { category: e.target.value as any })} className="cell-input text-[10px] uppercase tracking-wide">
                        <option value="core">core</option>
                        <option value="bolt-on">bolt-on</option>
                        <option value="discount">discount</option>
                      </select>
                    </td>
                    <td className="p-2">
                      <input className="cell-input w-full font-medium" value={it.label} onChange={e => updateLine(i, { label: e.target.value })} />
                      {(it.description !== undefined && it.description !== null) && (
                        <input className="cell-input w-full text-[11px] mt-1 opacity-80" value={it.description || ""} onChange={e => updateLine(i, { description: e.target.value })} placeholder="Description (optional)" />
                      )}
                    </td>
                    <td className="p-2 text-right">
                      <input type="number" step="0.5" className="cell-input w-16 text-right" value={it.qty} onChange={e => updateLine(i, { qty: Number(e.target.value) })} />
                    </td>
                    <td className="p-2">
                      <input className="cell-input w-full" value={it.unit || ""} onChange={e => updateLine(i, { unit: e.target.value })} />
                    </td>
                    <td className="p-2 text-right">
                      <input
                        type="number"
                        className="cell-input w-24 text-right"
                        value={it.is_complimentary ? (it.original_unit_price_usd ?? 0) : it.unit_price_usd}
                        onChange={e => {
                          const v = Number(e.target.value);
                          if (it.is_complimentary) {
                            updateLine(i, { original_unit_price_usd: v });
                          } else {
                            updateLine(i, { unit_price_usd: v });
                          }
                        }}
                      />
                      <label className="flex items-center justify-end gap-1 text-[10px] text-muted-foreground mt-1 cursor-pointer" title="Mark as complimentary — prospect sees the original price struck through next to a COMPLIMENTARY badge.">
                        <input
                          type="checkbox"
                          className="accent-green-500"
                          checked={!!it.is_complimentary}
                          onChange={e => {
                            if (e.target.checked) {
                              // Flip on: remember original price, zero effective price.
                              updateLine(i, { is_complimentary: true, original_unit_price_usd: it.unit_price_usd, unit_price_usd: 0 });
                            } else {
                              // Flip off: restore original price as the new effective.
                              const restored = it.original_unit_price_usd ?? 0;
                              updateLine(i, { is_complimentary: false, original_unit_price_usd: null, unit_price_usd: restored });
                            }
                          }}
                        />
                        Complimentary
                      </label>
                    </td>
                    <td className="p-2 text-right font-mono">
                      {it.is_complimentary ? (
                        <span className="inline-flex flex-col items-end gap-0.5">
                          {(it.original_unit_price_usd ?? 0) > 0 && <span className="line-through opacity-60 text-[11px]">{fmtMoney((it.original_unit_price_usd ?? 0) * it.qty, proposal.currency, fx)}</span>}
                          <span className="text-green-500 font-bold text-[10px] uppercase tracking-wide">Complimentary</span>
                        </span>
                      ) : (
                        fmtMoney(it.unit_price_usd * it.qty, proposal.currency, fx)
                      )}
                    </td>
                    <td className="p-2 text-right">
                      <button onClick={() => removeLine(i)} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-border bg-muted/30">
                  <td colSpan={5} className="p-2 text-right font-semibold">Monthly subtotal</td>
                  <td className="p-2 text-right font-mono">{fmtMoney(monthlyTotalUsd, proposal.currency, fx)}</td>
                  <td></td>
                </tr>
                {discount > 0 && (
                  <tr className="bg-muted/20">
                    <td colSpan={5} className="p-2 text-right text-muted-foreground">After {discount}% discount</td>
                    <td className="p-2 text-right font-mono text-[#e8312a]">{fmtMoney(monthlyAfterDiscount, proposal.currency, fx)}</td>
                    <td></td>
                  </tr>
                )}
              </tfoot>
            </table>
          </div>
        </div>

        <style>{`
          .input { width: 100%; padding: 8px 10px; border-radius: 6px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); color: hsl(var(--foreground)); font-size: 13px; }
          .input::placeholder { color: rgba(255,255,255,0.35); }
          .input:focus { outline: 2px solid rgba(232,49,42,0.4); border-color: #e8312a; }
          .input:disabled { opacity: 0.6; }
          .cell-input { background: rgba(255,255,255,0.02); border: 1px solid transparent; color: hsl(var(--foreground)); padding: 4px 6px; border-radius: 4px; font-size: 12px; transition: border-color 0.1s, background 0.1s; }
          .cell-input:hover { background: rgba(255,255,255,0.05); }
          .cell-input:focus { outline: none; border-color: #e8312a; background: rgba(255,255,255,0.08); }
          .cell-input::placeholder { color: rgba(255,255,255,0.3); }
          select.input { appearance: none; -webkit-appearance: none; background-image: url("data:image/svg+xml;charset=US-ASCII,%3Csvg width='12' height='8' viewBox='0 0 12 8' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23ffffff80' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px; }
          select.input option, .input option, .cell-input option { background: #1a1a1d; color: #f3f3f4; padding: 6px 10px; }
          select.input option:checked, .input option:checked, .cell-input option:checked { background: #e8312a; color: white; }
        `}</style>

        {proposal.status !== "draft" && (
          <div className="p-3 rounded-md border border-border bg-muted/30 text-xs space-y-1">
            <div className="flex items-center gap-2">
              <LinkIcon className="w-3.5 h-3.5" />
              <span className="text-muted-foreground">Public proposal lives at:</span>
              <code className="px-1.5 py-0.5 rounded bg-background border border-border">{(proposal as any).media_kit_share_slug ? `/kit/${(proposal as any).media_kit_share_slug}` : `/pitch/${proposal.slug}`}</code>
            </div>
            <div className="text-muted-foreground">
              Expires: {fmtDate(proposal.expires_at)} · View count: {proposal.view_count}
              {proposal.decision && ` · Decision: ${proposal.decision} by ${proposal.decision_name || "—"} on ${fmtDate(proposal.decided_at)}`}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings modal — global terms text + audience defaults
// ─────────────────────────────────────────────────────────────────────────────

function TierPicker({ value, regions, onChange, onReload }: { value: string; regions?: string[]; onChange: (v: string) => void; onReload: (v: string) => void }) {
  // Mirror server's pickTierRegion: only narrow when exactly one regional flag is set.
  const region = (() => {
    if (!Array.isArray(regions) || regions.length === 0 || regions.length === 4) return "global";
    if (regions.length === 1 && ["na", "uk_eu", "asia", "anz"].includes(regions[0])) return regions[0];
    return "global";
  })();
  const { data } = useQuery<{ tiers: { key?: string; tier_key?: string; label: string; monthly_usd: number }[]; currency?: string }>({
    queryKey: ["/api/pitch/meta", region],
    queryFn: () => apiRequest("GET", `/api/pitch/meta?region=${encodeURIComponent(region)}`).then(r => r.json()),
  });
  const currency = data?.currency || (region === "anz" ? "AUD" : region === "uk_eu" ? "GBP" : region === "asia" ? "SGD" : "USD");
  const tiers = data?.tiers || [];
  return (
    <div className="flex gap-1.5">
      <select className="input flex-1" value={value} onChange={e => onChange(e.target.value)}>
        {tiers.length === 0 && <option value={value}>{value}</option>}
        {tiers.map(t => {
          const k = (t as any).key || (t as any).tier_key;
          return <option key={k} value={k}>{t.label}{t.monthly_usd ? ` — ${currency} $${t.monthly_usd.toLocaleString()}/mo` : ""}</option>;
        })}
      </select>
      <button
        onClick={() => onReload(value)}
        title="Replace line items with this tier's default inclusions"
        className="shrink-0 px-3 rounded-md border border-border text-xs hover:bg-accent"
      >Reload</button>
    </div>
  );
}

function PitchSettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<"general" | "tiers" | "emails">("general");
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-xl w-full max-w-5xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between">
          <h2 className="text-lg font-semibold">PITCH Settings</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-5 h-5" /></button>
        </div>
        <div className="px-6 pt-3 border-b border-border flex gap-1">
          {(["general","tiers","emails"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab===t?"border-[#e8312a] text-foreground":"border-transparent text-muted-foreground hover:text-foreground"}`}>
              {t === "general" ? "General" : t === "tiers" ? "Tier Templates" : "Email Templates"}
            </button>
          ))}
        </div>
        {tab === "general" ? <SettingsGeneralTab onClose={onClose} /> : tab === "tiers" ? <SettingsTiersTab /> : <SettingsEmailsTab />}
      </div>
      <style>{`
        .input { width: 100%; padding: 8px 10px; border-radius: 6px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.12); color: hsl(var(--foreground)); font-size: 13px; }
        .input::placeholder { color: rgba(255,255,255,0.35); }
        .input:focus { outline: 2px solid rgba(232,49,42,0.4); border-color: #e8312a; }
        .cell-input { background: rgba(255,255,255,0.02); border: 1px solid transparent; color: hsl(var(--foreground)); padding: 4px 6px; border-radius: 4px; font-size: 12px; }
        .cell-input:hover { background: rgba(255,255,255,0.05); }
        .cell-input:focus { outline: none; border-color: #e8312a; background: rgba(255,255,255,0.08); }
      `}</style>
    </div>
  );
}

function SettingsGeneralTab({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery<{ terms_text: string; audience_monthly_uniques: string; audience_label: string; why_text: string; discount_label_text: string; default_expiry_days: number }>({
    queryKey: ["/api/pitch/settings"],
    // Always refetch on mount so the textarea reflects the freshest server value
    // (overrides the app-wide staleTime: Infinity for this critical edit surface).
    staleTime: 0,
    refetchOnMount: "always",
    queryFn: async () => {
      const r = await apiRequest("GET", "/api/pitch/settings");
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`Settings load failed (${r.status})${body ? ": " + body.slice(0, 200) : ""}`);
      }
      return r.json();
    },
  });
  const [terms, setTerms] = useState<string>("");
  const [audience, setAudience] = useState<string>("");
  const [label, setLabel] = useState<string>("");
  const [why, setWhy] = useState<string>("");
  const [discountLabel, setDiscountLabel] = useState<string>("");
  const [expiryDays, setExpiryDays] = useState<number>(30);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (data) {
      setTerms(data.terms_text || "");
      setAudience(data.audience_monthly_uniques || "");
      setLabel(data.audience_label || "unique visitors / month");
      setWhy(data.why_text || "");
      setDiscountLabel(data.discount_label_text || "Partnership discount applied");
      setExpiryDays(data.default_expiry_days || 30);
    }
  }, [data]);
  const save = async () => {
    if (saving) return;
    // Safety net: refuse to save empty terms unless the load completed and the
    // user explicitly cleared them. If `data` never loaded (auth/network error),
    // we'd otherwise overwrite stored T&Cs with an empty string.
    if (!data) {
      toast({ title: "Can't save — settings haven't loaded", description: "Refresh the page and try again.", variant: "destructive" });
      return;
    }
    if (terms.length === 0 && (data.terms_text || "").length > 0) {
      const ok = confirm(`This will clear ${data.terms_text.length.toLocaleString()} characters of saved Terms & Conditions. Continue?`);
      if (!ok) return;
    }
    setSaving(true);
    try {
      const r = await apiRequest("POST", "/api/pitch/settings", {
        terms_text: terms,
        audience_monthly_uniques: audience,
        audience_label: label,
        why_text: why,
        discount_label_text: discountLabel,
        default_expiry_days: expiryDays,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({} as any));
        throw new Error(j.message || `Save failed (${r.status})`);
      }
      await qc.invalidateQueries({ queryKey: ["/api/pitch/settings"] });
      toast({ title: "Settings saved", description: `Terms: ${terms.length.toLocaleString()} characters stored.` });
      onClose();
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message || "Unknown error", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
        {error ? (
          <div className="rounded-md border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <div className="font-semibold mb-1">Couldn't load saved settings.</div>
            <div className="text-xs opacity-80">{(error as Error).message}</div>
            <button onClick={() => refetch()} className="mt-2 px-3 py-1 text-xs rounded bg-red-500/20 hover:bg-red-500/30">Retry</button>
            <p className="mt-2 text-xs opacity-80">
              <strong>Don't save</strong> while this error is showing or you may overwrite your terms with empty text.
              Try refreshing the page or logging back in.
            </p>
          </div>
        ) : isLoading ? <div>Loading…</div> : (
          <>
            <Field label="Default proposal validity (days)">
              <input
                type="number"
                min={1}
                max={365}
                className="input max-w-[180px]"
                value={expiryDays}
                onChange={e => setExpiryDays(Math.max(1, Math.min(365, Number(e.target.value) || 30)))}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                New proposals expire this many days after creation. Existing proposals are not affected.
              </p>
            </Field>
            <Field label='"Why StereoNET" intro paragraph (shown at the top of every proposal)'>
              <textarea
                className="input min-h-[140px] text-[13px]"
                value={why}
                onChange={e => setWhy(e.target.value)}
                placeholder="e.g. Established in 2003, StereoNET is the No.1 hi-fi publication…"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Plain text or light markdown: blank lines separate paragraphs, <code>**bold**</code>, <code>*italic*</code>, <code>- bullet</code>.
              </p>
            </Field>
            <Field label="Discount label (shown next to the discount % on every proposal)">
              <input
                className="input"
                value={discountLabel}
                onChange={e => setDiscountLabel(e.target.value)}
                placeholder="Partnership discount applied"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Examples: “Partnership discount applied”, “Founding partner rate”, “Introductory offer”.
              </p>
            </Field>
            <Field label="Terms & Conditions (shown above the signature field on every proposal)">
              <textarea
                className="input min-h-[260px] font-mono text-[12px]"
                value={terms}
                onChange={e => setTerms(e.target.value)}
                placeholder={"Use blank lines to separate paragraphs."}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Fallback audience value (used if GA4 fails)">
                <input className="input" value={audience} onChange={e => setAudience(e.target.value)} placeholder="e.g. 1.8M" />
              </Field>
              <Field label="Fallback audience label">
                <input className="input" value={label} onChange={e => setLabel(e.target.value)} placeholder="unique visitors / month" />
              </Field>
            </div>
          </>
        )}
      </div>
      <div className="px-6 py-4 border-t border-border flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">{terms.length.toLocaleString()} characters · stored in <code>pitch_terms_text</code></span>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground" disabled={saving}>Cancel</button>
          <button onClick={save} disabled={saving} className="px-5 py-2 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 disabled:bg-[#e8312a]/60 disabled:cursor-wait text-white text-sm font-semibold inline-flex items-center gap-2 active:scale-[0.97] transition-all">
            {saving && (
              <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
                <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
              </svg>
            )}
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </>
  );
}

type TierTpl = { tier_key: string; label: string; sort_order: number; monthly_usd: number; description: string | null; active: number };
type TierItem = { id?: number; sort_order?: number; category: "core" | "bolt-on" | "discount"; label: string; description?: string | null; qty: number; unit?: string | null; unit_price_usd: number; included: number | boolean };

function SettingsTiersTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading, refetch } = useQuery<{ tiers: TierTpl[]; items: Record<string, TierItem[]> }>({
    queryKey: ["/api/pitch/tiers"],
    queryFn: () => apiRequest("GET", "/api/pitch/tiers").then(r => r.json()),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [tier, setTier] = useState<TierTpl | null>(null);
  const [items, setItems] = useState<TierItem[]>([]);

  useEffect(() => {
    if (data && data.tiers.length > 0 && selected === null) setSelected(data.tiers[0].tier_key);
  }, [data]);

  useEffect(() => {
    if (data && selected) {
      const t = data.tiers.find(x => x.tier_key === selected) || null;
      setTier(t ? { ...t } : null);
      setItems(data.items[selected] ? [...data.items[selected]] : []);
    }
  }, [data, selected]);

  const save = async () => {
    if (!tier) return;
    await apiRequest("POST", `/api/pitch/tiers/${tier.tier_key}`, { ...tier, items });
    toast({ title: `${tier.label} saved` });
    qc.invalidateQueries({ queryKey: ["/api/pitch/tiers"] });
    qc.invalidateQueries({ queryKey: ["/api/pitch/meta"] });
  };

  const newTier = async () => {
    const key = prompt("New tier key (lowercase, no spaces, e.g. 'enterprise'):");
    if (!key) return;
    const label = prompt("Display label:") || key;
    await apiRequest("POST", `/api/pitch/tiers/${key}`, { label, sort_order: 99, monthly_usd: 0, active: 1, items: [] });
    toast({ title: "Tier created" });
    qc.invalidateQueries({ queryKey: ["/api/pitch/tiers"] });
    setSelected(key);
  };

  const deleteTier = async () => {
    if (!tier) return;
    if (!confirm(`Delete tier "${tier.label}"? Existing proposals using it are not affected.`)) return;
    await apiRequest("DELETE", `/api/pitch/tiers/${tier.tier_key}`);
    qc.invalidateQueries({ queryKey: ["/api/pitch/tiers"] });
    setSelected(null);
    setTier(null);
    setItems([]);
  };

  if (isLoading || !data) return <div className="flex-1 p-6">Loading…</div>;

  return (
    <div className="flex-1 overflow-hidden flex">
      <aside className="w-48 border-r border-border overflow-y-auto py-3">
        {data.tiers.map(t => (
          <button key={t.tier_key} onClick={() => setSelected(t.tier_key)}
            className={`w-full text-left px-4 py-2 text-sm border-l-2 ${selected === t.tier_key ? "border-[#e8312a] bg-[#e8312a]/10" : "border-transparent hover:bg-accent/40"}`}>
            <div className="font-medium">{t.label}</div>
            <div className="text-[10px] text-muted-foreground">${t.monthly_usd ? t.monthly_usd.toLocaleString() : "P.O.A."}/mo</div>
          </button>
        ))}
        <div className="px-3 mt-3">
          <button onClick={newTier} className="w-full text-xs px-2 py-1.5 rounded border border-border hover:bg-accent">+ New tier</button>
        </div>
      </aside>
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {!tier ? <div className="text-muted-foreground text-sm">Select a tier on the left.</div> : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Key">
                <input className="input" value={tier.tier_key} disabled />
              </Field>
              <Field label="Display label">
                <input className="input" value={tier.label} onChange={e => setTier({ ...tier, label: e.target.value })} />
              </Field>
              <Field label="Default monthly (USD, 0 = P.O.A.)">
                <input type="number" className="input" value={tier.monthly_usd} onChange={e => setTier({ ...tier, monthly_usd: Number(e.target.value) })} />
              </Field>
            </div>
            <Field label="Description (optional, internal note)">
              <input className="input" value={tier.description || ""} onChange={e => setTier({ ...tier, description: e.target.value })} />
            </Field>
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="font-semibold text-sm">Default inclusions for {tier.label}</h3>
                <div className="flex gap-2">
                  <button onClick={() => setItems([...items, { category: "core", label: "New line item", qty: 1, unit: "per month", unit_price_usd: 0, included: 1 }])} className="text-xs px-2 py-1 rounded border border-border hover:bg-accent">+ Item</button>
                </div>
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="w-14 p-2"></th>
                      <th className="text-left p-2 w-20">Cat</th>
                      <th className="text-left p-2">Label / Description</th>
                      <th className="text-right p-2 w-16">Qty</th>
                      <th className="text-left p-2 w-28">Unit</th>
                      <th className="text-right p-2 w-24">USD</th>
                      <th className="w-10"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it, i) => {
                      const moveUp = () => { if (i === 0) return; const next = [...items]; [next[i-1], next[i]] = [next[i], next[i-1]]; setItems(next); };
                      const moveDown = () => { if (i === items.length - 1) return; const next = [...items]; [next[i+1], next[i]] = [next[i], next[i+1]]; setItems(next); };
                      return (
                      <tr key={i} className="border-t border-border">
                        <td className="p-2">
                          <div className="flex items-center gap-0.5">
                            <button onClick={moveUp} disabled={i === 0} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-25 disabled:cursor-not-allowed" title="Move up"><ArrowUp className="w-3 h-3" /></button>
                            <button onClick={moveDown} disabled={i === items.length - 1} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-25 disabled:cursor-not-allowed" title="Move down"><ArrowDown className="w-3 h-3" /></button>
                          </div>
                        </td>
                        <td className="p-2">
                          <select className="cell-input text-[10px] uppercase" value={it.category} onChange={e => { const next=[...items]; next[i]={...next[i], category: e.target.value as any}; setItems(next); }}>
                            <option value="core">core</option>
                            <option value="bolt-on">bolt-on</option>
                            <option value="discount">discount</option>
                          </select>
                        </td>
                        <td className="p-2">
                          <input className="cell-input w-full font-medium" value={it.label} onChange={e => { const next=[...items]; next[i]={...next[i], label: e.target.value}; setItems(next); }} placeholder="Title" />
                          <textarea className="cell-input w-full text-[11px] mt-1 opacity-90" rows={2} value={it.description || ""} onChange={e => { const next=[...items]; next[i]={...next[i], description: e.target.value}; setItems(next); }} placeholder="Description (shown on proposal under the title)" />
                        </td>
                        <td className="p-2 text-right align-top">
                          <input type="number" step="0.5" className="cell-input w-14 text-right" value={it.qty} onChange={e => { const next=[...items]; next[i]={...next[i], qty: Number(e.target.value)}; setItems(next); }} />
                        </td>
                        <td className="p-2 align-top">
                          <input className="cell-input w-full" value={it.unit || ""} onChange={e => { const next=[...items]; next[i]={...next[i], unit: e.target.value}; setItems(next); }} />
                        </td>
                        <td className="p-2 text-right align-top">
                          <input type="number" className="cell-input w-20 text-right" value={it.unit_price_usd} onChange={e => { const next=[...items]; next[i]={...next[i], unit_price_usd: Number(e.target.value)}; setItems(next); }} />
                        </td>
                        <td className="p-2 text-right align-top">
                          <button onClick={() => setItems(items.filter((_, idx) => idx !== i))} className="text-muted-foreground hover:text-red-400"><Trash2 className="w-3.5 h-3.5" /></button>
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-border pt-4">
              <button onClick={deleteTier} className="text-xs text-red-400 hover:text-red-300">Delete this tier</button>
              <button onClick={save} className="px-5 py-2 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 text-white text-sm font-semibold">Save {tier.label}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Partnership Menu Editor ────────────────────────────────────────────────
type PartnershipItem = { title: string; body: string };
function PartnershipMenuEditor({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ items: PartnershipItem[]; heading?: string; subheading?: string; is_default: boolean }>({
    queryKey: ["partnership-menu"],
    queryFn: async () => (await apiRequest("GET", "/api/settings/partnership-menu")).json(),
  });
  const [items, setItems] = useState<PartnershipItem[]>([]);
  const [heading, setHeading] = useState<string>("");
  const [subheading, setSubheading] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  React.useEffect(() => {
    if (data?.items && !dirty) setItems(data.items);
    if (data && !dirty) {
      setHeading(data.heading ?? "");
      setSubheading(data.subheading ?? "");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.items, data?.heading, data?.subheading]);

  const save = useMutation({
    mutationFn: async () => (await apiRequest("POST", "/api/settings/partnership-menu", { items, heading, subheading })).json(),
    onSuccess: () => { toast({ title: "Partnership menu saved" }); setDirty(false); qc.invalidateQueries({ queryKey: ["partnership-menu"] }); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });
  const reset = useMutation({
    mutationFn: async () => (await apiRequest("DELETE", "/api/settings/partnership-menu")).json(),
    onSuccess: (j: any) => { toast({ title: "Reset to defaults" }); setItems(j.items); setHeading(j.heading ?? ""); setSubheading(j.subheading ?? ""); setDirty(false); qc.invalidateQueries({ queryKey: ["partnership-menu"] }); },
  });

  const update = (idx: number, patch: Partial<PartnershipItem>) => {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, ...patch } : it));
    setDirty(true);
  };
  const remove = (idx: number) => { setItems(prev => prev.filter((_, i) => i !== idx)); setDirty(true); };
  const add = () => { setItems(prev => [...prev, { title: "New item", body: "" }]); setDirty(true); };
  const move = (idx: number, dir: -1 | 1) => {
    const next = idx + dir;
    if (next < 0 || next >= items.length) return;
    setItems(prev => { const copy = [...prev]; [copy[idx], copy[next]] = [copy[next], copy[idx]]; return copy; });
    setDirty(true);
  };

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const inputCls = "w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-[#e8312a] focus:ring-1 focus:ring-[#e8312a]";

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Partnership Menu</h2>
          <p className="text-sm text-muted-foreground mt-1">
            These items appear on the public <code className="text-xs bg-muted/40 px-1 py-0.5 rounded">/advertising</code> page and inside every public media kit. Changes apply instantly site-wide.
          </p>
          <div className="mt-4 space-y-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Section heading</label>
              <input
                type="text"
                value={heading}
                onChange={e => { setHeading(e.target.value); setDirty(true); }}
                placeholder="What partnership looks like"
                disabled={!canEdit}
                className={inputCls}
              />
              <p className="text-[11px] text-muted-foreground mt-1">The last word is rendered in the accent (orange) colour.</p>
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">Subheading / byline</label>
              <textarea
                value={subheading}
                onChange={e => { setSubheading(e.target.value); setDirty(true); }}
                placeholder="Eight ways to put your brand in front of audiophiles who are ready to buy. Mix and match — or speak with us about a custom package."
                disabled={!canEdit}
                rows={2}
                className={inputCls + " min-h-[60px]"}
              />
            </div>
          </div>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => reset.mutate()}
              disabled={reset.isPending}
              className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
            >
              Reset to defaults
            </button>
            <button
              type="button"
              onClick={() => save.mutate()}
              disabled={save.isPending || !dirty}
              className="text-xs font-semibold px-4 py-1.5 rounded-md bg-[#e8312a] text-white hover:bg-[#d12822] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {save.isPending ? "Saving…" : dirty ? "Save changes" : "Saved"}
            </button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-3 flex gap-3">
            <div className="flex flex-col items-center gap-1 pt-1 shrink-0 w-10">
              <span className="text-xl font-extrabold text-[#e8312a] leading-none">{String(i + 1).padStart(2, "0")}</span>
              {canEdit && (
                <div className="flex flex-col gap-0.5 mt-1">
                  <button onClick={() => move(i, -1)} disabled={i === 0} className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-30 px-1">▲</button>
                  <button onClick={() => move(i, 1)} disabled={i === items.length - 1} className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-30 px-1">▼</button>
                </div>
              )}
            </div>
            <div className="flex-1 space-y-2 min-w-0">
              <input
                className={`${inputCls} font-semibold`}
                value={item.title}
                placeholder="Title (e.g. Editorial coverage)"
                onChange={e => update(i, { title: e.target.value })}
                disabled={!canEdit}
              />
              <textarea
                className={`${inputCls} min-h-[60px] resize-y leading-relaxed`}
                value={item.body}
                placeholder="Short description"
                onChange={e => update(i, { body: e.target.value })}
                disabled={!canEdit}
              />
            </div>
            {canEdit && (
              <button onClick={() => remove(i)} className="text-muted-foreground/60 hover:text-red-400 self-start p-1" title="Remove">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <button
          type="button"
          onClick={add}
          className="mt-3 w-full py-2 text-xs font-semibold rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors"
        >
          + Add item
        </button>
      )}

      {dirty && (
        <p className="text-xs text-amber-400 mt-3">You have unsaved changes — click <strong>Save changes</strong> to publish.</p>
      )}
    </div>
  );
}

// ─── Tier Inclusions Editor (drag to reorder global inclusion rows) ────────
type Inclusion = { key: string; label: string };
function TierInclusionsEditor({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [audience, setAudience] = useState<"trade" | "retailer">("trade");
  const { data, isLoading } = useQuery<{ inclusions: Inclusion[] }>({
    queryKey: ["pitch-inclusion-order", audience],
    queryFn: async () => (await apiRequest("GET", `/api/pitch/inclusion-order?audience=${audience}`)).json(),
  });
  const [order, setOrder] = useState<Inclusion[]>([]);
  React.useEffect(() => {
    if (data?.inclusions) setOrder(data.inclusions);
  }, [data?.inclusions]);

  const dragIdx = React.useRef<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  const persist = useMutation({
    mutationFn: async (keys: string[]) =>
      (await apiRequest("PUT", "/api/pitch/inclusion-order", { audience, keys })).json(),
    onSuccess: () => { toast({ title: "Order saved" }); qc.invalidateQueries({ queryKey: ["pitch-inclusion-order", audience] }); },
    onError: (e: any) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  const onDragStart = (i: number) => (e: React.DragEvent) => {
    if (!canEdit) return;
    dragIdx.current = i;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(i));
  };
  const onDragOver = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overIdx !== i) setOverIdx(i);
  };
  const onDrop = (target: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const src = dragIdx.current;
    dragIdx.current = null;
    setOverIdx(null);
    if (src == null || src === target) return;
    const next = [...order];
    const [moved] = next.splice(src, 1);
    next.splice(target, 0, moved);
    setOrder(next);
    persist.mutate(next.map(x => x.key));
  };
  const onDragEnd = () => { dragIdx.current = null; setOverIdx(null); };

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!order.length) return <div className="p-6 text-sm text-muted-foreground">No inclusions found.</div>;



  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-foreground">Tier Inclusions</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Drag rows to reorder the inclusion list shown on the <strong>Your Investment</strong> table. Trade and Retailer audiences have separate row sets and separate orders.
        </p>
        <div className="mt-3 inline-flex rounded-md border border-border overflow-hidden text-sm">
          <button
            onClick={() => setAudience("trade")}
            className={`px-3 py-1.5 ${audience === "trade" ? "bg-[#e8312a] text-white" : "hover:bg-muted"}`}
          >Trade</button>
          <button
            onClick={() => setAudience("retailer")}
            className={`px-3 py-1.5 ${audience === "retailer" ? "bg-[#e8312a] text-white" : "hover:bg-muted"}`}
          >Retailer</button>
        </div>
      </div>

      <div className="space-y-1">
        {order.map((row, i) => (
          <div
            key={row.label}
            draggable={canEdit}
            onDragStart={onDragStart(i)}
            onDragOver={onDragOver(i)}
            onDragLeave={() => setOverIdx(null)}
            onDrop={onDrop(i)}
            onDragEnd={onDragEnd}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-md border bg-card transition-all ${
              overIdx === i ? "border-[#e8312a] ring-1 ring-[#e8312a]" : "border-border hover:border-muted-foreground/40"
            } ${canEdit ? "cursor-grab active:cursor-grabbing" : ""}`}
          >
            <span className="text-muted-foreground/50 select-none text-sm w-5 text-center">⋮⋮</span>
            <span className="text-xs text-muted-foreground w-8 tabular-nums">{i + 1}</span>
            <span className="flex-1 text-sm font-semibold text-foreground truncate">{row.label}</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">{row.key}</span>
          </div>
        ))}
      </div>

      {persist.isPending && <p className="text-xs text-muted-foreground mt-3">Saving…</p>}
    </div>
  );
}

// ─── Email Templates editor (PITCH Settings → Email Templates) ─────────────
// Lists the editable transactional email templates. Each row expands into a subject
// + HTML body editor with click-to-insert token chips, live preview, send-test, revert.
type EmailTemplate = {
  key: string;
  label: string;
  description: string;
  tokens: { token: string; description: string }[];
  default_subject: string;
  default_html: string;
  subject_override: string;
  html_override: string;
  is_customised: boolean;
};

function SettingsEmailsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ templates: EmailTemplate[] }>({
    queryKey: ["/api/admin/email-templates"],
    queryFn: async () => (await apiRequest("GET", "/api/admin/email-templates")).json(),
  });
  const [openKey, setOpenKey] = useState<string | null>(null);

  if (isLoading) return <div className="p-6 text-sm text-muted-foreground">Loading email templates…</div>;
  if (!data?.templates) return <div className="p-6 text-sm text-red-400">Failed to load templates</div>;

  return (
    <div className="flex-1 min-h-0 overflow-auto p-6 space-y-3">
      <p className="text-xs text-muted-foreground">
        Customise the subject and HTML body of every transactional email PULSE sends.
        Use <code className="text-[#e8312a] bg-[#e8312a]/10 px-1 rounded">{`{{token}}`}</code> syntax to insert dynamic values.
        Leaving a field blank reverts to the built-in default.
      </p>
      {data.templates.map(t => (
        <EmailTemplateCard
          key={t.key}
          tpl={t}
          isOpen={openKey === t.key}
          onToggle={() => setOpenKey(openKey === t.key ? null : t.key)}
          onSaved={() => qc.invalidateQueries({ queryKey: ["/api/admin/email-templates"] })}
        />
      ))}
    </div>
  );
}

function EmailTemplateCard({ tpl, isOpen, onToggle, onSaved }: { tpl: EmailTemplate; isOpen: boolean; onToggle: () => void; onSaved: () => void }) {
  const { toast } = useToast();
  const [subject, setSubject] = useState(tpl.subject_override || "");
  const [html, setHtml] = useState(tpl.html_override || "");
  const [saving, setSaving] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testing, setTesting] = useState(false);

  React.useEffect(() => {
    setSubject(tpl.subject_override || "");
    setHtml(tpl.html_override || "");
  }, [tpl.key, tpl.subject_override, tpl.html_override]);

  const isCustomised = (subject || "").trim() !== "" || (html || "").trim() !== "";

  const save = async () => {
    setSaving(true);
    try {
      const r = await apiRequest("PUT", `/api/admin/email-templates/${tpl.key}`, {
        subject_override: subject || "",
        html_override: html || "",
      });
      if (!r.ok) throw new Error(`Save failed (${r.status})`);
      toast({ title: "Template saved" });
      onSaved();
    } catch (e: any) {
      toast({ title: "Save failed", description: e?.message || "Unknown", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const revert = async () => {
    if (!confirm(`Revert "${tpl.label}" to the built-in default?`)) return;
    setSaving(true);
    try {
      const r = await apiRequest("DELETE", `/api/admin/email-templates/${tpl.key}`);
      if (!r.ok) throw new Error(`Revert failed (${r.status})`);
      toast({ title: "Reverted to default" });
      setSubject("");
      setHtml("");
      onSaved();
    } catch (e: any) {
      toast({ title: "Revert failed", description: e?.message || "Unknown", variant: "destructive" });
    } finally { setSaving(false); }
  };

  const sendTest = async () => {
    setTesting(true);
    try {
      const body: any = {};
      if (testTo.trim()) body.to = testTo.trim();
      const r = await apiRequest("POST", `/api/admin/email-templates/${tpl.key}/test`, body);
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.error || `Send failed (${r.status})`);
      toast({ title: "Test sent", description: `To ${j.sent_to}` });
    } catch (e: any) {
      toast({ title: "Test send failed", description: e?.message || "Unknown", variant: "destructive" });
    } finally { setTesting(false); }
  };

  const insertToken = (token: string) => {
    // Insert into focused textarea; if none, append to body.
    const active = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
    const insertText = `{{${token}}}`;
    if (active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA") && (active.dataset?.tplField === "subject" || active.dataset?.tplField === "html")) {
      const start = active.selectionStart ?? active.value.length;
      const end = active.selectionEnd ?? active.value.length;
      const cur = active.value;
      const next = cur.slice(0, start) + insertText + cur.slice(end);
      if (active.dataset.tplField === "subject") setSubject(next);
      else setHtml(next);
      setTimeout(() => { active.focus(); active.setSelectionRange(start + insertText.length, start + insertText.length); }, 0);
    } else {
      setHtml(html + insertText);
    }
  };

  return (
    <div className={`rounded-lg border ${tpl.is_customised ? "border-[#e8312a]/40 bg-[#e8312a]/[0.04]" : "border-border bg-card"}`}>
      <button onClick={onToggle} className="w-full px-4 py-3 flex items-center gap-3 text-left">
        {isOpen ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        <div className="flex-1">
          <div className="font-semibold text-sm flex items-center gap-2">
            {tpl.label}
            {tpl.is_customised && <span className="text-[9px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-[#e8312a]/15 text-[#e8312a]">CUSTOMISED</span>}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">{tpl.description}</div>
        </div>
      </button>
      {isOpen && (
        <div className="px-4 pb-4 space-y-3 border-t border-border/50 pt-3">
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Subject</label>
            <input
              data-tpl-field="subject"
              className="input"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder={tpl.default_subject}
            />
            <p className="text-[10px] text-muted-foreground mt-1">Leave empty to use the default: <code className="text-foreground/70">{tpl.default_subject}</code></p>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1">HTML body</label>
            <textarea
              data-tpl-field="html"
              className="input font-mono"
              style={{ minHeight: 220, lineHeight: 1.5, fontSize: 12 }}
              value={html}
              onChange={e => setHtml(e.target.value)}
              placeholder={tpl.default_html}
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Leave empty to use the built-in default. A standard email shell (logo, footer, styles) wraps the body automatically unless you provide a full HTML document.
            </p>
          </div>
          <div>
            <label className="block text-[11px] uppercase tracking-wider font-bold text-muted-foreground mb-1">Available tokens — click to insert</label>
            <div className="flex flex-wrap gap-1.5">
              {tpl.tokens.map(t => (
                <button
                  key={t.token}
                  type="button"
                  onClick={() => insertToken(t.token)}
                  className="px-2 py-1 rounded bg-muted text-foreground/80 hover:bg-[#e8312a]/20 hover:text-foreground text-[11px] font-mono transition-colors"
                  title={t.description}
                >
                  {`{{${t.token}}}`}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t border-border/50 flex-wrap">
            <input
              type="email"
              className="input text-xs flex-1 min-w-[180px]"
              placeholder="Send test to… (leave blank for your own address)"
              value={testTo}
              onChange={e => setTestTo(e.target.value)}
            />
            <button onClick={sendTest} disabled={testing} className="px-3 py-1.5 rounded-md border border-border text-xs font-semibold hover:border-[#e8312a]">
              {testing ? "Sending…" : "Send test"}
            </button>
            {tpl.is_customised && (
              <button onClick={revert} disabled={saving} className="px-3 py-1.5 rounded-md border border-border text-xs font-semibold hover:border-amber-500 hover:text-amber-400">
                Revert to default
              </button>
            )}
            <button onClick={save} disabled={saving} className="px-4 py-1.5 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 disabled:bg-[#e8312a]/50 text-white text-xs font-semibold">
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Quick Send Modal ─────────────────────────────────────────────────────
// Sends an arbitrary recipient one of our existing Media Kits without creating
// a Lead. Creates a fresh share + fires the kit-delivery email. The send is
// tracked via media_kit_shares.proposal_state='sent' and a proposal_events row,
// so it shows up under the kit's "Shares & analytics" tab.
function QuickSendModal({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [kitId, setKitId] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [additional, setAdditional] = useState<Array<{ name: string; email: string }>>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ delivered: number; total: number; results: Array<{ ok: boolean; email: string; magic_link?: string; error?: string }> } | null>(null);

  const { data: kitsData } = useQuery<{ kits: any[] }>({
    queryKey: ["/api/media-kit/kits", { quicksend: 1 }],
    queryFn: () => apiRequest("GET", "/api/media-kit/kits").then(r => r.json()),
  });
  const kits = (kitsData?.kits || []).filter((k: any) => k.status === "published" && !k.prospect_lead_id);

  // Group kits by kind for the picker.
  const grouped = kits.reduce<Record<string, any[]>>((acc, k) => {
    const key = (k.kind || "trade").toString();
    (acc[key] = acc[key] || []).push(k);
    return acc;
  }, {});

  // Auto-select first kit on load
  if (kitId == null && kits.length) setKitId(kits[0].id);

  const send = async () => {
    if (!name.trim() || !email.trim() || !kitId) {
      toast({ title: "Missing fields", description: "Name, email and kit are required.", variant: "destructive" });
      return;
    }
    setSending(true);
    try {
      const cleanAdditional = additional
        .map(r => ({ name: r.name.trim(), email: r.email.trim() }))
        .filter(r => r.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email));
      const r = await apiRequest("POST", "/api/media-kit/quick-send", {
        kit_id: kitId,
        name: name.trim(),
        email: email.trim(),
        company: company.trim(),
        note: note.trim(),
        additional_recipients: cleanAdditional,
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.message || `Send failed (${r.status})`);
      setResult({ delivered: j.delivered, total: j.total, results: j.results || [] });
      const successList = (j.results || []).filter((x: any) => x.ok).map((x: any) => x.email);
      toast({
        title: successList.length > 1 ? `Sent to ${successList.length}/${j.total} recipients` : "Sent",
        description: successList.join(", "),
      });
      onSent();
    } catch (e: any) {
      toast({ title: "Quick Send failed", description: e?.message || "Unknown error", variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  const selectedKit = kits.find((k: any) => k.id === kitId);
  const kindLabel: Record<string, string> = { trade: "Trade", retailer: "Retailer" };
  const regionLabel: Record<string, string> = { global: "Global", anz: "ANZ", uk_eu: "UK & EU", na: "North America", asia: "Asia" };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-lg shadow-xl w-full max-w-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">Quick Send Media Kit</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Sends a personalised link straight to a recipient. Tracked under the kit's Shares.</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-2xl leading-none">×</button>
        </div>

        {result ? (
          <div className="p-5 space-y-3">
            <div className="rounded-md border border-green-500/30 bg-green-500/10 p-4 text-sm">
              <div className="font-semibold text-green-400 mb-1">Sent successfully</div>
              <p className="text-muted-foreground">Delivered {result.delivered}/{result.total} recipient{result.total === 1 ? "" : "s"}. Each one gets a unique personalised link — opens are tracked individually.</p>
            </div>
            <div className="text-xs space-y-2">
              {result.results.map((r, i) => (
                <div key={i} className={`border rounded p-2 ${r.ok ? "border-border bg-zinc-900/50" : "border-red-500/40 bg-red-500/10"}`}>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-mono">{r.email}</span>
                    {r.ok ? (
                      <button onClick={() => navigator.clipboard.writeText(r.magic_link || "")} className="px-2 py-0.5 rounded border border-border hover:bg-accent text-[11px]">Copy link</button>
                    ) : (
                      <span className="text-red-400 text-[11px]">{r.error || "failed"}</span>
                    )}
                  </div>
                  {r.ok && <div className="font-mono break-all text-[11px] text-muted-foreground">{r.magic_link}</div>}
                </div>
              ))}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-3 py-1.5 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 text-white text-sm font-semibold">Done</button>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <div>
              <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-muted-foreground">Which Media Kit</label>
              <select
                value={kitId ?? ""}
                onChange={e => setKitId(Number(e.target.value))}
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
              >
                {Object.entries(grouped).map(([kind, list]) => (
                  <optgroup key={kind} label={kindLabel[kind] || kind}>
                    {list.map((k: any) => (
                      <option key={k.id} value={k.id}>
                        {k.label} · {regionLabel[k.region] || k.region?.toUpperCase()} · {(k.currency || "").toUpperCase()}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {selectedKit && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  {selectedKit.label} · {regionLabel[selectedKit.region] || selectedKit.region?.toUpperCase()}
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-muted-foreground">Recipient name</label>
                <input value={name} onChange={e => setName(e.target.value)} placeholder="Jane Doe" className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm" />
              </div>
              <div>
                <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-muted-foreground">Email</label>
                <input value={email} onChange={e => setEmail(e.target.value)} type="email" placeholder="jane@brand.com" className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm" />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-muted-foreground">Company (optional)</label>
              <input value={company} onChange={e => setCompany(e.target.value)} placeholder="Brand Pty Ltd" className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm" />
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Additional recipients</label>
                <button type="button" onClick={() => setAdditional([...additional, { name: "", email: "" }])} className="text-xs px-2 py-1 rounded-md border border-border bg-card hover:bg-accent">+ Add recipient</button>
              </div>
              {additional.length === 0 && (
                <div className="text-[11px] text-muted-foreground italic py-1">Each additional recipient gets their own unique link with separate open-tracking.</div>
              )}
              {additional.map((r, i) => (
                <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2 mb-2">
                  <input placeholder="Name" value={r.name} onChange={e => { const next = [...additional]; next[i] = { ...next[i], name: e.target.value }; setAdditional(next); }} className="px-3 py-2 rounded-md bg-background border border-border text-sm" />
                  <input type="email" placeholder="email@example.com" value={r.email} onChange={e => { const next = [...additional]; next[i] = { ...next[i], email: e.target.value }; setAdditional(next); }} className="px-3 py-2 rounded-md bg-background border border-border text-sm" />
                  <button type="button" onClick={() => setAdditional(additional.filter((_, idx) => idx !== i))} className="px-2 py-2 rounded-md border border-border hover:bg-destructive/10 hover:text-destructive text-xs">Remove</button>
                </div>
              ))}
            </div>

            <div>
              <label className="block text-xs font-semibold mb-1.5 uppercase tracking-wide text-muted-foreground">Internal note (optional)</label>
              <input value={note} onChange={e => setNote(e.target.value)} placeholder="Context for your team — not shown to the recipient" className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm" />
            </div>

            <div className="text-xs text-muted-foreground bg-zinc-900/40 border border-border rounded p-2.5">
              Sends the <strong>Prospect — Media Kit delivery</strong> email template with a 30-day personalised magic link. The share appears under the kit's <strong>Shares & analytics</strong> tab and is tracked from there.
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onClose} className="px-4 py-2 rounded-md border border-border hover:bg-accent text-sm">Cancel</button>
              <button onClick={send} disabled={sending || !kitId || !name.trim() || !email.trim()} className="flex items-center gap-2 px-4 py-2 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 disabled:bg-[#e8312a]/40 text-white text-sm font-semibold">
                <Send className="w-3.5 h-3.5" /> {sending ? "Sending…" : "Send Media Kit"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── New Proposal Type Chooser ──────────────────────────────────────────────
// Lightweight modal that asks the admin whether they want to start a Trade
// proposal (full wizard, line items, contract) or a Retailer proposal (simple
// 3-tier pricing kit personalised with the prospect's company name).
function ProposalTypeChooser({ onClose, onPickTrade, onPickRetailer }: {
  onClose: () => void;
  onPickTrade: () => void;
  onPickRetailer: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">New Proposal</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Pick the audience this proposal is for.</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-2xl leading-none">×</button>
        </div>
        <div className="p-5 grid gap-3">
          <button
            onClick={onPickTrade}
            className="text-left p-4 rounded-lg border border-border hover:border-[#e8312a] hover:bg-[#e8312a]/5 transition-colors"
          >
            <div className="font-semibold text-sm">Trade Proposal</div>
            <p className="text-xs text-muted-foreground mt-1">For brands and distributors. Full 5-step wizard with tier base, bolt-ons, contract length, region focus, and per-line pricing.</p>
          </button>
          <button
            onClick={onPickRetailer}
            className="text-left p-4 rounded-lg border border-border hover:border-[#e8312a] hover:bg-[#e8312a]/5 transition-colors"
          >
            <div className="font-semibold text-sm">Retailer Proposal</div>
            <p className="text-xs text-muted-foreground mt-1">For retail stores. 3-tier fixed pricing (Partner / Silver / Gold) — no bolt-ons. Personalised with the prospect's store name.</p>
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Retailer Proposal Modal ────────────────────────────────────────────────
// Captures the prospect's company name + contact details, then clones the
// global Retailer master kit into a prospect kit. Adds a manual Inbound Lead
// so the prospect tracks under the Leads tab. Returns the magic link.
function RetailerProposalModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [company, setCompany] = useState("");
  const [contactName, setContactName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<{ magic_link: string; kit_id: number; lead_id: number } | null>(null);

  const submit = async () => {
    if (!company.trim()) { toast({ title: "Company name required", variant: "destructive" }); return; }
    if (!email.trim()) { toast({ title: "Contact email required", variant: "destructive" }); return; }
    setSubmitting(true);
    try {
      const r = await apiRequest("POST", "/api/pitch/retailer-kit", {
        client_name: company.trim(),
        client_contact_name: contactName.trim(),
        client_contact_email: email.trim(),
        intro_text: note.trim(),
      });
      const j = await r.json();
      if (!r.ok || !j?.ok) throw new Error(j?.message || `Failed (${r.status})`);
      setResult({ magic_link: j.magic_link, kit_id: j.kit_id, lead_id: j.lead_id });
      toast({ title: "Retailer kit created", description: `Lead #${j.lead_id} created. Edit the kit or copy the link.` });
    } catch (e: any) {
      toast({ title: "Failed to create retailer kit", description: e?.message || "Unknown error", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-card border border-border rounded-xl w-full max-w-lg" onClick={e => e.stopPropagation()}>
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">New Retailer Proposal</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Personalise the global retailer kit for a specific store.</p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground text-2xl leading-none">×</button>
        </div>
        {result ? (
          <div className="p-5 space-y-4">
            <div className="rounded-md border border-green-500/30 bg-green-500/10 p-4 text-sm">
              <div className="font-semibold text-green-400 mb-1">Retailer kit created</div>
              <p className="text-muted-foreground">A prospect kit clone has been built and a lead is now in your Leads tab.</p>
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Prospect magic link</label>
              <div className="flex gap-2">
                <input className="flex-1 px-3 py-2 rounded-md bg-background border border-border text-xs font-mono" value={result.magic_link} readOnly />
                <button
                  onClick={() => { navigator.clipboard.writeText(result.magic_link); toast({ title: "Link copied" }); }}
                  className="px-3 py-2 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 text-white text-xs font-semibold"
                >
                  Copy
                </button>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={onCreated} className="px-3 py-1.5 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 text-white text-sm font-semibold">View in Leads</button>
            </div>
          </div>
        ) : (
          <div className="p-5 space-y-3">
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Store / company name *</label>
              <input
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
                placeholder="e.g. Audio Destination"
                value={company}
                onChange={e => setCompany(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Contact name</label>
              <input
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
                placeholder="e.g. Mike Rogers"
                value={contactName}
                onChange={e => setContactName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Contact email *</label>
              <input
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
                placeholder="mike@audiodestination.com"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-1.5">Internal note (optional)</label>
              <textarea
                className="w-full px-3 py-2 rounded-md bg-background border border-border text-sm"
                rows={3}
                placeholder="Anything we should remember about this prospect…"
                value={note}
                onChange={e => setNote(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} disabled={submitting} className="px-3 py-1.5 rounded-md border border-border hover:bg-accent text-sm">Cancel</button>
              <button onClick={submit} disabled={submitting || !company.trim() || !email.trim()} className="px-3 py-1.5 rounded-md bg-[#e8312a] hover:bg-[#e8312a]/90 disabled:bg-[#e8312a]/40 text-white text-sm font-semibold">
                {submitting ? "Building…" : "Build retailer kit"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
