import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Trash2, UserPlus, Shield, User, KeyRound, FileText, LogIn, Ban, Undo2, RefreshCw, ScrollText, Flag, X, BookCheck, Pin, CheckCircle2, Sparkles, Settings, Eye, EyeOff, Copy, Check, Webhook, Mail, Cpu, BarChart3, Wand2, Zap } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface UserRow {
  id: number;
  username: string;
  role: string;
  created_at: string;
  last_login: string | null;
  redline_access: number;
  pitch_access: "none" | "view" | "edit" | "admin";
  email: string;
  full_name: string;
  notify_regions: string;
}

const NOTIFY_REGIONS_OPTIONS: { key: string; label: string }[] = [
  { key: "anz",    label: "ANZ" },
  { key: "uk_eu",  label: "UK & EU" },
  { key: "na",     label: "North America" },
  { key: "asia",   label: "Asia" },
  { key: "global", label: "Global / Other" },
];

type AdminTab = "users" | "settings" | "top-picks" | "learning" | "audit";

const ADMIN_TABS: { key: AdminTab; label: string; icon: any; description: string }[] = [
  { key: "users",     label: "Users",            icon: Shield,    description: "User management & permissions" },
  { key: "settings",  label: "Settings",         icon: Settings,  description: "Runtime config, API keys, webhooks" },
  { key: "top-picks", label: "Top Picks",        icon: Sparkles,  description: "AI-curated write-worthy stories" },
  { key: "learning",  label: "Irrelevant Learning", icon: Ban,    description: "Dismissed keywords & patterns" },
  { key: "audit",     label: "Discovery Audit",  icon: ScrollText, description: "Activity log for Article Discovery" },
];

