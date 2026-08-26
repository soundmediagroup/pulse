import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "__PORT_5000__".startsWith("__") ? "" : "__PORT_5000__";

// Extract a short, human-friendly message from a non-OK response body.
// Cloudflare error pages, HTML gateway pages, and other non-JSON responses
// often return thousands of characters that swamp toast/inline error UIs.
function extractErrorMessage(status: number, statusText: string, body: string, contentType: string | null): string {
  const trimmed = (body || "").trim();
  if (!trimmed) return `${status}: ${statusText || "Request failed"}`;

  // If it looks like HTML (typical of gateway/proxy error pages), pull the
  // <title> or a short human summary instead of dumping the whole page.
  const looksHtml = /^\s*<(!doctype|html|head|body|div|span|p)/i.test(trimmed) || (contentType || "").includes("text/html");
  if (looksHtml) {
    const titleMatch = trimmed.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
    const title = titleMatch?.[1]?.trim();
    // Special-case common Cloudflare error pages so the user sees an intelligible line.
    if (/error\s+52[0-4]/i.test(trimmed) || /cf-error-details|Cloudflare Ray ID/i.test(trimmed)) {
      const cfCode = trimmed.match(/error\s+(52[0-4])/i)?.[1] || status;
      return `Server is temporarily unreachable (Cloudflare ${cfCode}). Retry in a moment.`;
    }
    if (/error\s+50[0-9]/i.test(trimmed)) {
      return `Server error (${status}). Retry in a moment.`;
    }
    if (title) return `${status}: ${title}`;
    return `${status}: ${statusText || "Request failed"}`;
  }

  // If it looks like JSON, try to pull the message field.
  if (trimmed.startsWith("{") || (contentType || "").includes("application/json")) {
    try {
      const j = JSON.parse(trimmed);
      const msg = j?.message || j?.error || j?.detail;
      if (typeof msg === "string" && msg.length > 0) {
        return msg.length > 300 ? `${status}: ${msg.slice(0, 300)}\u2026` : `${status}: ${msg}`;
      }
    } catch {}
  }

  // Plain text or unknown — truncate to 300 chars.
  const compact = trimmed.replace(/\s+/g, " ");
  return compact.length > 300 ? `${status}: ${compact.slice(0, 300)}\u2026` : `${status}: ${compact}`;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const contentType = res.headers.get("content-type");
    const text = await res.text().catch(() => "");
    throw new Error(extractErrorMessage(res.status, res.statusText, text, contentType));
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
