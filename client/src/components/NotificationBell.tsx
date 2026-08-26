import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Bell, MessageCircle, SmilePlus, Check, CheckCheck, Flag, Pin } from "lucide-react";
import { useRealtimeEvents } from "@/hooks/useRealtime";

interface Notification {
  id: number;
  username: string;
  type: string;
  message: string;
  from_user: string;
  article_id: number | null;
  comment_id: number | null;
  read: number;
  created_at: string;
}

function relativeTime(iso: string) {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return "";
  const diff = Math.round((Date.now() - date.getTime()) / 60000);
  if (diff <= 0) return "now";
  if (diff < 60) return `${diff}m`;
  if (diff < 1440) return `${Math.round(diff / 60)}h`;
  return `${Math.round(diff / 1440)}d`;
}

const TYPE_ICONS: Record<string, any> = {
  comment: <MessageCircle className="w-3 h-3" />,
  reaction: <SmilePlus className="w-3 h-3" />,
  claim: <Flag className="w-3 h-3" />,
  pin: <Pin className="w-3 h-3" />,
};

const TYPE_COLORS: Record<string, string> = {
  comment: "#6366f1",
  reaction: "#f97316",
  claim: "#eab308",
  pin: "#e8312a",
};

export default function NotificationBell() {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  const { data: unreadData } = useQuery<{ count: number }>({
    queryKey: ["/api/notifications/unread-count"],
    queryFn: () => apiRequest("GET", "/api/notifications/unread-count").then(r => r.json()),
    refetchInterval: 15000,
  });
  const unreadCount = unreadData?.count ?? 0;

  // Realtime: invalidate unread count & list when any notification-triggering event lands.
  useRealtimeEvents(
    ["notification.new", "article.claimed", "article.pinned", "article.new"],
    () => {
      qc.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
      qc.invalidateQueries({ queryKey: ["/api/notifications"] });
    }
  );

  const [showRead, setShowRead] = useState(false);
  const { data: allNotifications = [] } = useQuery<Notification[]>({
    queryKey: ["/api/notifications"],
    queryFn: () => apiRequest("GET", "/api/notifications").then(r => r.json()),
    enabled: isOpen,
  });
  // Once a user clicks a notification, drop it from the visible list immediately
  // so it "doesn't continue to show". Toggle to see historical read notifications.
  const notifications = showRead ? allNotifications : allNotifications.filter(n => !n.read);
  const hiddenReadCount = allNotifications.length - notifications.length;

  const markReadMutation = useMutation({
    mutationFn: (id: number) =>
      apiRequest("POST", `/api/notifications/mark-read/${id}`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/notifications"] });
      qc.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", "/api/notifications/mark-all-read").then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/notifications"] });
      qc.invalidateQueries({ queryKey: ["/api/notifications/unread-count"] });
    },
  });

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Refetch notifications when opening
  useEffect(() => {
    if (isOpen) {
      qc.invalidateQueries({ queryKey: ["/api/notifications"] });
    }
  }, [isOpen, qc]);

  return (
    <div ref={containerRef} className="relative">
      {/* Bell button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={`relative p-2 rounded-lg transition-colors ${
          isOpen ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
        }`}
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-[#e8312a] text-white text-[10px] font-bold flex items-center justify-center leading-none">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {isOpen && (
        <div className="absolute top-full right-0 mt-2 w-[340px] max-h-[440px] rounded-lg bg-card border border-border shadow-2xl overflow-hidden z-50 flex flex-col">
          {/* Header */}
          <div className="flex items-center justify-between px-3 py-2 border-b border-border/50">
            <span className="text-xs font-semibold text-foreground tracking-wide">Notifications</span>
            <div className="flex items-center gap-3">
              {hiddenReadCount > 0 && !showRead && (
                <button
                  onClick={() => setShowRead(true)}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Show read ({hiddenReadCount})
                </button>
              )}
              {showRead && (
                <button
                  onClick={() => setShowRead(false)}
                  className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  Hide read
                </button>
              )}
              {unreadCount > 0 && (
                <button
                  onClick={() => markAllReadMutation.mutate()}
                  className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                >
                  <CheckCheck className="w-3 h-3" />
                  Mark all read
                </button>
              )}
            </div>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="py-8 text-center text-xs text-muted-foreground">
                {allNotifications.length === 0 ? "No notifications yet" : "No unread notifications"}
              </div>
            ) : (
              notifications.map(n => {
                const color = TYPE_COLORS[n.type] || "#6b7280";
                const icon = TYPE_ICONS[n.type] || <Bell className="w-3 h-3" />;
                return (
                  <div
                    key={n.id}
                    className={`flex items-start gap-2.5 px-3 py-2 border-b border-border/20 transition-colors cursor-pointer hover:bg-muted/30 ${
                      n.read ? "opacity-55" : ""
                    }`}
                    onClick={() => {
                      if (!n.read) markReadMutation.mutate(n.id);
                      if (n.article_id) {
                        window.location.hash = "/discovery";
                        setIsOpen(false);
                      }
                    }}
                  >
                    {/* Icon */}
                    <div
                      className="w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                      style={{ background: color + "22", color }}
                    >
                      {icon}
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] text-foreground leading-[1.35] line-clamp-2">{n.message}</p>
                      <span className="text-[10px] text-muted-foreground">{relativeTime(n.created_at)}</span>
                    </div>

                    {/* Unread dot */}
                    {!n.read && (
                      <div className="w-1.5 h-1.5 rounded-full bg-[#e8312a] shrink-0 mt-1.5" />
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
