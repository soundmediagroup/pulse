import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import fs from "fs";
import path from "path";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

// Read build version + date written by script/build.ts into dist/version.json.
// Cached at boot — if the file is missing (dev mode), default to "dev" / now.
function readBuildVersion(): { version: string; date: string } {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf-8"));
    return { version: v.version || "dev", date: v.date || new Date().toISOString() };
  } catch {
    return { version: "dev", date: new Date().toISOString() };
  }
}
const BUILD = readBuildVersion();
// Human-readable build date for hover tooltips on the login page (Sydney time,
// 24-hour clock, day-month-year per Australian convention).
const BUILD_DATE_HUMAN = (() => {
  try {
    const d = new Date(BUILD.date);
    // Use Intl.DateTimeFormat parts so we can control day-month-year exactly.
    const parts = new Intl.DateTimeFormat("en-AU", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit", hour12: false,
      timeZone: "Australia/Sydney",
    }).formatToParts(d);
    const get = (t: string) => parts.find(p => p.type === t)?.value || "";
    return `${get("day")}/${get("month")}/${get("year")} ${get("hour")}:${get("minute")} AEST`;
  } catch { return BUILD.date; }
})();

// Global safety net — never let an unhandled error take the server down.
// Log it, keep running. Far better than a crash loop.
process.on("uncaughtException", (err) => {
  console.error("[server] uncaughtException:", err?.stack || err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[server] unhandledRejection:", reason);
});

const app = express();
app.set('trust proxy', 1); // Trust Cloudflare proxy

// CORS — only allow requests from the dashboard domain
app.use((req, res, next) => {
  const allowedOrigins = [
    'https://dashboard.stereonet.com',
    'https://www.stereonet.com',
    'https://stereonet.com',
    'http://localhost:3456',
    'http://192.168.1.227:3456',
  ];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-deploy-token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// ─── Trust Cloudflare proxy headers (X-Forwarded-For, etc.)
app.set("trust proxy", true);

// ─── HSTS only (no app-layer HTTPS redirect)
//     Cloudflare is on Flexible SSL → talks to origin over HTTP and does NOT
//     forward a reliable X-Forwarded-Proto header. A server-side redirect
//     would loop forever. Use Cloudflare's "Always Use HTTPS" Page Rule
//     to handle the http→https redirect at the edge instead.
//     We still send HSTS on every response — once the browser has cached it,
//     it will rewrite http://dashboard.stereonet.com to https:// locally.
app.use((_req, res, next) => {
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
});

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

// ─── Session ──────────────────────────────────────────────────────────────────
app.use(session({
  secret: process.env.SESSION_SECRET || "pulse-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false, // Cloudflare Flexible SSL: origin receives HTTP even when user accesses HTTPS
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ─── Auth config ──────────────────────────────────────────────────────────────
import { storage } from "./storage";

const SUPER_ADMIN = "marcrushton@stereonet.com";

// Seed users from AUTH_USERS env var into DB on first run
if (storage.getUserCount() === 0) {
  let envUsers: { user: string; pass: string }[] = [];
  if (process.env.AUTH_USERS) {
    try { envUsers = JSON.parse(process.env.AUTH_USERS); } catch {}
  }
  if (envUsers.length === 0) {
    envUsers = [{ user: process.env.AUTH_USER || "admin", pass: process.env.AUTH_PASS || "GDQVH3zP58e5oxCT" }];
  }
  for (const u of envUsers) {
    const role = u.user === SUPER_ADMIN ? "admin" : "user";
    storage.upsertUser(u.user, u.pass, role);
  }
  console.log(`[cadence] Seeded ${envUsers.length} users into DB`);
}

// ─── Login page ───────────────────────────────────────────────────────────────
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pulse — StereoNET</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      background: #1a1a1a;
      font-family: Inter, system-ui, sans-serif;
      color: #e2e8f0;
    }
    .logo-wrap {
      margin-bottom: 2rem;
      text-align: center;
    }
    .logo-svg-bg {
      display: inline-block;
      background: #e8312a;
      border-radius: 6px;
      padding: 10px 18px;
      margin-bottom: 1rem;
    }
    .site-title {
      font-size: 0.7rem;
      font-weight: 600;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: #6b7280;
      margin-top: 0.5rem;
    }
    .version {
      margin-top: 1.25rem;
      font-size: 11px;
      font-family: "IBM Plex Mono", "Geist Mono", ui-monospace, monospace;
      color: #555;
      letter-spacing: 0.04em;
      cursor: help;
      user-select: none;
    }
    .version:hover { color: #888; }
    .card {
      background: #212121;
      border: 1px solid #2e2e2e;
      border-radius: 12px;
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 380px;
    }
    h1 { font-size: 1.2rem; font-weight: 700; margin-bottom: 0.25rem; color: #f1f5f9; }
    .subtitle { font-size: 0.82rem; color: #6b7280; margin-bottom: 1.75rem; }
    label { display: block; font-size: 0.78rem; font-weight: 500; color: #94a3b8; margin-bottom: 0.35rem; }
    input {
      width: 100%; padding: 0.6rem 0.85rem;
      background: #1a1a1a; border: 1px solid #333;
      border-radius: 8px; color: #e2e8f0; font-size: 0.9rem;
      outline: none; transition: border-color 0.15s;
      margin-bottom: 1rem;
    }
    input:focus { border-color: #e8312a; }
    .error {
      background: rgba(232,49,42,0.1); border: 1px solid rgba(232,49,42,0.3);
      color: #fca5a5; border-radius: 8px; padding: 0.6rem 0.85rem;
      font-size: 0.82rem; margin-bottom: 1rem;
    }
    button {
      width: 100%; padding: 0.7rem;
      background: #e8312a; color: #fff;
      border: none; border-radius: 8px; font-size: 0.95rem;
      font-weight: 700; cursor: pointer; transition: opacity 0.15s;
      letter-spacing: 0.02em;
    }
    button:hover { opacity: 0.88; }
  </style>
</head>
<body>
  <div class="logo-wrap">
    <div class="logo-svg-bg">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="178 420 1520 380" style="width:160px;height:40px;display:block" aria-label="StereoNET">
        <g fill="#fff">
          <path d="M281.8,569.7l-.4-11.3c0-2.7-.2-5.3-.6-8-.4-2.7-1.1-5.4-2.2-8.3-1.1-2.9-2.7-5.1-4.8-6.9-2.1-1.7-4.6-2.6-7.6-2.6-4.9,0-8.7,1.4-11.2,4.2-2.6,2.8-3.9,6.7-3.9,11.8,0,10.6,4.3,19,12.8,25.3l44,32.2c8.8,6.5,16.3,13.3,22.7,20.5,6.4,7.2,11.2,13.7,14.5,19.6,3.3,5.9,5.9,12.2,7.8,19,1.9,6.8,3.1,12.3,3.5,16.5.4,4.2.6,9,.6,14.3,0,28.5-8,50.1-24.1,64.8-16.1,14.7-38,22-65.6,22.1-58.9,0-88.4-29.9-88.5-89.9l.4-23.7h71.3c0,0,.4,35,.4,35,0,4.8.6,8.7,1.7,11.8,1.1,3.1,2.7,5.3,4.7,6.7,2,1.3,3.8,2.2,5.5,2.6,1.7.4,3.5.6,5.7.6,9.6,0,14.3-7.8,14.3-23.3,0-4,0-6.9-.2-8.7-.1-1.8-.6-4.4-1.5-8-.9-3.5-2.3-6.6-4.2-9.3-1.9-2.7-4.7-5.9-8.4-9.7-3.7-3.8-8.3-7.9-13.8-12.1l-38.1-29.2c-8.2-6.4-14.9-12.6-20-18.6-5.1-6-8.8-12.4-11.2-19.1-2.3-6.7-3.8-12.7-4.5-18.1-.7-5.4-1-12.3-1-20.8,0-15.3,4.4-28.5,13.1-39.6,8.7-11.2,19.7-19.3,32.7-24.5,13.1-5.2,27.2-7.8,42.5-7.8,28,0,49.5,7.1,64.4,21.2,14.9,14.2,22.4,36.1,22.5,65.7v5.6s-73.3,0-73.3,0Z"/>
          <path d="M368.1,428.7h69.3v63.4h12.7v54.3h-12.7l.2,168c0,2.5,0,4.5.2,6,.1,1.5.4,3,.8,4.7.4,1.7,1.2,2.9,2.3,3.6,1.1.7,2.6,1.1,4.3,1.1,1.7,0,3.5-.3,5.2-.8v48.6c-10,3.5-22.7,5.2-38,5.2-7.7,0-14.3-1-19.8-3.1-5.5-2.1-9.8-4.6-12.8-7.6-3.1-3-5.5-6.8-7.3-11.5-1.8-4.7-2.9-9.1-3.4-13.2-.5-4.1-.7-8.8-.7-14.1l-.2-186.7h-10.9v-54.3h10.9v-63.5Z"/>
          <path d="M543.9,782.7c-10.6,0-20.2-1.1-28.9-3.3-8.6-2.2-15.9-5-21.8-8.5-5.9-3.5-11-8-15.3-13.3-4.3-5.4-7.7-10.8-10.3-16.4-2.5-5.6-4.6-11.9-6.1-19.1-1.5-7.2-2.5-13.8-3-19.9-.5-6.1-.7-12.9-.7-20.3v-120c-.2-27.5,7.7-48.5,23.4-63,15.7-14.5,37.7-21.8,66-21.9,57.3,0,86,28.2,86.1,84.7v21.7c0,26.9-.2,45.5-.7,55.5h-103.5v41.9c0,1.3,0,3.5,0,6.5s0,5.3,0,6.9c0,4.8.2,8.9.6,12.2.4,3.4,1.1,6.8,2.2,10.3,1.1,3.5,2.8,6.2,5.3,8,2.5,1.8,5.5,2.7,9.3,2.7,3.8,0,7-1.4,9.4-4.1,2.4-2.7,4.1-6.6,5.1-11.7,1-5.1,1.6-9.7,1.9-13.6.3-4,.4-9,.4-14.9,0-11.7-.2-18-.4-19.1h70.9v16.8c0,16.6-1.2,30.7-3.7,42.4-2.5,11.7-7,22.2-13.4,31.6-6.4,9.4-15.6,16.4-27.5,21-11.9,4.7-26.9,7-44.8,7ZM546.4,530.4c-3.7,0-6.8,1-9.4,2.9-2.5,1.9-4.4,4.8-5.6,8.7-1.2,3.9-2,7.8-2.4,11.8-.4,4.1-.6,9-.6,14.8,0,2.8,0,7,.2,12.5.1,5.6.2,9.8.2,12.5h33.4v-31.1c0-21.5-5.3-32.2-16-32.2Z"/>
          <path d="M640.6,779l-.3-298.6h71.3v33.2c4-13.7,9.5-23.2,16.7-28.7,7.2-5.4,16.2-8.2,27.3-8.2,13.3,0,25,4.1,35,12.2,10.1,8.2,15.2,20,15.2,35.5v99.9h-69.6v-71.5c0-3.6-.2-6.6-.6-9.1-.3-2.5-1.4-4.8-3.2-7.1-1.8-2.3-4.4-3.4-7.7-3.4-3.5,0-6.5,1.5-9.2,4.6-2.7,3.1-4,7.2-4,12.5l.2,228.3h-71.3Z"/>
          <path d="M890.1,782.3c-10.6,0-20.2-1.1-28.9-3.3-8.6-2.2-15.9-5-21.8-8.5-5.9-3.5-11-8-15.3-13.3-4.3-5.4-7.7-10.8-10.3-16.4-2.5-5.6-4.6-11.9-6.1-19.1-1.5-7.2-2.5-13.8-3-19.9-.5-6.1-.7-12.9-.7-20.3v-120c-.2-27.5,7.7-48.5,23.4-63,15.7-14.5,37.7-21.8,66-21.9,57.3,0,86,28.2,86.1,84.7v21.7c0,26.9-.2,45.5-.7,55.5h-103.5v41.9c0,1.3,0,3.5,0,6.5s0,5.3,0,6.9c0,4.8.2,8.9.6,12.2.4,3.4,1.1,6.8,2.2,10.3,1.1,3.5,2.8,6.2,5.3,8,2.5,1.8,5.5,2.7,9.3,2.7,3.8,0,7-1.4,9.4-4.1,2.4-2.7,4.1-6.6,5.1-11.8,1-5.1,1.6-9.7,1.9-13.6.3-4,.4-9,.4-14.9,0-11.7-.1-18-.4-19.1h70.9v16.8c0,16.6-1.2,30.7-3.7,42.4-2.5,11.7-7,22.2-13.4,31.6-6.4,9.4-15.6,16.4-27.6,21-11.9,4.7-26.9,7-44.8,7ZM892.6,530.1c-3.7,0-6.8,1-9.4,2.9-2.5,1.9-4.4,4.8-5.6,8.7-1.2,3.9-2,7.8-2.4,11.8-.4,4.1-.6,9-.6,14.8,0,2.8,0,7,.2,12.5.1,5.6.2,9.8.2,12.5h33.4v-31.1c0-21.5-5.3-32.2-16-32.2Z"/>
          <path d="M1075.4,782.1c-59.5,0-89.2-30.9-89.3-92.9v-119.8c-.2-28.5,7.8-51.2,23.7-67.9,15.9-16.7,37.7-25.1,65.3-25.2,27.7,0,49.6,8.3,65.5,25,15.9,16.7,23.9,39.3,24,67.9v119.8c.2,31.2-7.4,54.5-22.6,69.9-15.2,15.4-37.4,23.1-66.6,23.2ZM1058.4,558v145.9c.2,8,1.7,13.8,4.8,17.4,3.1,3.6,7.1,5.5,12.1,5.5,4.9,0,8.9-1.8,12-5.5,3.1-3.7,4.7-9.5,4.7-17.4v-145.9c-.2-17.4-5.7-26.1-16.9-26.1-11.1,0-16.7,8.7-16.7,26.1Z"/>
          <path d="M1172.2,780.7l-.3-300.7h71.7v34.4c2.9-13,8.4-22.5,16.3-28.7,7.9-6.1,17.6-9.2,28.9-9.2,18.8,0,33.5,5.9,43.9,17.7,10.4,11.8,15.7,30,15.7,54.6l.2,231.8h-70.7l-.3-224.3c0-6.3-1.3-11.8-3.8-16.6-2.5-4.8-6.6-7.2-12.2-7.2-3.5,0-6.4,1-8.8,2.9-2.4,1.9-4.2,4.1-5.3,6.6-1.1,2.5-2,5.7-2.7,9.7-.7,4-1,7.1-1.1,9.2,0,2.1-.1,4.9,0,8.4l.2,211.4h-71.7Z"/>
          <path d="M1441,784c-10.7,0-20.4-1.1-29.1-3.3-8.7-2.2-16-5.1-21.9-8.6-6-3.5-11.1-8-15.4-13.4-4.3-5.4-7.8-10.9-10.3-16.5-2.5-5.6-4.6-12-6.1-19.2-1.5-7.2-2.6-13.9-3-20-.5-6.1-.7-13-.7-20.4v-120.8c-.2-27.6,7.7-48.8,23.5-63.4,15.8-14.6,37.9-22,66.4-22,57.7,0,86.6,28.4,86.6,85.2v21.8c0,27.1-.2,45.7-.7,55.9h-104.2v42.2c0,1.3,0,3.5,0,6.5s-.1,5.3,0,6.9c0,4.8.2,8.9.6,12.3.4,3.4,1.1,6.9,2.2,10.4,1.1,3.5,2.9,6.2,5.3,8,2.5,1.8,5.6,2.7,9.3,2.7,3.9,0,7-1.4,9.4-4.1,2.4-2.7,4.1-6.7,5.1-11.8,1-5.1,1.6-9.7,1.9-13.7.3-4,.4-9,.4-15,0-11.8-.1-18.2-.4-19.2h71.3v16.9c0,16.7-1.2,30.9-3.8,42.7-2.5,11.8-7,22.3-13.5,31.8-6.5,9.4-15.7,16.5-27.7,21.2-12,4.7-27,7-45.1,7.1ZM1443.5,530.2c-3.7,0-6.9,1-9.4,2.9-2.5,1.9-4.4,4.8-5.6,8.7-1.2,3.9-2,7.8-2.4,11.9-.4,4.1-.6,9.1-.6,14.9,0,2.8,0,7,.2,12.6.1,5.6.2,9.8.2,12.6h33.7v-31.3c0-21.6-5.4-32.5-16.1-32.4Z"/>
          <path d="M1544.4,427.5h69.7v63.8h12.8v54.7h-12.8l.2,169.1c0,2.5,0,4.5.2,6,.1,1.5.4,3,.8,4.7.4,1.7,1.2,2.9,2.3,3.6,1.1.7,2.6,1.1,4.3,1.1,1.7,0,3.5-.3,5.2-.8v48.9c-10.1,3.5-22.8,5.2-38.2,5.3-7.7,0-14.4-1-19.9-3.1-5.5-2.1-9.9-4.6-12.9-7.6-3.1-3-5.5-6.9-7.3-11.6-1.8-4.7-2.9-9.2-3.4-13.3-.5-4.1-.7-8.9-.7-14.2l-.2-187.9h-11v-54.7h11v-63.9Z"/>
        </g>
      </svg>
    </div>
    <div class="site-title">Pulse</div>
  </div>
  <div class="card">
    <h1>Sign in</h1>
    <p class="subtitle">Enter your credentials to continue</p>
    {{ERROR}}
    <form method="POST" action="/login">
      <label for="username">Email</label>
      <input id="username" name="username" type="email" autocomplete="username" placeholder="you@stereonet.com" required autofocus />
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <button type="submit">Sign in</button>
    </form>
  </div>
  <div class="version" title="Built {{BUILD_DATE_HUMAN}}">{{BUILD_VERSION}}</div>
</body>
</html>`;

// ─── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if ((req.session as any).authenticated) return next();
  if (req.path === "/login") return next();
  if (req.path === "/api/deploy" || req.path.startsWith("/api/deploy/")) return next(); // Deploy endpoints handle their own auth via token
  if (req.path === "/api/ingest/article") return next(); // Webhook handles its own auth via x-webhook-token
  if (req.path === "/api/ingest/attachment") return next(); // Webhook handles its own auth via x-webhook-token
  if (req.path === "/api/retailers/ingest") return next(); // PULSE retailer tracking ingest — token + rate limit checked in route handler
  if (req.path === "/api/fx-rates") return next(); // Public FX rates feed for media kit currency selector
  if (req.path.startsWith("/uploads/")) return next(); // Public static files (sha256-addressed, no PII)
  if (req.path.startsWith("/api/admin/diag/") && (req.headers["x-deploy-token"] || req.query.token)) return next(); // Diag endpoints handle token check inline
  if (req.path === "/api/filter-keywords" && req.method === "GET" && (req.headers["x-deploy-token"] || req.query.token)) return next(); // GET allowed via deploy token for diagnostics
  if (req.path === "/api/version" || req.path === "/api/healthz") return next(); // Public version + healthcheck
  // Legacy PITCH public viewer was retired in the Media Kit unification.
  // The /api/pitch/public/* endpoints are gone; /pitch/<slug> URLs now fall
  // through to the SPA NotFound page (no special bypass needed).
  if (req.path.startsWith("/api/media-kit/public/")) return next(); // Media Kit public access — gated by magic_token in URL
  if (req.path === "/api/media-kit/request") return next(); // Public form-submission endpoint from /advertising page
  if (req.path === "/advertising" || req.path === "/advertising/") return next(); // Public advertising landing page
  if (req.path === "/stereonet-logo.svg" || req.path === "/stereonet-logo-trim.svg" || req.path === "/stereonet-logo.jpg" || req.path === "/favicon.ico") return next(); // Public site assets
  if (req.path.startsWith("/kit/")) return next(); // Media Kit client-facing route — SPA handles token check
  // Static SPA bundles, source maps, and SPA-public static files (fonts, public images,
  // favicons). These are content-addressed by Vite (hashed filenames) and contain no PII.
  // Without this, anonymous prospects on /kit/* and /pitch/* get redirected to /login when
  // their browser tries to load the JS/CSS bundle referenced by the SPA's index.html.
  if (req.path.startsWith("/assets/")) return next();
  if (req.path === "/favicon.png" || req.path === "/manifest.webmanifest" || req.path === "/robots.txt") return next();
  if (req.path.startsWith("/api/admin/diag/press-emails") && (req.headers["x-deploy-token"] || req.query.token)) return next(); // Token-gated
  if (req.path === "/api/admin/diag/resurface" && (req.headers["x-deploy-token"] || req.query.token)) return next(); // Token-gated
  if (req.path.startsWith("/api")) return res.status(401).json({ message: "Unauthorized" });
  res.redirect("/login");
}

// Public version + health endpoints. The Dashboard footer pings /api/version
// to display the live build (resilient to bundled VITE env going stale).
app.get("/api/version", (_req, res) => res.json(BUILD));
app.get("/api/healthz", (_req, res) => res.json({ ok: true, version: BUILD.version }));

app.get("/login", (req, res) => {
  if ((req.session as any).authenticated) return res.redirect("/");
  res.send(
    LOGIN_HTML
      .replace("{{ERROR}}", "")
      .replace("{{BUILD_VERSION}}", BUILD.version)
      .replace("{{BUILD_DATE_HUMAN}}", BUILD_DATE_HUMAN)
  );
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per window
  message: LOGIN_HTML
    .replace("{{ERROR}}", '<div class="error">Too many login attempts. Try again in 15 minutes.</div>')
    .replace("{{BUILD_VERSION}}", BUILD.version)
    .replace("{{BUILD_DATE_HUMAN}}", BUILD_DATE_HUMAN),
  standardHeaders: true,
  legacyHeaders: false,
});

app.post("/login", loginLimiter, (req, res) => {
  const { username, password } = req.body;
  const user = storage.getUser(username);
  // Support both hashed and plain text passwords (migration period)
  const passwordMatch = user && (
    bcrypt.compareSync(password, user.password) || user.password === password
  );
  if (user && passwordMatch) {
    (req.session as any).authenticated = true;
    (req.session as any).username = username;
    (req.session as any).role = user.role;
    storage.updateLastLogin(username);
    return res.redirect("/");
  }
  res.send(
    LOGIN_HTML
      .replace("{{ERROR}}", `<div class="error">Incorrect username or password.</div>`)
      .replace("{{BUILD_VERSION}}", BUILD.version)
      .replace("{{BUILD_DATE_HUMAN}}", BUILD_DATE_HUMAN)
  );
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.use(requireAuth);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  // Public /advertising landing page — standalone HTML served outside the React SPA.
  // The page lives in client/public/advertising.html and is built into dist/public/.
  app.get(["/advertising", "/advertising/"], (req, res) => {
    // Log the hit for the Commercial Activity dashboard card. Bots are
    // filtered via simple UA regex; same-IP within 60s is suppressed so
    // refresh-spamming doesn't inflate the count.
    try {
      const { sqlite } = require("./storage");
      const ua = String(req.headers["user-agent"] || "");
      const ip = (req.headers["cf-connecting-ip"] as string) || req.ip || null;
      const botRe = /bot|spider|crawler|crawling|preview|slurp|facebookexternalhit|whatsapp|telegrambot|httpclient|curl|wget|python-requests|axios|node-fetch|headless|monitoring|uptime|pingdom|gtmetrix|lighthouse|chrome-lighthouse|google-pagespeed/i;
      if (!ua || !botRe.test(ua)) {
        // Dedupe: only log if no hit from this IP in the last 60 seconds.
        const recent = ip ? sqlite.prepare(`SELECT id FROM advertising_page_hits WHERE ip = ? AND ts > datetime('now','-60 seconds') LIMIT 1`).get(ip) : null;
        if (!recent) {
          sqlite.prepare(`INSERT INTO advertising_page_hits (ip, user_agent, referrer) VALUES (?, ?, ?)`).run(ip, ua || null, (req.headers.referer as string) || null);
        }
      }
    } catch (e) { console.warn("[adv-hit] log failed:", e); }
    const filePath = require("path").resolve(__dirname, "public", "advertising.html");
    res.sendFile(filePath);
  });

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
