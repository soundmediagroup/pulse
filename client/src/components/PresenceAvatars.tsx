/**
 * PresenceAvatars \u2014 small stack of circles showing who else is on Pulse right now.
 * Uses Ably presence (via usePresence hook). Renders nothing if Ably is disabled
 * or if you're the only one here.
 */
import { usePresence, useRealtime } from "@/hooks/useRealtime";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

const COLOURS = [
  "#e8312a", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6",
  "#ec4899", "#06b6d4", "#84cc16", "#f97316", "#6366f1",
];

function colourFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return COLOURS[h % COLOURS.length];
}

function initials(name: string): string {
  const clean = name.split("@")[0];
  const parts = clean.split(/[.\\-_\\s]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

export default function PresenceAvatars() {
  const { members, enabled } = usePresence();
  const { clientId } = useRealtime();
  const { data: me } = useQuery<{ username: string }>({
    queryKey: ["/api/admin/me"],
    queryFn: () => apiRequest("GET", "/api/admin/me").then(r => r.json()),
    staleTime: 300000,
  });

  if (!enabled) return null;
  const others = members.filter(m => m.clientId !== clientId && m.clientId !== me?.username);
  if (others.length === 0) return null;

  const visible = others.slice(0, 4);
  const extra = others.length - visible.length;

  return (
    <div className="flex items-center gap-1 px-2" title={`${others.length} other${others.length === 1 ? "" : "s"} online`}>
      <div className="flex -space-x-1.5">
        {visible.map(m => (
          <div
            key={m.clientId}
            className="w-6 h-6 rounded-full border-2 border-background flex items-center justify-center text-[10px] font-bold text-white"
            style={{ background: colourFor(m.clientId) }}
            title={m.clientId.split("@")[0]}
          >
            {initials(m.clientId)}
          </div>
        ))}
        {extra > 0 && (
          <div className="w-6 h-6 rounded-full border-2 border-background bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground">
            +{extra}
          </div>
        )}
      </div>
      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse ml-1" />
    </div>
  );
}
