// Regenerate server/redline-prompt.ts from the stereonet-sub-editor skill.
// Run with: npx tsx script/generate-redline-prompt.ts
import fs from "node:fs";
import path from "node:path";

const SKILL_ROOT = "/home/user/workspace/skills/user/stereonet-sub-editor";
const OUT = "/home/user/workspace/cadence-tracker/server/redline-prompt.ts";

function read(rel: string): string {
  return fs.readFileSync(path.join(SKILL_ROOT, rel), "utf8");
}

// Escape JS template-literal-breaking chars
function escapeForTemplate(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}

const skill = read("SKILL.md");
const style = read("references/style-guide.md");
const editorial = read("references/editorial-layer.md");
const scoring = read("references/scoring-framework.md");
const headings = read("references/section-headings.md");
const lengths = read("references/review-lengths.md");

const body = [
  "You are Redline, the StereoNET sub-editor. Your job is to sub-edit articles for StereoNET publication following the house style guide and editorial conventions of Global Editor in Chief David Price.",
  "",
  "---",
  "",
  "# SECTION 1: SKILL OVERVIEW AND INSTRUCTIONS",
  "",
  skill.trim(),
  "",
  "---",
  "",
  "# SECTION 2: STEREONET HOUSE STYLE GUIDE",
  "",
  style.trim(),
  "",
  "---",
  "",
  "# SECTION 3: DAVID PRICE'S EDITORIAL LAYER",
  "",
  editorial.trim(),
  "",
  "---",
  "",
  "# SECTION 4: REVIEW SCORING FRAMEWORK",
  "",
  scoring.trim(),
  "",
  "---",
  "",
  "# SECTION 5: SECTION HEADINGS",
  "",
  headings.trim(),
  "",
  "---",
  "",
  "# SECTION 6: REVIEW LENGTHS BY PRODUCT COMPLEXITY",
  "",
  lengths.trim(),
  "",
  "---",
  "",
  "Return your sub-edited article as clean text. After the article, add a section called '## Changes Made' that lists every significant edit you made and why.",
].join("\n");

const escaped = escapeForTemplate(body);
const out = `export const REDLINE_SYSTEM_PROMPT = \`${escaped}\`;\n`;

fs.writeFileSync(OUT, out, "utf8");
console.log(`Wrote ${OUT} (${out.length.toLocaleString()} chars)`);
