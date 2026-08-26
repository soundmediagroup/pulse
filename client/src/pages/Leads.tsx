// Inbound Leads page — manage submissions from the advertising page.
// Access: requires pitch_access view/edit/admin via session.
import React, { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../lib/queryClient";
import { useToast } from "../hooks/use-toast";
import {
  Mail, Search, Copy, Send, ExternalLink, Trash2, X,
  Building2, MapPin, Tag, Clock, Eye, AlertCircle, Pencil,
} from "lucide-react";

const REGIONS: { key: string; label: string }[] = [
  { key: "anz",    label: "Australia & New Zealand" },
  { key: "uk_eu",  label: "United Kingdom & Europe" },
  { key: "na",     label: "North America" },
  { key: "asia",   label: "Asia" },
  { key: "global", label: "Global / Other" },
];

type ProposalEvent = {
  id: number;
  event_type: string;
  actor_name: string | null;
  actor_email: string | null;
  ip: string | null;
  message: string | null;
  created_at: string;
};

type Lead = {
  id: number;
  source: string;
  name: string | null;
  company: string | null;
  company_type: string | null;
  role: string | null;
  country: string | null;
  region: string | null;
  email: string | null;
  message: string | null;
  interests: string[];
  status: "new" | "contacted" | "qualified" | "won" | "lost";
  kit_slug: string | null;
  kit_token: string | null;
  kit_views: number | null;
  kit_last_viewed: string | null;
  kit_label: string | null;
  magic_link: string | null;
  created_at: string;
  updated_at: string;
  notes?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  referrer?: string | null;
};

const STATUS_LABELS: Record<string, string> = {
  new: "New",
  contacted: "Contacted",
  qualified: "Qualified",
  won: "Won",
  lost: "Lost",
};

const STATUS_COLOURS: Record<string, string> = {
  new: "#e8312a",
  contacted: "#f59e0b",
  qualified: "#3b82f6",
  won: "#22c55e",
  lost: "#71717a",
};

const COMPANY_TYPE_LABELS: Record<string, string> = {
  manufacturer: "Manufacturer",
  distributor: "Distributor",
  retailer: "Retailer",
  other: "Other",
};

const INTEREST_LABELS: Record<string, string> = {
  news: "News & PR",
  reviews: "Reviews",
  banners: "Display Banners",
  forum: "Forum Sponsorship",
  newsletter: "Newsletter / EDM",
  social: "Social Campaigns",
  classifieds: "Classifieds",
  brand: "Brand Package",
  ai: "AI Discoverability",
  other: "Other",
};

export default function Leads({ onOpenKit }: { onOpenKit?: (kitId: number) => void } = {}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [companyTypeFilter, setCompanyTypeFilter] = useState<string>("");
  const [regionFilter, setRegionFilter] = useState<string>("");
  const [search, setSearch] = useState<string>("");
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const { data, isLoading } = useQuery<{ leads: Lead[]; counts: Record<string, number> }>({
    queryKey: ["/api/leads", statusFilter, companyTypeFilter, regionFilter, search],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set("status", statusFilter);
      if (companyTypeFilter) params.set("company_type", companyTypeFilter);
      if (regionFilter) params.set("region", regionFilter);
      if (search) params.set("search", search);
      return apiRequest("GET", `/api/leads?${params}`).then(r => r.json());
    },
    refetchInterval: 30000, // poll every 30s for new leads
  });

  const leads = data?.leads || [];
  const counts = data?.counts || {};
  const selected = useMemo(
    () => leads.find(l => l.id === selectedId) || null,
    [leads, selectedId]
  );

  // Proposal activity timeline for the selected lead.
  const { data: eventsData } = useQuery<{ events: ProposalEvent[] }>({
    queryKey: ["/api/leads/events", selectedId],
    queryFn: async () => {
      if (!selectedId) return { events: [] };
      const res = await apiRequest("GET", `/api/leads/${selectedId}/events`);
      return res.json();
    },
    enabled: !!selectedId,
    refetchInterval: 15000,
  });
  const events = eventsData?.events || [];

  const updateMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: number; patch: any }) => {
      const res = await apiRequest("PATCH", `/api/leads/${id}`, patch);
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
    },
    onError: (e: any) => {
      toast({ title: "Update failed", description: e?.message || "Unknown error", variant: "destructive" });
    },
  });

  const sendKitMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/leads/${id}/send-kit`);
      return res.json();
    },
    onSuccess: (data) => {
      toast({ title: "Media Kit sent", description: `Magic link emailed to ${data.sent_to}` });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/leads/events"] });
    },
    onError: (e: any) => {
      toast({ title: "Send failed", description: e?.message || "Unknown error", variant: "destructive" });
    },
  });

  const syncKitMutation = useMutation({
    mutationFn: async ({ id, force }: { id: number; force?: boolean }) => {
      const res = await apiRequest("POST", `/api/leads/${id}/sync-kit-from-master`, { force: !!force });
      return res.json();
    },
    onSuccess: (j: any) => {
      const droppedCount = (j?.dropped || []).length;
      const preservedCount = (j?.preserved || []).length;
      toast({
        title: "Kit synced from master",
        description: `${droppedCount} block(s) reverted to inherit· ${preservedCount} preserved (proposal + your edits)`,
      });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
    },
    onError: (e: any) => toast({ title: "Sync failed", description: e?.message || "Unknown", variant: "destructive" }),
  });

  const [customiseModalOpen, setCustomiseModalOpen] = useState(false);
  const [customiseRegion, setCustomiseRegion] = useState<string>("");
  const [customiseAudience, setCustomiseAudience] = useState<"trade" | "retailer">("trade");

  const switchKitRegionMutation = useMutation({
    mutationFn: async ({ id, region }: { id: number; region: string }) => {
      const res = await apiRequest("POST", `/api/leads/${id}/switch-kit-region`, { region });
      const j = await res.json();
      if (!res.ok) throw new Error(j?.message || "Switch failed");
      return j;
    },
    onSuccess: () => {
      toast({ title: "Kit region switched", description: "Clone re-parented to the new regional master. Proposal block preserved." });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
    },
    onError: (e: any) => toast({ title: "Switch failed", description: e?.message || "Unknown", variant: "destructive" }),
  });

  const customiseKitMutation = useMutation({
    mutationFn: async (arg: number | { id: number; region?: string; audience?: "trade" | "retailer" }) => {
      const id = typeof arg === "number" ? arg : arg.id;
      const region = typeof arg === "object" ? arg.region : undefined;
      const audience = typeof arg === "object" ? arg.audience : undefined;
      const body: any = {};
      if (region) body.region = region;
      if (audience) body.audience = audience;
      const res = await apiRequest("POST", `/api/leads/${id}/customise-kit`, Object.keys(body).length ? body : undefined);
      return res.json();
    },
    onSuccess: (data) => {
      toast({
        title: data.was_existing ? "Opening existing custom kit" : "Custom kit created",
        description: "Edit the kit, then come back to send it.",
      });
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
      qc.invalidateQueries({ queryKey: ["/api/media-kit/kits"] });
      if (onOpenKit && data.kit_id) onOpenKit(data.kit_id);
    },
    onError: (e: any) => {
      toast({ title: "Customise failed", description: e?.message || "Unknown error", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/leads/${id}`);
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Lead deleted" });
      setSelectedId(null);
      qc.invalidateQueries({ queryKey: ["/api/leads"] });
    },
    onError: (e: any) => {
      toast({ title: "Delete failed", description: e?.message || "Unknown error", variant: "destructive" });
    },
  });

  return (
    <div className="leads-page h-full flex bg-background overflow-hidden">
      <style>{`
        .leads-page .input {
          width: 100%; padding: 8px 12px; background: #18181b;
          border: 1px solid #2a2a2e; border-radius: 6px; color: #f3f3f4;
          font-size: 13px; transition: border-color 0.15s;
        }
        .leads-page .input:focus { outline: none; border-color: #e8312a; }
        .leads-page .input::placeholder { color: #555; }
        .leads-page select.input { appearance: none; -webkit-appearance: none; cursor: pointer; }
        .leads-page select.input option { background: #1a1a1d; color: #f3f3f4; }
        .leads-page .btn {
          padding: 7px 14px; border-radius: 6px; font-size: 13px; font-weight: 600;
          border: none; cursor: pointer; transition: all 0.15s;
          display: inline-flex; align-items: center; gap: 6px;
        }
        .leads-page .btn-primary { background: #e8312a; color: #fff; }
        .leads-page .btn-primary:hover { background: #ff4f48; }
        .leads-page .btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }
        .leads-page .btn-ghost { background: transparent; color: #aaa; border: 1px solid #2a2a2e; }
        .leads-page .btn-ghost:hover { color: #fff; border-color: #555; }
        .leads-page .lead-row {
          display: grid; grid-template-columns: 90px 1.4fr 1fr 110px 100px 100px;
          gap: 12px; padding: 12px 16px; border-bottom: 1px solid #1f1f23;
          cursor: pointer; transition: background 0.1s; align-items: center;
        }
        .leads-page .lead-row:hover { background: rgba(255,255,255,0.02); }
        .leads-page .lead-row.selected { background: rgba(232,49,42,0.08); }
        .leads-page .lead-row .col-name { font-weight: 600; color: #f3f3f4; font-size: 13px; }
        .leads-page .lead-row .col-sub { color: #888; font-size: 11px; margin-top: 2px; }
        .leads-page .status-badge {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 700;
          text-transform: uppercase; letter-spacing: 0.05em;
        }
        .leads-page .status-dot { width: 6px; height: 6px; border-radius: 999px; }
        .leads-page .interest-pill {
          display: inline-block; background: rgba(255,255,255,0.05); border: 1px solid #2a2a2e;
          color: #ccc; padding: 2px 8px; border-radius: 999px; font-size: 11px;
          margin-right: 4px; margin-bottom: 4px;
        }
        .leads-page .header-stat {
          display: flex; align-items: center; gap: 6px; padding: 6px 12px;
          background: #18181b; border: 1px solid #2a2a2e; border-radius: 999px;
          font-size: 12px; color: #ccc;
        }
        .leads-page .header-stat strong { color: #fff; font-weight: 700; }
      `}</style>

      {/* List pane */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header + filters */}
        <div className="border-b border-border bg-card/30 px-6 py-4">
          <div className="flex items-center justify-between mb-3">
            <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
              <Mail className="w-5 h-5" />
              Inbound Leads
            </h1>
            <div className="flex items-center gap-2 flex-wrap">
              {(["new", "contacted", "qualified", "won", "lost"] as const).map(s => (
                counts[s] ? (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(statusFilter === s ? "" : s)}
                    className="header-stat"
                    style={statusFilter === s ? { borderColor: STATUS_COLOURS[s], color: "#fff" } : {}}
                  >
                    <span className="status-dot" style={{ background: STATUS_COLOURS[s] }} />
                    <strong>{counts[s]}</strong> {STATUS_LABELS[s]}
                  </button>
                ) : null
              ))}
            </div>
          </div>
          <div className="grid grid-cols-12 gap-2">
            <div className="col-span-5 relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <input
                className="input pl-8"
                placeholder="Search by name, company, or email…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
            <select className="input col-span-3" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All statuses</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <select className="input col-span-2" value={companyTypeFilter} onChange={e => setCompanyTypeFilter(e.target.value)}>
              <option value="">All types</option>
              {Object.entries(COMPANY_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <select className="input col-span-2" value={regionFilter} onChange={e => setRegionFilter(e.target.value)}>
              <option value="">All regions</option>
              <option value="anz">ANZ</option>
              <option value="uk_eu">UK & EU</option>
              <option value="asia">Asia</option>
              <option value="na">N. America</option>
              <option value="global">Global</option>
            </select>
          </div>
        </div>

        {/* Table */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="p-12 text-center text-muted-foreground">Loading leads…</div>
          ) : leads.length === 0 ? (
            <div className="p-12 text-center text-muted-foreground">
              <Mail className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <div className="text-base font-semibold">No leads yet</div>
              <div className="text-sm mt-1">Submissions from the advertising page will appear here.</div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-[90px_1.4fr_1fr_110px_100px_100px] gap-3 px-4 py-2 border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground font-bold">
                <div>Status</div>
                <div>Name / Company</div>
                <div>Email</div>
                <div>Type</div>
                <div>Region</div>
                <div>Received</div>
              </div>
              {leads.map(lead => (
                <div
                  key={lead.id}
                  className={`lead-row ${selectedId === lead.id ? "selected" : ""}`}
                  onClick={() => setSelectedId(lead.id)}
                >
                  <div>
                    <span
                      className="status-badge"
                      style={{
                        background: `${STATUS_COLOURS[lead.status]}22`,
                        color: STATUS_COLOURS[lead.status],
                        border: `1px solid ${STATUS_COLOURS[lead.status]}44`,
                      }}
                    >
                      <span className="status-dot" style={{ background: STATUS_COLOURS[lead.status] }} />
                      {STATUS_LABELS[lead.status]}
                    </span>
                  </div>
                  <div>
                    <div className="col-name">{lead.name || "(no name)"}</div>
                    <div className="col-sub">{lead.company || ""}{lead.role ? ` · ${lead.role}` : ""}</div>
                  </div>
                  <div className="text-xs text-foreground/80 truncate">{lead.email}</div>
                  <div className="text-xs text-muted-foreground capitalize">{lead.company_type || "—"}</div>
                  <div className="text-xs text-muted-foreground uppercase">{lead.region || "—"}</div>
                  <div className="text-xs text-muted-foreground">{relTime(lead.created_at)}</div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Detail pane */}
      {selected && (
        <div className="w-[460px] border-l border-border bg-card/20 overflow-y-auto">
          <div className="sticky top-0 z-10 bg-card border-b border-border px-5 py-4 flex items-center justify-between">
            <div>
              <div className="text-sm font-bold text-foreground">{selected.name || "(no name)"}</div>
              <div className="text-xs text-muted-foreground">{selected.company}</div>
            </div>
            <button onClick={() => setSelectedId(null)} className="btn btn-ghost" style={{ padding: "4px 8px" }}>
              <X className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="p-5 space-y-5">
            {/* Status changer */}
            <div>
              <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground block mb-1.5">Status</label>
              <select
                className="input"
                value={selected.status}
                onChange={e => updateMutation.mutate({ id: selected.id, patch: { status: e.target.value } })}
                style={{ borderColor: `${STATUS_COLOURS[selected.status]}66` }}
              >
                {Object.entries(STATUS_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>

            {/* Customise + Send Kit */}
            <div className="space-y-2">
              <button
                className="btn btn-primary w-full"
                disabled={customiseKitMutation.isPending}
                onClick={() => {
                  // Always open the picker. If a clone already exists (magic_link is
                  // set), the modal lets the admin switch audience (Trade <-> Retailer)
                  // which triggers a rebuild server-side. If they keep the same audience,
                  // they can just open the existing clone via the secondary button.
                  setCustomiseAudience("trade");
                  setCustomiseRegion(selected.region || "anz");
                  setCustomiseModalOpen(true);
                }}
              >
                <Pencil className="w-3.5 h-3.5" />
                {customiseKitMutation.isPending ? "Opening editor…" : "Customise Media Kit"}
              </button>
              <p className="text-[11px] text-muted-foreground -mt-1 px-1">
                Open the kit editor to tailor it for this prospect, then send when ready.
              </p>
              <div className="flex gap-2 flex-wrap pt-1">
                <button
                  className="btn btn-ghost flex-1"
                  disabled={sendKitMutation.isPending || !selected.email}
                  onClick={() => {
                    if (confirm(`Send the current Media Kit to ${selected.email}?\n\nThe kit will be emailed as-is. To customise first, click 'Customise Media Kit' above.`)) {
                      sendKitMutation.mutate(selected.id);
                    }
                  }}
                >
                  <Send className="w-3.5 h-3.5" />
                  {sendKitMutation.isPending ? "Sending…" : "Send Kit Now"}
                </button>
                {selected.magic_link && (
                  <a href={selected.magic_link} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
                    <Eye className="w-3.5 h-3.5" />
                    Preview
                  </a>
                )}
              </div>
              <button
                className="btn btn-ghost text-xs w-full mt-1"
                disabled={syncKitMutation.isPending}
                onClick={() => {
                  if (confirm(`Sync this kit from the master?\n\nAll inherited content will re-pull live from the regional master kit. Your personalised Proposal block and any blocks you specifically edited on this prospect kit will be preserved.`)) {
                    syncKitMutation.mutate({ id: selected.id });
                  }
                }}
                title="Re-inherit all unedited blocks from the master kit"
              >
                {syncKitMutation.isPending ? "Syncing…" : "Sync from master"}
              </button>
              {/* Kit source: shown for any prospect kit (auto-created share or customised clone). */}
              {/* If no clone yet, picking a region runs customise-kit with that region. If a clone exists, runs switch-kit-region. */}
              <div className="flex items-center gap-2 mt-1">
                <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground shrink-0">Kit source:</label>
                <select
                  className="input text-xs flex-1"
                  defaultValue={selected.kit_region || selected.region || ""}
                  disabled={switchKitRegionMutation.isPending || customiseKitMutation.isPending}
                  onChange={e => {
                    const newRegion = e.target.value;
                    if (!newRegion) return;
                    const current = selected.kit_region || selected.region;
                    if (newRegion === current) return;
                    const hasClone = !!selected.kit_label && /—/.test(selected.kit_label); // clones have "— Company" suffix
                    if (hasClone) {
                      if (confirm(`Switch this prospect's kit to be sourced from ${newRegion.toUpperCase()}?\n\nThe personalised Proposal block stays. All other content re-inherits from the new region's master.`)) {
                        switchKitRegionMutation.mutate({ id: selected.id, region: newRegion });
                      } else {
                        e.target.value = current || "";
                      }
                    } else {
                      if (confirm(`Build a personalised kit from the ${newRegion.toUpperCase()} master for this lead?`)) {
                        customiseKitMutation.mutate({ id: selected.id, region: newRegion });
                      } else {
                        e.target.value = current || "";
                      }
                    }
                  }}
                  title="Region to source this prospect's kit content from"
                >
                  <option value="">— Pick region —</option>
                  {REGIONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </div>
            </div>

            {/* Contact */}
            <Section title="Contact">
              <Row icon={<Mail className="w-3.5 h-3.5" />} label="Email">
                <a href={`mailto:${selected.email}`} className="text-[#e8312a] hover:underline">{selected.email}</a>
              </Row>
              {selected.role && <Row icon={<Tag className="w-3.5 h-3.5" />} label="Role">{selected.role}</Row>}
              <Row icon={<Building2 className="w-3.5 h-3.5" />} label="Company">
                {selected.company}{selected.company_type ? <span className="ml-2 px-2 py-0.5 rounded bg-zinc-700/40 text-[10px] uppercase font-bold">{COMPANY_TYPE_LABELS[selected.company_type]}</span> : null}
              </Row>
              <Row icon={<MapPin className="w-3.5 h-3.5" />} label="Country">
                {selected.country || "—"}
              </Row>
              <Row icon={<MapPin className="w-3.5 h-3.5" />} label="Notify region">
                <select
                  className="input text-xs w-full"
                  defaultValue={selected.region || ""}
                  onChange={e => {
                    const v = e.target.value;
                    updateMutation.mutate({ id: selected.id, patch: { region: v || null } });
                  }}
                  title="Which region team gets notified for this lead"
                >
                  <option value="">— None —</option>
                  {REGIONS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </Row>
            </Section>

            {/* Interests */}
            {selected.interests.length > 0 && (
              <Section title="Interested in">
                <div className="mt-1">
                  {selected.interests.map(i => (
                    <span key={i} className="interest-pill">{INTEREST_LABELS[i] || i}</span>
                  ))}
                </div>
              </Section>
            )}

            {/* Message */}
            {selected.message && (
              <Section title="Their message">
                <div className="text-sm text-foreground/90 whitespace-pre-wrap p-3 bg-zinc-500/5 rounded border border-border italic">
                  "{selected.message}"
                </div>
              </Section>
            )}

            {/* Kit tracking */}
            {selected.kit_slug && (
              <Section title="Media Kit tracking">
                <Row label="Kit">{selected.kit_label}</Row>
                <Row label="Views">{selected.kit_views || 0}</Row>
                {selected.kit_last_viewed && (
                  <Row label="Last viewed">{relTime(selected.kit_last_viewed)}</Row>
                )}
                <div className="mt-2 flex gap-2">
                  <button
                    className="btn btn-ghost text-xs"
                    onClick={() => {
                      if (selected.magic_link) {
                        navigator.clipboard.writeText(selected.magic_link);
                        toast({ title: "Magic link copied" });
                      }
                    }}
                  >
                    <Copy className="w-3 h-3" /> Copy magic link
                  </button>
                </div>
              </Section>
            )}

            {/* Proposal activity timeline */}
            {selected.kit_share_id && (
              <Section title="Proposal activity">
                {events.length === 0 ? (
                  <p className="text-xs text-muted-foreground italic">No activity yet. The timeline updates when the kit is sent, viewed, or actioned by the prospect.</p>
                ) : (
                  <div className="space-y-2 mt-1">
                    {events.map(ev => <EventRow key={ev.id} event={ev} />)}
                  </div>
                )}
              </Section>
            )}

            {/* Notes */}
            <Section title="Internal notes">
              <NotesEditor
                value={selected.notes || ""}
                onSave={notes => updateMutation.mutate({ id: selected.id, patch: { notes } })}
              />
            </Section>

            {/* Meta */}
            <Section title="Submission">
              <Row icon={<Clock className="w-3.5 h-3.5" />} label="Received">{fmtDate(selected.created_at)}</Row>
              {selected.referrer && <Row label="Referrer">{truncate(selected.referrer, 60)}</Row>}
              {selected.ip_address && <Row label="IP">{selected.ip_address}</Row>}
            </Section>

            {/* Delete */}
            <div className="pt-4 border-t border-border">
              <button
                className="btn btn-ghost text-red-400 hover:text-red-300"
                onClick={() => {
                  if (confirm(`Delete lead from ${selected.company}? This cannot be undone.`)) {
                    deleteMutation.mutate(selected.id);
                  }
                }}
              >
                <Trash2 className="w-3 h-3" />
                Delete lead
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Customise Media Kit — audience + region picker modal */}
      {customiseModalOpen && selected && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => setCustomiseModalOpen(false)}>
          <div className="bg-card border border-border rounded-lg p-5 w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-bold text-foreground mb-1">Customise Media Kit</h3>
            <p className="text-xs text-muted-foreground mb-4">Pick the audience and (for Trade) the source region. Pricing, currency, and inheritance follow this choice.</p>
            {selected.magic_link && (
              <div className="text-[11px] text-amber-300 bg-amber-300/10 border border-amber-300/30 rounded p-2 mb-3">
                A kit clone already exists for this lead. Changing audience will <strong>rebuild</strong> the clone (your personalised Proposal block content will be reset).
              </div>
            )}

            <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground block mb-1.5">Audience</label>
            <div className="flex gap-2 mb-4">
              <button
                type="button"
                className={`btn flex-1 ${customiseAudience === "trade" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setCustomiseAudience("trade")}
              >
                Trade (Brands & Distributors)
              </button>
              <button
                type="button"
                className={`btn flex-1 ${customiseAudience === "retailer" ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setCustomiseAudience("retailer")}
              >
                Retailer
              </button>
            </div>

            {customiseAudience === "trade" ? (
              <>
                <label className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground block mb-1.5">Source region</label>
                <select
                  className="input mb-4 w-full"
                  value={customiseRegion}
                  onChange={e => setCustomiseRegion(e.target.value)}
                  autoFocus
                >
                  {REGIONS.map(r => <option key={r.key} value={r.key}>{r.label}{selected.region === r.key ? " · lead's region" : ""}</option>)}
                </select>
              </>
            ) : (
              <p className="text-xs text-muted-foreground mb-4 px-1">Retailer kit is global — same content for all regions. Currency can be changed by the prospect on the kit.</p>
            )}

            <div className="flex justify-end gap-2 flex-wrap">
              <button className="btn btn-ghost text-xs" onClick={() => setCustomiseModalOpen(false)} disabled={customiseKitMutation.isPending}>Cancel</button>
              {selected.magic_link && (
                <button
                  className="btn btn-ghost text-xs"
                  disabled={customiseKitMutation.isPending}
                  onClick={() => {
                    customiseKitMutation.mutate({ id: selected.id });
                    setCustomiseModalOpen(false);
                  }}
                  title="Open the existing clone without changing audience"
                >
                  Open existing
                </button>
              )}
              <button
                className="btn btn-primary text-xs"
                disabled={customiseKitMutation.isPending || (customiseAudience === "trade" && !customiseRegion)}
                onClick={() => {
                  if (customiseAudience === "retailer") {
                    customiseKitMutation.mutate({ id: selected.id, audience: "retailer" });
                  } else {
                    customiseKitMutation.mutate({ id: selected.id, audience: "trade", region: customiseRegion });
                  }
                  setCustomiseModalOpen(false);
                }}
              >
                {customiseKitMutation.isPending ? "Building…" : (selected.magic_link ? "Rebuild kit" : "Build kit")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const EVENT_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  sent:               { label: "Kit sent to prospect",        color: "text-blue-300",   icon: "→" },
  first_viewed:       { label: "Prospect opened the kit",      color: "text-amber-300",  icon: "•" },
  accepted:           { label: "Proposal accepted",            color: "text-emerald-300",icon: "✓" },
  declined:           { label: "Proposal declined",            color: "text-red-300",    icon: "✕" },
  changes_requested:  { label: "Changes requested",            color: "text-orange-300", icon: "~" },
};

function EventRow({ event }: { event: ProposalEvent }) {
  const meta = EVENT_LABELS[event.event_type] || { label: event.event_type, color: "text-muted-foreground", icon: "•" };
  return (
    <div className="flex items-start gap-3 text-xs">
      <span className={`mt-0.5 ${meta.color} font-bold w-3 text-center`}>{meta.icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`font-medium ${meta.color}`}>{meta.label}</span>
          <span className="text-muted-foreground text-[10px]">{relTime(event.created_at)}</span>
        </div>
        {event.actor_name && <div className="text-foreground/70 text-[11px] mt-0.5">by {event.actor_name}{event.actor_email ? ` (${event.actor_email})` : ""}</div>}
        {event.message && (
          <div className="text-foreground/80 text-[11px] mt-1 p-2 bg-zinc-500/5 rounded border border-border/60 whitespace-pre-wrap">
            {event.message}
          </div>
        )}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-[10px] uppercase tracking-wider font-bold text-muted-foreground mb-2 pb-1 border-b border-border">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function Row({ icon, label, children }: { icon?: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {icon && <span className="text-muted-foreground mt-0.5">{icon}</span>}
      <span className="text-muted-foreground min-w-[70px] text-xs">{label}</span>
      <span className="text-foreground/90 flex-1 break-all">{children}</span>
    </div>
  );
}

function NotesEditor({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [text, setText] = useState(value);
  const [dirty, setDirty] = useState(false);
  React.useEffect(() => { setText(value); setDirty(false); }, [value]);
  return (
    <div className="space-y-2">
      <textarea
        className="input"
        rows={3}
        placeholder="Add internal notes…"
        value={text}
        onChange={e => { setText(e.target.value); setDirty(true); }}
        style={{ resize: "vertical", minHeight: "80px" }}
      />
      {dirty && (
        <button className="btn btn-primary text-xs" onClick={() => { onSave(text); setDirty(false); }}>
          Save notes
        </button>
      )}
    </div>
  );
}

function relTime(s: string): string {
  if (!s) return "";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

function fmtDate(s: string): string {
  if (!s) return "";
  const d = new Date(s.includes("T") ? s : s.replace(" ", "T") + "Z");
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
