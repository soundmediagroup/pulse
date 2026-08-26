import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Trash2, Plus, Pencil, Globe, Check, X, ToggleLeft, ToggleRight, BarChart3 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

interface TrackedSite {
  id: number;
  site_key: string;
  label: string;
  rss_url: string;
  site_url: string | null;
  color: string;
  enabled: number;
  exclude_velocity: number;
  created_at: string;
}

const DEFAULT_COLOR = "#6b7280";

export default function Sites() {
  const { toast } = useToast();
  const qc = useQueryClient();

  // Add form state
  const [addKey, setAddKey] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [addRss, setAddRss] = useState("");
  const [addSiteUrl, setAddSiteUrl] = useState("");
  const [addColor, setAddColor] = useState(DEFAULT_COLOR);

  // Edit state
  const [editId, setEditId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editRss, setEditRss] = useState("");
  const [editSiteUrl, setEditSiteUrl] = useState("");
  const [editColor, setEditColor] = useState(DEFAULT_COLOR);

  const { data: sites = [], isLoading } = useQuery<TrackedSite[]>({
    queryKey: ["/api/tracked-sites"],
    queryFn: () => apiRequest("GET", "/api/tracked-sites").then(r => r.json()),
  });

  const addMutation = useMutation({
    mutationFn: (data: { siteKey: string; label: string; rssUrl: string; siteUrl: string; color: string }) =>
      apiRequest("POST", "/api/tracked-sites", data).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tracked-sites"] });
      setAddKey("");
      setAddLabel("");
      setAddRss("");
      setAddSiteUrl("");
      setAddColor(DEFAULT_COLOR);
      toast({ title: "Site added" });
    },
    onError: (err: any) => toast({ title: err?.message ?? "Failed to add site", variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...fields }: { id: number; label: string; rss_url: string; site_url: string; color: string }) =>
      apiRequest("PUT", `/api/tracked-sites/${id}`, fields).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tracked-sites"] });
      setEditId(null);
      toast({ title: "Site updated" });
    },
    onError: () => toast({ title: "Failed to update site", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("DELETE", `/api/tracked-sites/${id}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tracked-sites"] });
      toast({ title: "Site removed" });
    },
    onError: () => toast({ title: "Failed to delete site", variant: "destructive" }),
  });

  const toggleVelocityMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("PATCH", `/api/tracked-sites/${id}/toggle-velocity`).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/tracked-sites"] }),
    onError: () => toast({ title: "Failed to toggle velocity", variant: "destructive" }),
  });

  const toggleMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("PATCH", `/api/tracked-sites/${id}/toggle`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/tracked-sites"] });
    },
    onError: () => toast({ title: "Failed to toggle site", variant: "destructive" }),
  });

  function startEdit(site: TrackedSite) {
    setEditId(site.id);
    setEditLabel(site.label);
    setEditRss(site.rss_url);
    setEditSiteUrl(site.site_url ?? "");
    setEditColor(site.color);
  }

  function cancelEdit() {
    setEditId(null);
  }

  function saveEdit(id: number) {
    updateMutation.mutate({ id, label: editLabel, rss_url: editRss, site_url: editSiteUrl, color: editColor });
  }

  const enabledCount = sites.filter(s => s.enabled).length;

  return (
    <div className="h-full overflow-y-auto bg-background">
      <div className="p-6 max-w-4xl mx-auto w-full">
        <h1 className="text-xl font-bold text-foreground mb-6 flex items-center gap-2">
          <Globe className="w-5 h-5 text-[#e8312a]" />
          Site Management
        </h1>

        {/* Add site form */}
        <Card className="mb-6 border border-[#e8312a]/30">
          <CardHeader className="pb-3 pt-4 px-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Plus className="w-4 h-4 text-[#e8312a]" />
              Add Site
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            <form
              onSubmit={e => {
                e.preventDefault();
                if (addKey && addLabel && addRss) {
                  addMutation.mutate({ siteKey: addKey, label: addLabel, rssUrl: addRss, siteUrl: addSiteUrl, color: addColor });
                }
              }}
              className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            >
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Site Key <span className="text-[#e8312a]">*</span></label>
                <input
                  type="text"
                  value={addKey}
                  onChange={e => setAddKey(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ""))}
                  placeholder="e.g. whathifi"
                  required
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-[#e8312a] transition-colors font-mono"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Label <span className="text-[#e8312a]">*</span></label>
                <input
                  type="text"
                  value={addLabel}
                  onChange={e => setAddLabel(e.target.value)}
                  placeholder="e.g. What Hi-Fi"
                  required
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-[#e8312a] transition-colors"
                />
              </div>
              <div className="sm:col-span-2">
                <label className="text-xs text-muted-foreground block mb-1">RSS Feed URL <span className="text-[#e8312a]">*</span></label>
                <input
                  type="url"
                  value={addRss}
                  onChange={e => setAddRss(e.target.value)}
                  placeholder="https://example.com/feed/"
                  required
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-[#e8312a] transition-colors font-mono"
                />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Site URL</label>
                <input
                  type="url"
                  value={addSiteUrl}
                  onChange={e => setAddSiteUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="w-full px-3 py-2 bg-muted border border-border rounded-lg text-sm text-foreground outline-none focus:border-[#e8312a] transition-colors font-mono"
                />
              </div>
              <div className="flex items-end gap-3">
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Color</label>
                  <input
                    type="color"
                    value={addColor}
                    onChange={e => setAddColor(e.target.value)}
                    className="h-9 w-16 px-1 py-1 bg-muted border border-border rounded-lg cursor-pointer"
                  />
                </div>
                <button
                  type="submit"
                  disabled={addMutation.isPending}
                  className="flex-1 px-4 py-2 bg-[#e8312a] text-white rounded-lg text-sm font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {addMutation.isPending ? "Adding..." : "Add Site"}
                </button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Sites table */}
        <Card>
          <CardHeader className="pb-3 pt-4 px-5">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Globe className="w-4 h-4 text-muted-foreground" />
              Tracked Sites ({enabledCount}/{sites.length} enabled)
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading...</p>
            ) : sites.length === 0 ? (
              <p className="text-sm text-muted-foreground">No sites configured. Add one above.</p>
            ) : (
              <div className="space-y-1">
                {/* Header row */}
                <div className="grid grid-cols-[auto_1fr_1fr_auto_auto] gap-3 px-3 py-1 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                  <div className="w-10">On</div>
                  <div>Label / Key</div>
                  <div>RSS URL</div>
                  <div className="w-6">Color</div>
                  <div className="w-16 text-right">Actions</div>
                </div>

                {sites.map(site => (
                  <div
                    key={site.id}
                    className={`grid grid-cols-[auto_1fr_1fr_auto_auto_auto] gap-3 items-center px-3 py-3 rounded-lg transition-colors ${
                      site.enabled ? "bg-muted/40" : "bg-muted/10 opacity-60"
                    }`}
                  >
                    {/* Toggle */}
                    <div className="w-10">
                      <button
                        onClick={() => toggleMutation.mutate(site.id)}
                        disabled={toggleMutation.isPending}
                        title={site.enabled ? "Disable site" : "Enable site"}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {site.enabled ? (
                          <ToggleRight className="w-5 h-5 text-[#e8312a]" />
                        ) : (
                          <ToggleLeft className="w-5 h-5" />
                        )}
                      </button>
                    </div>

                    {/* Label / Key */}
                    <div className="min-w-0">
                      {editId === site.id ? (
                        <input
                          type="text"
                          value={editLabel}
                          onChange={e => setEditLabel(e.target.value)}
                          className="w-full px-2 py-1 bg-muted border border-border rounded text-sm text-foreground outline-none focus:border-[#e8312a]"
                          autoFocus
                        />
                      ) : (
                        <div>
                          <div className="text-sm font-medium text-foreground truncate">{site.label}</div>
                          <div className="text-[10px] font-mono text-muted-foreground">{site.site_key}</div>
                        </div>
                      )}
                    </div>

                    {/* RSS URL */}
                    <div className="min-w-0">
                      {editId === site.id ? (
                        <div className="space-y-1">
                          <input
                            type="url"
                            value={editRss}
                            onChange={e => setEditRss(e.target.value)}
                            placeholder="RSS URL"
                            className="w-full px-2 py-1 bg-muted border border-border rounded text-xs font-mono text-foreground outline-none focus:border-[#e8312a]"
                          />
                          <input
                            type="url"
                            value={editSiteUrl}
                            onChange={e => setEditSiteUrl(e.target.value)}
                            placeholder="Site URL (optional)"
                            className="w-full px-2 py-1 bg-muted border border-border rounded text-xs font-mono text-foreground outline-none focus:border-[#e8312a]"
                          />
                        </div>
                      ) : (
                        <div className="text-xs font-mono text-muted-foreground truncate" title={site.rss_url}>
                          {site.rss_url}
                        </div>
                      )}
                    </div>

                    {/* Color */}
                    <div className="w-6 flex items-center justify-center">
                      {editId === site.id ? (
                        <input
                          type="color"
                          value={editColor}
                          onChange={e => setEditColor(e.target.value)}
                          className="h-6 w-6 rounded cursor-pointer border-0 bg-transparent"
                        />
                      ) : (
                        <div
                          className="w-4 h-4 rounded-full border border-border/50"
                          style={{ backgroundColor: site.color }}
                          title={site.color}
                        />
                      )}
                    </div>

                    {/* Velocity toggle */}
                    <div className="w-8 flex items-center justify-center">
                      <button
                        onClick={() => toggleVelocityMutation.mutate(site.id)}
                        disabled={toggleVelocityMutation.isPending}
                        title={site.exclude_velocity ? "Excluded from Velocity Gap — click to include" : "Included in Velocity Gap — click to exclude"}
                        className="transition-colors"
                      >
                        <BarChart3 className={`w-4 h-4 ${site.exclude_velocity ? "text-muted-foreground/30" : "text-emerald-400"}`} />
                      </button>
                    </div>

                    {/* Actions */}
                    <div className="w-16 flex items-center justify-end gap-1.5">
                      {editId === site.id ? (
                        <>
                          <button
                            onClick={() => saveEdit(site.id)}
                            disabled={updateMutation.isPending}
                            className="text-green-500 hover:text-green-400 transition-colors"
                            title="Save"
                          >
                            <Check className="w-4 h-4" />
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            title="Cancel"
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(site)}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                            title="Edit"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              if (confirm(`Remove "${site.label}" from tracked sites?`)) {
                                deleteMutation.mutate(site.id);
                              }
                            }}
                            className="text-muted-foreground hover:text-red-400 transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