export default function Admin() {
  const [activeTab, setActiveTab] = useState<AdminTab>(() => {
    // Persist last-viewed tab in localStorage. Guard against stale values from deleted tabs.
    const validKeys = ADMIN_TABS.map(t => t.key);
    try {
      const stored = localStorage.getItem("admin.tab") as AdminTab;
      return validKeys.includes(stored) ? stored : "users";
    } catch { return "users"; }
  });
  const handleTabChange = (t: AdminTab) => {
    setActiveTab(t);
    try { localStorage.setItem("admin.tab", t); } catch {}
  };

  return (
    <div className="flex h-full bg-background">
      {/* Sidebar navigation */}
      <nav className="w-60 shrink-0 border-r border-border bg-card/30 p-4 overflow-y-auto">
        <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3 px-2">Admin</div>
        <ul className="space-y-1">
          {ADMIN_TABS.map(tab => {
            const Icon = tab.icon;
            const active = activeTab === tab.key;
            return (
              <li key={tab.key}>
                <button
                  onClick={() => handleTabChange(tab.key)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                    active
                      ? "bg-[#e8312a]/15 text-[#e8312a] font-semibold"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/40"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {tab.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Main tab content */}
      <main className="flex-1 overflow-y-auto">
        <div className="p-6 max-w-4xl">
          {(() => {
            const meta = ADMIN_TABS.find(t => t.key === activeTab)!;
            const Icon = meta.icon;
            return (
              <header className="mb-6 pb-4 border-b border-border/40">
                <h1 className="text-xl font-bold text-foreground flex items-center gap-2">
                  <Icon className="w-5 h-5 text-[#e8312a]" />
                  {meta.label}
                </h1>
                <p className="text-sm text-muted-foreground mt-1">{meta.description}</p>
              </header>
            );
          })()}

          {activeTab === "users"     && <UsersTab />}
          {activeTab === "settings"  && <SettingsPanel />}
          {activeTab === "top-picks" && <TopPicksSettingsPanel />}
          {activeTab === "learning"  && <IrrelevantLearningPanel />}
          {activeTab === "audit"     && <DiscoveryAuditPanel />}
        </div>
      </main>
    </div>
  );
}

// ─── Users tab ───────────────────────────────────────────────────────────────────
function UsersTab() {
  const [newUser, setNewUser] = useState("");
  const [newPass, setNewPass] = useState("");
  const [newRole, setNewRole] = useState("user");
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: users = [], isLoading } = useQuery<UserRow[]>({
    queryKey: ["/api/admin/users"],
    queryFn: () => apiRequest("GET", "/api/admin/users").then(r => r.json()),
  });

  const addMutation = useMutation({
    mutationFn: (data: { username: string; password: string; role: string }) =>
      apiRequest("POST", "/api/admin/users", data).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/users"] });
      setNewUser("");
      setNewPass("");
      setNewRole("user");
      toast({ title: "User added" });
    },
    onError: () => toast({ title: "Failed to add user", variant: "destructive" }),
  });

  const resetPassMutation = useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      apiRequest("PATCH", `/api/admin/users/${id}/password`, { password }).then(r => r.json()),
    onSuccess: () => {
      toast({ title: "Password updated" });
    },
    onError: () => toast({ title: "Failed to update password", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("DELETE", `/api/admin/users/${id}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "User deleted" });
    },
    onError: () => toast({ title: "Failed to delete user", variant: "destructive" }),
  });

  const impersonateMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("POST", `/api/admin/impersonate/${id}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/me"] });
      qc.invalidateQueries({ queryKey: ["/api/author-stats"] });
      qc.invalidateQueries({ queryKey: ["/api/my-articles"] });
      toast({ title: "Viewing as user" });
      window.location.hash = "/";
    },
    onError: () => toast({ title: "Failed to impersonate", variant: "destructive" }),
  });

  const redlineMutation = useMutation({
    mutationFn: ({ id, access }: { id: number; access: boolean }) =>
      apiRequest("PATCH", `/api/admin/users/${id}/redline`, { access }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Redline access updated" });
    },
    onError: () => toast({ title: "Failed to update Redline access", variant: "destructive" }),
  });

  const pitchMutation = useMutation({
    mutationFn: ({ id, level }: { id: number; level: UserRow["pitch_access"] }) =>
      apiRequest("PATCH", `/api/admin/users/${id}/pitch`, { level }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "PITCH access updated" });
    },
    onError: () => toast({ title: "Failed to update PITCH access", variant: "destructive" }),
  });

  const notifyEmailMutation = useMutation({
    mutationFn: ({ id, email }: { id: number; email: string }) =>
      apiRequest("PATCH", `/api/admin/users/${id}/email`, { email }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Notification email updated" });
    },
    onError: () => toast({ title: "Failed to update email", variant: "destructive" }),
  });

  const fullNameMutation = useMutation({
    mutationFn: ({ id, full_name }: { id: number; full_name: string }) =>
      apiRequest("PATCH", `/api/admin/users/${id}/full-name`, { full_name }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Display name updated" });
    },
    onError: () => toast({ title: "Failed to update name", variant: "destructive" }),
  });

  const notifyRegionsMutation = useMutation({
    mutationFn: ({ id, notify_regions }: { id: number; notify_regions: string }) =>
      apiRequest("PATCH", `/api/admin/users/${id}/notify-regions`, { notify_regions }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/users"] });
      toast({ title: "Lead notification regions updated" });
    },
    onError: () => toast({ title: "Failed to update regions", variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
        {/* Add user form */}
        <Card className="border border-[#e8312a]/30">
          <CardHeader className="pb-3 pt-4 px-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <UserPlus className="w-4 h-4 text-[#e8312a]" />
              Add User
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <form
              onSubmit={e => {
                e.preventDefault();
                if (newUser && newPass) addMutation.mutate({ username: newUser, password: newPass, role: newRole });
              }}
              className="flex items-end gap-3 flex-wrap"
            >
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-muted-foreground block mb-1">Email</label>
                <input
                  type="email"
                  value={newUser}
                  onChange={e => setNewUser(e.target.value)}
                  placeholder="user@stereonet.com"
                  required
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-[#e8312a] transition-colors"
                />
              </div>
              <div className="w-44">
                <label className="text-xs text-muted-foreground block mb-1">Password</label>
                <input
                  type="text"
                  value={newPass}
                  onChange={e => setNewPass(e.target.value)}
                  placeholder="password"
                  required
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-[#e8312a] transition-colors"
                />
              </div>
              <div className="w-28">
                <label className="text-xs text-muted-foreground block mb-1">Role</label>
                <select
                  value={newRole}
                  onChange={e => setNewRole(e.target.value)}
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-[#e8312a] transition-colors"
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <button
                type="submit"
                disabled={addMutation.isPending}
                className="px-4 py-2 bg-[#e8312a] text-white rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {addMutation.isPending ? "Adding..." : "Add User"}
              </button>
            </form>
          </CardContent>
        </Card>

        {/* User list */}
        <Card>
          <CardHeader className="pb-3 pt-4 px-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <User className="w-4 h-4 text-muted-foreground" />
              Users ({users.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : (
              <div className="space-y-2">
                {users.map(user => (
                  <div key={user.id} className="py-3 px-4 rounded-lg bg-muted/40">
                    <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                        user.role === "admin" ? "bg-[#e8312a] text-white" : "bg-muted text-muted-foreground"
                      }`}>
                        {user.role === "admin" ? "A" : "U"}
                      </span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{user.username}</span>
                          <Badge variant="outline" className="text-[10px] py-0">{user.role}</Badge>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {user.last_login
                            ? `Last login: ${new Date(user.last_login + "Z").toLocaleString("en-AU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`
                            : "Never logged in"}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => impersonateMutation.mutate(user.id)}
                        className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium bg-muted text-muted-foreground hover:text-foreground hover:bg-muted/80 transition-colors"
                        title={`View dashboard as ${user.username.split('@')[0]}`}
                      >
                        <LogIn className="w-3 h-3" />
                        Login as
                      </button>
                      <button
                        onClick={() => redlineMutation.mutate({ id: user.id, access: !user.redline_access })}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-colors ${
                          user.role === "admin" || user.redline_access
                            ? "bg-[#e8312a]/15 text-[#e8312a]"
                            : "bg-muted text-muted-foreground hover:text-foreground"
                        }`}
                        title={user.role === "admin" ? "Admins always have Redline access" : "Toggle Redline access"}
                        disabled={user.role === "admin"}
                      >
                        <FileText className="w-3 h-3" />
                        Redline
                      </button>
                      <div
                        className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                          user.role === "admin" || user.pitch_access === "admin"
                            ? "bg-[#e8312a]/15 text-[#e8312a]"
                            : user.pitch_access && user.pitch_access !== "none"
                              ? "bg-[#e8312a]/10 text-[#e8312a]"
                              : "bg-muted text-muted-foreground"
                        }`}
                        title={user.role === "admin" ? "Admins always have PITCH admin access" : "PITCH access level"}
                      >
                        <Zap className="w-3 h-3" />
                        <span>PITCH</span>
                        <select
                          value={user.role === "admin" ? "admin" : (user.pitch_access || "none")}
                          disabled={user.role === "admin"}
                          onChange={e => pitchMutation.mutate({ id: user.id, level: e.target.value as UserRow["pitch_access"] })}
                          className="bg-transparent outline-none border-none text-[10px] font-medium pl-0.5 pr-0 cursor-pointer disabled:cursor-not-allowed disabled:opacity-70"
                          style={{ colorScheme: "dark" }}
                        >
                          <option value="none">None — no access</option>
                          <option value="edit">Manager — generate, send, respond</option>
                          <option value="admin">Admin — full access incl. customise</option>
                        </select>
                      </div>
                      <button
                        onClick={() => {
                          const pw = prompt(`Set new password for ${user.username}:`);
                          if (pw) resetPassMutation.mutate({ id: user.id, password: pw });
                        }}
                        className="text-muted-foreground hover:text-foreground transition-colors" title="Reset password"
                      >
                        <KeyRound className="w-3.5 h-3.5" />
                      </button>
                      {user.username !== "marcrushton@stereonet.com" && (
                        <button
                          onClick={() => { if (confirm(`Delete ${user.username}?`)) deleteMutation.mutate(user.id); }}
                          className="text-muted-foreground hover:text-red-400 transition-colors" title="Delete user"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    </div>
                    {/* Lead notifications row */}
                    <div className="mt-3 pt-3 border-t border-border/40 flex items-center gap-3 flex-wrap text-[11px]">
                      <div className="flex items-center gap-2">
                        <span className="text-muted-foreground">Display name:</span>
                        <input
                          type="text"
                          defaultValue={user.full_name || ""}
                          placeholder="e.g. Marc Rushton"
                          onBlur={e => {
                            const v = e.target.value.trim();
                            if (v !== (user.full_name || "")) fullNameMutation.mutate({ id: user.id, full_name: v });
                          }}
                          className="px-2 py-1 bg-muted border border-border rounded text-[11px] text-foreground outline-none focus:border-[#e8312a] transition-colors w-44"
                          title="Used as the From-name on prospect emails you send (e.g. Quick Send / Send Kit)"
                        />
                      </div>
                      <div className="flex items-center gap-2">
                        <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-muted-foreground">Notify email:</span>
                        <input
                          type="email"
                          defaultValue={user.email || ""}
                          placeholder={user.username.includes("@") ? user.username : "name@stereonet.com"}
                          onBlur={e => {
                            const v = e.target.value.trim();
                            if (v !== (user.email || "")) notifyEmailMutation.mutate({ id: user.id, email: v });
                          }}
                          className="px-2 py-1 bg-muted border border-border rounded text-[11px] text-foreground outline-none focus:border-[#e8312a] transition-colors w-56"
                        />
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-muted-foreground">Lead regions:</span>
                        <button
                          onClick={() => notifyRegionsMutation.mutate({ id: user.id, notify_regions: user.notify_regions === "all" ? "" : "all" })}
                          className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${user.notify_regions === "all" ? "bg-[#e8312a] text-white" : "bg-muted text-muted-foreground hover:text-foreground"}`}
                          title="Receive notifications for every region"
                        >
                          All
                        </button>
                        {NOTIFY_REGIONS_OPTIONS.map(opt => {
                          const cur = user.notify_regions === "all" ? new Set(NOTIFY_REGIONS_OPTIONS.map(o => o.key)) : new Set((user.notify_regions || "").split(",").map(s => s.trim()).filter(Boolean));
                          const on = cur.has(opt.key);
                          const disabled = user.notify_regions === "all";
                          return (
                            <button
                              key={opt.key}
                              disabled={disabled}
                              onClick={() => {
                                const next = new Set(cur);
                                if (on) next.delete(opt.key); else next.add(opt.key);
                                const csv = Array.from(next).join(",");
                                notifyRegionsMutation.mutate({ id: user.id, notify_regions: csv });
                              }}
                              className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${on ? "bg-[#e8312a]/20 text-[#e8312a]" : "bg-muted text-muted-foreground hover:text-foreground"} ${disabled ? "opacity-50 cursor-not-allowed" : ""}`}
                              title={disabled ? "Disable 'All' to pick individual regions" : `Toggle ${opt.label}`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                        {(!user.notify_regions || user.notify_regions === "") && (
                          <span className="text-[10px] text-muted-foreground/70 italic">Not receiving lead notifications</span>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

    </div>
  );
}

// ─── Discovery audit log ───────────────────────────────────────────────────────────────
function TopPicksSettingsPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: settings } = useQuery<{ enabled: boolean }>({
    queryKey: ["/api/settings/top-picks"],
    queryFn: () => apiRequest("GET", "/api/settings/top-picks").then(r => r.json()),
  });

  const { data: picksData, refetch: refetchPicks } = useQuery<{
    enabled: boolean;
    generatedAt?: string | null;
    examined?: number;
    picks?: Array<{ articleId: number; title: string; site: string; score: number }>;
  }>({
    queryKey: ["/api/top-picks"],
    queryFn: () => apiRequest("GET", "/api/top-picks").then(r => r.json()),
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      apiRequest("POST", "/api/settings/top-picks", { enabled }).then(r => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/settings/top-picks"] });
      qc.invalidateQueries({ queryKey: ["/api/top-picks"] });
      toast({ title: data.enabled ? "Top Picks enabled" : "Top Picks disabled" });
    },
  });

  const generateMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/top-picks/generate").then(r => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/top-picks"] });
      refetchPicks();
      const count = Array.isArray(data?.picks) ? data.picks.length : 0;
      toast({ title: `Generated ${count} picks`, description: `Examined ${data?.examined || 0} candidates` });
    },
    onError: (e: any) => toast({ title: "Generation failed", description: e.message, variant: "destructive" }),
  });

  const enabled = settings?.enabled ?? true;
  const generatedAt = picksData?.generatedAt ? new Date(picksData.generatedAt) : null;

  return (
    <Card>
      <CardHeader className="pb-3 pt-4 px-5">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            Top Picks Today
            <span className="text-[10px] font-normal text-muted-foreground">AI-curated daily shortlist</span>
          </CardTitle>
          <label className="flex items-center gap-2 cursor-pointer">
            <span className="text-xs text-muted-foreground">{enabled ? "On" : "Off"}</span>
            <div className="relative">
              <input
                type="checkbox"
                checked={enabled}
                onChange={e => toggleMutation.mutate(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-muted rounded-full peer-checked:bg-amber-500 transition-colors" />
              <div className="absolute top-0.5 left-0.5 w-4 h-4 bg-background rounded-full transition-transform peer-checked:translate-x-4" />
            </div>
          </label>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5 space-y-3">
        <div className="text-xs text-muted-foreground leading-relaxed">
          Every morning between 5am and 9am AEST, Claude scans Active articles and surfaces the 3 most write-worthy stories with a rationale and suggested angle. Shown at the top of Article Discovery when enabled.
        </div>
        {enabled && (
          <div className="flex items-center justify-between gap-4 pt-2 border-t border-border/40">
            <div className="text-xs">
              {generatedAt ? (
                <span className="text-muted-foreground">
                  Latest: <span className="text-foreground">{picksData?.picks?.length || 0} picks</span> from {picksData?.examined || 0} candidates · {generatedAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              ) : (
                <span className="text-muted-foreground italic">No picks generated yet today</span>
              )}
            </div>
            <button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border border-amber-500/30 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${generateMutation.isPending ? "animate-spin" : ""}`} />
              {generateMutation.isPending ? "Generating…" : "Generate now"}
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DiscoveryAuditPanel() {
  const [actionFilter, setActionFilter] = useState<string>("");
  const [userFilter, setUserFilter] = useState<string>("");

  const { data: entries = [], isFetching } = useQuery<{
    id: number;
    username: string;
    action: string;
    article_id: number | null;
    article_title: string | null;
    article_site: string | null;
    detail: string | null;
    created_at: string;
  }[]>({
    queryKey: ["/api/discovery-audit", actionFilter, userFilter],
    queryFn: () => {
      const p = new URLSearchParams({ limit: "500" });
      if (actionFilter) p.set("action", actionFilter);
      if (userFilter) p.set("username", userFilter);
      return apiRequest("GET", `/api/discovery-audit?${p.toString()}`).then(r => r.json());
    },
    refetchInterval: 30000,
  });

  const relTime = (iso: string) => {
    if (!iso) return "";
    const d = new Date(iso);
    const diff = Math.round((Date.now() - d.getTime()) / 60000);
    if (diff <= 0) return "now";
    if (diff < 60) return `${diff}m ago`;
    if (diff < 1440) return `${Math.round(diff / 60)}h ago`;
    return `${Math.round(diff / 1440)}d ago`;
  };

  const ACTION_ICONS: Record<string, { icon: any; color: string; label: string }> = {
    claim: { icon: <Flag className="w-3 h-3" />, color: "#eab308", label: "Claimed" },
    unclaim: { icon: <Flag className="w-3 h-3" />, color: "#6b7280", label: "Unclaimed" },
    published: { icon: <CheckCircle2 className="w-3 h-3" />, color: "#10b981", label: "Published" },
    dismiss: { icon: <X className="w-3 h-3" />, color: "#ef4444", label: "Dismissed" },
    undismiss: { icon: <Undo2 className="w-3 h-3" />, color: "#10b981", label: "Undismissed" },
    irrelevant: { icon: <Ban className="w-3 h-3" />, color: "#f97316", label: "Irrelevant" },
    undo_irrelevant: { icon: <Undo2 className="w-3 h-3" />, color: "#10b981", label: "Undo irrelevant" },
    pin: { icon: <Pin className="w-3 h-3" />, color: "#e8312a", label: "Pinned" },
    unpin: { icon: <Pin className="w-3 h-3" />, color: "#6b7280", label: "Unpinned" },
    covered: { icon: <BookCheck className="w-3 h-3" />, color: "#10b981", label: "Covered" },
  };

  const actions = ["", "claim", "unclaim", "dismiss", "undismiss", "irrelevant", "undo_irrelevant", "published", "pin", "unpin"];

  return (
    <Card>
      <CardHeader className="pb-3 pt-4 px-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <ScrollText className="w-4 h-4 text-indigo-400" />
            Discovery Activity Log
            {isFetching && <RefreshCw className="w-3 h-3 animate-spin text-muted-foreground" />}
          </CardTitle>
          <div className="flex items-center gap-2 text-xs">
            <select
              value={actionFilter}
              onChange={e => setActionFilter(e.target.value)}
              className="px-2 py-1 bg-muted border border-border rounded-md text-xs text-foreground outline-none focus:border-indigo-400 transition-colors"
            >
              {actions.map(a => (
                <option key={a} value={a}>{a ? (ACTION_ICONS[a]?.label || a) : "All actions"}</option>
              ))}
            </select>
            <input
              type="text"
              value={userFilter}
              onChange={e => setUserFilter(e.target.value)}
              placeholder="Filter by user email"
              className="px-2 py-1 w-52 bg-muted border border-border rounded-md text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-indigo-400 transition-colors"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5">
        {entries.length === 0 ? (
          <div className="text-xs text-muted-foreground italic py-6 text-center">No activity yet</div>
        ) : (
          <div className="space-y-0.5 max-h-[420px] overflow-y-auto">
            {entries.map(e => {
              const spec = ACTION_ICONS[e.action] || { icon: <ScrollText className="w-3 h-3" />, color: "#6b7280", label: e.action };
              return (
                <div
                  key={e.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted/30 text-xs transition-colors"
                >
                  <div
                    className="w-5 h-5 rounded-full flex items-center justify-center shrink-0"
                    style={{ background: spec.color + "1a", color: spec.color }}
                  >
                    {spec.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-foreground">{e.username.split("@")[0]}</span>
                      <span className="text-muted-foreground">{spec.label.toLowerCase()}</span>
                      {e.article_title && (
                        <span className="text-foreground/90 truncate max-w-md">“{e.article_title}”</span>
                      )}
                      {e.detail && (
                        <span className="text-[10px] text-muted-foreground italic">({e.detail})</span>
                      )}
                    </div>
                    {e.article_site && (
                      <div className="text-[10px] text-muted-foreground">{e.article_site} · article #{e.article_id}</div>
                    )}
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">{relTime(e.created_at)}</span>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Irrelevant Learning management ──────────────────────────────────────────────────────────
function IrrelevantLearningPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: blocked = [] } = useQuery<{ id: number; keyword: string; source: string; hit_count: number; created_at: string }[]>({
    queryKey: ["/api/blocked-keywords"],
    queryFn: () => apiRequest("GET", "/api/blocked-keywords").then(r => r.json()),
  });

  const { data: marks = [] } = useQuery<{ article_id: number; title: string; site: string; username: string; marked_at: string }[]>({
    queryKey: ["/api/irrelevant-marks"],
    queryFn: () => apiRequest("GET", "/api/irrelevant-marks").then(r => r.json()),
  });

  const unblockMutation = useMutation({
    mutationFn: (id: number) => apiRequest("DELETE", `/api/blocked-keywords/${id}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/blocked-keywords"] });
      qc.invalidateQueries({ queryKey: ["/api/discovery"] });
      toast({ title: "Keyword unblocked" });
    },
  });

  const undoMarkMutation = useMutation({
    mutationFn: (articleId: number) => apiRequest("DELETE", `/api/irrelevant/${articleId}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/irrelevant-marks"] });
      qc.invalidateQueries({ queryKey: ["/api/irrelevant"] });
      qc.invalidateQueries({ queryKey: ["/api/dismissals"] });
      qc.invalidateQueries({ queryKey: ["/api/discovery"] });
      toast({ title: "Mark removed" });
    },
  });

  const rebuildMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/irrelevant/rebuild-keywords").then(r => r.json()),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ["/api/blocked-keywords"] });
      qc.invalidateQueries({ queryKey: ["/api/discovery"] });
      toast({ title: `Rebuilt: ${data.removedLearnedKeywords} keywords removed` });
    },
  });

  const relTime = (iso: string) => {
    const d = new Date(iso.endsWith("Z") ? iso : iso.replace(" ", "T") + "Z");
    const diff = Math.round((Date.now() - d.getTime()) / 60000);
    if (diff < 60) return `${diff}m ago`;
    if (diff < 1440) return `${Math.round(diff / 60)}h ago`;
    return `${Math.round(diff / 1440)}d ago`;
  };

  return (
    <Card>
      <CardHeader className="pb-3 pt-4 px-5">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Ban className="w-4 h-4 text-orange-400" />
            Irrelevant Learning
          </CardTitle>
          <button
            onClick={() => rebuildMutation.mutate()}
            disabled={rebuildMutation.isPending}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-muted hover:bg-muted/70 text-foreground transition-colors disabled:opacity-50"
            title="Recomputes blocked keywords from current irrelevant marks. Removes learned keywords whose count has dropped below threshold."
          >
            <RefreshCw className={`w-3 h-3 ${rebuildMutation.isPending ? "animate-spin" : ""}`} />
            Rebuild keywords
          </button>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-5 space-y-5">
        {/* Blocked keywords */}
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-2">
            Blocked keywords ({blocked.length})
          </div>
          {blocked.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">No keywords blocked</div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {blocked.map(b => (
                <div
                  key={b.id}
                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-orange-500/10 border border-orange-400/25 text-xs text-foreground group"
                >
                  <span className="font-medium">{b.keyword}</span>
                  <span className="text-[10px] text-muted-foreground">({b.source})</span>
                  <button
                    onClick={() => unblockMutation.mutate(b.id)}
                    className="ml-1 text-muted-foreground hover:text-red-400 transition-colors"
                    title="Unblock this keyword"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Recent irrelevant marks */}
        <div>
          <div className="text-xs font-semibold text-muted-foreground mb-2">
            Recent marks ({marks.length})
          </div>
          {marks.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">No articles marked irrelevant</div>
          ) : (
            <div className="space-y-1 max-h-80 overflow-y-auto">
              {marks.slice(0, 50).map(m => (
                <div
                  key={m.article_id}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-muted/30 text-xs"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-foreground truncate">{m.title}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {m.site} · {m.username.split("@")[0]} · {relTime(m.marked_at)}
                    </div>
                  </div>
                  <button
                    onClick={() => undoMarkMutation.mutate(m.article_id)}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-emerald-400 hover:bg-emerald-500/10 transition-colors shrink-0"
                    title="Undo this mark and restore the article"
                  >
                    <Undo2 className="w-3 h-3" />
                    Undo
                  </button>
                </div>
              ))}
              {marks.length > 50 && (
                <div className="text-[10px] text-muted-foreground text-center pt-2">
                  Showing 50 of {marks.length}
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Runtime Settings panel ──────────────────────────────────────────────────────────────────
// Edit Pulse config (Microsoft Graph, webhook tokens, API keys etc.) from the
// browser. Changes save to the app_settings DB table and take effect on the next
// request — no container restart, no .env edits.
interface SettingDef {
  key: string;
  label: string;
  group: "webhook" | "email" | "ai" | "analytics" | "realtime" | "misc";
  secret: boolean;
  description?: string;
  autoGenerate?: boolean;
  value: string;           // masked if secret
  isSet: boolean;
  source: "db" | "env" | "unset";
}

const GROUP_META: Record<SettingDef["group"], { label: string; icon: any; colour: string }> = {
  webhook:   { label: "Webhook ingest",      icon: Webhook,   colour: "text-blue-400" },
  email:     { label: "Microsoft Graph email", icon: Mail,     colour: "text-purple-400" },
  ai:        { label: "AI (Anthropic)",      icon: Cpu,       colour: "text-emerald-400" },
  realtime:  { label: "Realtime (Ably)",     icon: Zap,       colour: "text-yellow-400" },
  analytics: { label: "Analytics",           icon: BarChart3, colour: "text-amber-400" },
  misc:      { label: "Other",               icon: Settings,  colour: "text-muted-foreground" },
};

function SettingsPanel() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [generatedToken, setGeneratedToken] = useState<{ key: string; value: string } | null>(null);

  const { data, isLoading } = useQuery<{ settings: SettingDef[] }>({
    queryKey: ["/api/admin/settings"],
    queryFn: () => apiRequest("GET", "/api/admin/settings").then(r => r.json()),
  });

  const saveMutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      apiRequest("POST", "/api/admin/settings", { key, value }).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/admin/settings"] });
      toast({ title: "Saved" });
    },
    onError: (err: any) => toast({ title: "Save failed", description: err?.message, variant: "destructive" }),
  });

  const generateMutation = useMutation({
    mutationFn: (key: string) =>
      apiRequest("POST", "/api/admin/settings/generate", { key }).then(r => r.json()),
    onSuccess: (data: { key: string; value: string }) => {
      qc.invalidateQueries({ queryKey: ["/api/admin/settings"] });
      setGeneratedToken(data);
      toast({ title: "New token generated" });
    },
    onError: (err: any) => toast({ title: "Generate failed", description: err?.message || "Check admin permissions", variant: "destructive" }),
  });

  const settings = data?.settings || [];
  const grouped: Record<string, SettingDef[]> = {};
  for (const s of settings) {
    if (!grouped[s.group]) grouped[s.group] = [];
    grouped[s.group].push(s);
  }

  const handleSave = (key: string, value: string) => saveMutation.mutate({ key, value });
  const handleClear = (key: string) => saveMutation.mutate({ key, value: "" });
  const handleGenerate = (key: string) => generateMutation.mutate(key);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings className="w-5 h-5 text-blue-400" />
          Runtime Settings
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Edit credentials, API keys, and service config without restarting the container. Changes apply on the next request. Values set here override any matching .env value.
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="space-y-6">
            {Object.entries(grouped).map(([groupKey, items]) => {
              const meta = GROUP_META[groupKey as SettingDef["group"]];
              const Icon = meta.icon;
              return (
                <div key={groupKey}>
                  <div className="flex items-center gap-2 mb-3 pb-2 border-b border-border/40">
                    <Icon className={`w-4 h-4 ${meta.colour}`} />
                    <h3 className="text-sm font-semibold text-foreground">{meta.label}</h3>
                  </div>
                  <div className="space-y-3">
                    {items.map(s => (
                      <SettingRow
                        key={s.key}
                        setting={s}
                        onSave={handleSave}
                        onClear={handleClear}
                        onGenerate={handleGenerate}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* Modal showing freshly-generated token — user can copy it before it's masked */}
      {generatedToken && (
        <GeneratedTokenModal
          token={generatedToken}
          onClose={() => setGeneratedToken(null)}
        />
      )}
    </Card>
  );
}

function GeneratedTokenModal({ token, onClose }: { token: { key: string; value: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(token.value); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-card border border-emerald-500/30 rounded-xl max-w-md w-full p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-3">
          <Wand2 className="w-5 h-5 text-emerald-400" />
          <h3 className="text-base font-bold text-foreground">New token generated</h3>
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Copy this now — you can still reveal it later via the Eye button, but this is the best time to save it.
        </p>
        <div className="bg-muted/40 border border-border rounded-md p-3 mb-4">
          <div className="text-[10px] text-muted-foreground mb-1 uppercase tracking-wide">{token.key}</div>
          <code className="text-sm font-mono text-emerald-300 break-all">{token.value}</code>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={copy}
            className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 text-sm font-semibold transition-colors"
          >
            {copied ? <><Check className="w-4 h-4" /> Copied</> : <><Copy className="w-4 h-4" /> Copy to clipboard</>}
          </button>
          <button onClick={onClose} className="px-4 py-2 rounded-md bg-muted/40 hover:bg-muted/60 text-muted-foreground text-sm">Close</button>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  setting,
  onSave,
  onClear,
  onGenerate,
}: {
  setting: SettingDef;
  onSave: (key: string, value: string) => void;
  onClear: (key: string) => void;
  onGenerate: (key: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [showDraft, setShowDraft] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  const reveal = async () => {
    const r = await apiRequest("GET", `/api/admin/settings/reveal?key=${encodeURIComponent(setting.key)}`);
    const data = await r.json();
    setRevealed(data.value || "");
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: "Clipboard blocked", variant: "destructive" });
    }
  };

  const startEdit = () => { setEditing(true); setDraft(""); };
  const cancelEdit = () => { setEditing(false); setDraft(""); };
  const save = () => { onSave(setting.key, draft.trim()); setEditing(false); setDraft(""); };

  // What to display in the value pill
  const displayValue = setting.isSet
    ? (setting.secret ? (revealed ?? setting.value) : setting.value)
    : "(not set)";

  const sourceLabel = setting.source === "db" ? "UI" : setting.source === "env" ? ".env" : "—";
  const sourceColour = setting.source === "db"
    ? "bg-blue-500/15 text-blue-300 border-blue-500/30"
    : setting.source === "env"
      ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
      : "bg-muted/30 text-muted-foreground border-border/30";

  return (
    <div className="rounded-md border border-border/50 p-3 bg-card/50">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold text-foreground">{setting.label}</span>
            <code className="text-[10px] text-muted-foreground bg-muted/30 px-1.5 py-0.5 rounded">{setting.key}</code>
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${sourceColour}`}>
              {sourceLabel}
            </span>
          </div>
          {setting.description && (
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{setting.description}</p>
          )}
        </div>
      </div>

      {editing ? (
        <div className="flex items-center gap-2">
          <input
            type={setting.secret && !showDraft ? "password" : "text"}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") cancelEdit(); }}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={setting.secret ? "Paste new value" : "Enter value"}
            className="flex-1 min-w-0 text-sm font-mono bg-background border border-border rounded-md px-3 py-1.5 outline-none focus:border-blue-500/60"
          />
          {setting.secret && (
            <button
              type="button"
              onClick={() => setShowDraft(v => !v)}
              className="text-xs p-1.5 rounded-md hover:bg-muted/40 text-muted-foreground"
              title={showDraft ? "Hide" : "Show"}
            >
              {showDraft ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            onClick={save}
            disabled={!draft.trim()}
            className="text-xs font-semibold px-3 py-1.5 rounded-md bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/30 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Save
          </button>
          <button
            onClick={cancelEdit}
            className="text-xs px-3 py-1.5 rounded-md bg-muted/40 hover:bg-muted/60 text-muted-foreground"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="flex-1 min-w-0 text-xs font-mono bg-background border border-border/50 rounded px-2 py-1.5 truncate">
            {displayValue}
          </code>
          {setting.secret && setting.isSet && (
            <button
              onClick={() => revealed ? setRevealed(null) : reveal()}
              className="text-xs p-1.5 rounded-md hover:bg-muted/40 text-muted-foreground"
              title={revealed ? "Hide" : "Reveal"}
            >
              {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
            </button>
          )}
          {setting.isSet && (
            <button
              onClick={() => copy(revealed || setting.value)}
              className="text-xs p-1.5 rounded-md hover:bg-muted/40 text-muted-foreground"
              title="Copy"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
          )}
          <button
            onClick={startEdit}
            className="text-xs font-semibold px-2.5 py-1.5 rounded-md bg-blue-500/15 hover:bg-blue-500/25 text-blue-300 border border-blue-500/30"
          >
            {setting.isSet ? "Edit" : "Set"}
          </button>
          {setting.autoGenerate && (
            <button
              onClick={() => onGenerate(setting.key)}
              className="text-xs font-semibold px-2.5 py-1.5 rounded-md bg-purple-500/15 hover:bg-purple-500/25 text-purple-300 border border-purple-500/30 flex items-center gap-1"
              title="Generate a new random token"
            >
              <Wand2 className="w-3 h-3" />
              {setting.isSet ? "Regenerate" : "Generate"}
            </button>
          )}
          {setting.source === "db" && (
            <button
              onClick={() => onClear(setting.key)}
              className="text-xs p-1.5 rounded-md hover:bg-red-500/15 text-muted-foreground hover:text-red-400"
              title="Clear UI override and fall back to .env"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

