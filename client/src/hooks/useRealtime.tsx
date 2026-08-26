/**
 * useRealtime \u2014 connects to Ably via a server-issued token request.
 *
 * Returns a channel object that pages can call .subscribe(event, handler) on,
 * plus a presence object for "who's online" features. Falls back gracefully
 * (null channel) when Ably isn't configured on the server \u2014 existing polling
 * keeps the app working.
 */
import { useEffect, useRef, useState } from "react";

type Channel = any | null;

interface RealtimeContextValue {
  channel: Channel;
  presenceChannel: Channel;
  clientId: string | null;
  enabled: boolean;
}

let sharedClient: any = null;
let sharedClientId: string | null = null;
let sharedChannel: any = null;
let sharedPresenceChannel: any = null;
let initPromise: Promise<void> | null = null;
let failed = false;

async function initRealtime(): Promise<void> {
  if (sharedClient) return;
  if (failed) return;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    try {
      console.log("[realtime] fetching token...");
      const res = await fetch("/api/realtime/token", { credentials: "include" });
      if (res.status === 204) { console.log("[realtime] disabled (204)"); failed = true; return; }
      if (!res.ok) { console.warn("[realtime] token fetch failed", res.status); failed = true; return; }
      const body = await res.json();
      console.log("[realtime] got token", body);
      sharedClientId = body.clientId;

      // Import Ably dynamically so any import failure surfaces here instead of silently
      const AblyMod = await import("ably");
      const AblyRealtime = (AblyMod as any).Realtime || (AblyMod as any).default?.Realtime;
      if (!AblyRealtime) {
        console.error("[realtime] Ably.Realtime not exported", Object.keys(AblyMod as any));
        failed = true; return;
      }

      sharedClient = new AblyRealtime({
        clientId: body.clientId,
        authCallback: async (_tokenParams: any, cb: any) => {
          try {
            const r = await fetch("/api/realtime/token", { credentials: "include" });
            if (!r.ok) throw new Error(`token fetch ${r.status}`);
            const b = await r.json();
            cb(null, b.tokenRequest);
          } catch (e: any) { cb(e, null); }
        },
      });

      sharedClient.connection.on((stateChange: any) => {
        console.log("[realtime] connection", stateChange.current, stateChange.reason?.message || "");
      });

      sharedChannel = sharedClient.channels.get("pulse");
      sharedPresenceChannel = sharedClient.channels.get("pulse-presence");
      // Expose for debugging (browser console). Fine to leave in prod — readonly refs.
      (window as any)._pulseChannel = sharedChannel;
      (window as any)._pulseClient = sharedClient;
      sharedChannel.subscribe((msg: any) => console.log("[realtime] ←", msg.name, msg.data));
      console.log("[realtime] channel ready, subscribed to all events");
    } catch (e: any) {
      console.error("[realtime] init failed:", e?.message || e);
      failed = true;
    }
  })();
  return initPromise;
}

export function useRealtime(): RealtimeContextValue {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    initRealtime().then(() => setTick(t => t + 1));
  }, []);

  return {
    channel: sharedChannel,
    presenceChannel: sharedPresenceChannel,
    clientId: sharedClientId,
    enabled: !!sharedChannel,
  };
}

/**
 * Subscribe to a set of event names, calling `handler` with (eventName, data).
 * Cleans up on unmount. No-op if realtime is disabled.
 */
export function useRealtimeEvents(
  events: string[],
  handler: (event: string, data: any) => void,
) {
  const { channel } = useRealtime();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!channel) return;
    const listeners: Array<[string, (m: any) => void]> = [];
    for (const event of events) {
      const listener = (msg: any) => handlerRef.current(event, msg.data);
      channel.subscribe(event, listener);
      listeners.push([event, listener]);
    }
    return () => {
      for (const [event, listener] of listeners) {
        try { channel.unsubscribe(event, listener); } catch {}
      }
    };
  }, [channel, events.join(",")]);
}

/**
 * Join a presence set with the user's username. Returns the list of currently
 * present members (usernames).
 */
export function usePresence(): { members: Array<{ clientId: string; data: any }>; enabled: boolean } {
  const { presenceChannel, clientId, enabled } = useRealtime();
  const [members, setMembers] = useState<Array<{ clientId: string; data: any }>>([]);

  useEffect(() => {
    if (!presenceChannel || !clientId) return;

    const refresh = async () => {
      try {
        const list = await presenceChannel.presence.get();
        setMembers(list.map((m: any) => ({ clientId: m.clientId, data: m.data })));
      } catch {}
    };

    presenceChannel.presence.enter({ joinedAt: Date.now() }).catch(() => {});
    refresh();

    const onChange = () => refresh();
    presenceChannel.presence.subscribe("enter", onChange);
    presenceChannel.presence.subscribe("leave", onChange);
    presenceChannel.presence.subscribe("update", onChange);

    return () => {
      try { presenceChannel.presence.leave().catch(() => {}); } catch {}
      try { presenceChannel.presence.unsubscribe(); } catch {}
    };
  }, [presenceChannel, clientId]);

  return { members, enabled };
}
