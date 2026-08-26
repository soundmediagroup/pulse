import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, writeFile } from "fs/promises";

// server deps to bundle to reduce openat(2) syscalls
// which helps cold start times
const allowlist = [
  "@google/generative-ai",
  "ably",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  // Preserve last version info across the dist wipe
  let lastVersionFile: string | null = null;
  try { lastVersionFile = await readFile(".pulse-version.json", "utf-8"); } catch {}
  await rm("dist", { recursive: true, force: true });

  // Version displayed as v{major}.{minor} (2 decimals). Each build auto-increments
  // the minor component from the prior value tracked in dist/last-version.json.
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const [major, minorStart] = (pkg.version || "1.0.0").split(".");
  let minor = parseInt(minorStart, 10) || 0;
  if (lastVersionFile) {
    try {
      const last = JSON.parse(lastVersionFile);
      if (last?.major === major) minor = (last.minor || minor) + 1;
    } catch { /* ignore */ }
  }
  const BUILD_VERSION = `v${major}.${minor}`;
  const BUILD_DATE = new Date().toISOString();

  console.log(`building client... (${BUILD_VERSION})`);
  // Inject version into Vite build via env-style define
  process.env.VITE_BUILD_VERSION = BUILD_VERSION;
  process.env.VITE_BUILD_DATE = BUILD_DATE;
  await viteBuild();

  // Write version.json into dist for the server to expose
  await writeFile("dist/version.json", JSON.stringify({ version: BUILD_VERSION, date: BUILD_DATE }));
  // Persist the numeric minor for next-build auto-increment (outside dist rebuild scope)
  try {
    await writeFile(".pulse-version.json", JSON.stringify({ major, minor }));
  } catch {}

  console.log("building server...");
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
