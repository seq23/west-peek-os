#!/usr/bin/env node
/**
 * West Peek brand-system boundary scan.
 *
 * This is not a validator invented to prove design work happened. It is the family convention —
 * `seq23/westpeek-live`, `seq23/west-peek-network-os`, and `seq23/west-peek-pitch-lab` each ship a
 * `validate-west-peek-brand-system.mjs`, and `WEST_PEEK_BRAND_SYSTEM.md` is marked CANONICAL /
 * LOCKED with a change-control clause binding every West Peek repo.
 *
 * It exists because this repo already suffered the exact drift it catches. Before the design
 * overhaul the client's interactive colour was `#7fa8c9` (a generic blue) and a panel rail was
 * `#6b5b95` (purple), both banned by the brand authority, and the canonical orange `#F05A1A`
 * appeared nowhere. Nothing failed, because nothing was checking.
 *
 * Rules enforced:
 *   1. The brand authority is present and still says what it says.
 *   2. Colour is declared ONLY in the `:root` token block of `src/client/styles.css`.
 *      Everything else — CSS rules, TSX, the manifest, the head — must reference a token or one of
 *      the four literals a non-CSS file is allowed to carry.
 *   3. No stale West Peek orange.
 *   4. No blue / indigo / violet / purple / cyan hue as a product colour (hue 175–330 with real
 *      chroma). Provider-specific colour inside an isolated provider surface is not in scope here
 *      because no such surface exists in this client.
 *   5. The canonical orange is defined, and the approved mark is wired into the primary shell.
 *
 * `--self-test` plants each violation in a fixture and asserts the scan still catches it, per the
 * repo convention in AGENTS.md (a narrowed rule must prove it still has teeth).
 */

import { readFileSync, existsSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CANONICAL_ORANGE = "#f05a1a";
const STALE_ORANGES = ["#ff6a00", "#f26a21", "#ff7a00", "#ff8500", "#ff8a00"];

/** Literals a non-CSS file may carry, because a manifest or an SVG cannot reference a CSS var. */
const ALLOWED_LITERALS = new Set(["#050505", "#f7f2ea", "#ffffff", "#f05a1a", "#fff"]);

/** The two approved brand assets. Their colours come from the parent brand, not from this repo. */
const BRAND_ASSETS = new Set(["wp-mark.svg", "icon.svg"]);

const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\)/g;
const SCANNED = new Set([".css", ".ts", ".tsx", ".html", ".svg", ".webmanifest", ".json"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SCANNED.has(extname(full))) out.push(full);
  }
  return out;
}

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

function stripJsComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Hex → HSL hue and saturation. Used to name a hue family rather than blocklist hexes. */
function hexHue(hex) {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  if (d === 0) return { hue: 0, sat: 0, light: l };
  const sat = d / (1 - Math.abs(2 * l - 1));
  let hue;
  if (max === r) hue = 60 * (((g - b) / d) % 6);
  else if (max === g) hue = 60 * ((b - r) / d + 2);
  else hue = 60 * ((r - g) / d + 4);
  if (hue < 0) hue += 360;
  return { hue, sat, light: l };
}

/**
 * @param {string} root repo root to scan
 * @returns {string[]} failures, empty when clean
 */
export function scan(root) {
  const failures = [];
  const rel = (f) => relative(root, f);

  // 1 · The authority itself.
  const authority = join(root, "WEST_PEEK_BRAND_SYSTEM.md");
  if (!existsSync(authority)) {
    failures.push("WEST_PEEK_BRAND_SYSTEM.md is missing from the repo root");
  } else {
    const doc = readFileSync(authority, "utf8");
    if (!doc.includes("#F05A1A")) failures.push("canonical orange #F05A1A missing from the brand authority");
    if (!doc.includes("Orange is an accent, not the entire interface")) {
      failures.push("restrained-orange governing rule missing from the brand authority");
    }
  }

  const clientDir = join(root, "src", "client");
  if (!existsSync(clientDir)) {
    failures.push("src/client is missing — nothing to scan");
    return failures;
  }

  // 2 · Colour lives in the token block, and nowhere else.
  const stylesPath = join(clientDir, "styles.css");
  let tokenBlock = "";
  if (!existsSync(stylesPath)) {
    failures.push("src/client/styles.css is missing — the token block has no home");
  } else {
    const css = stripCssComments(readFileSync(stylesPath, "utf8"));
    const start = css.indexOf(":root {");
    const end = start === -1 ? -1 : css.indexOf("\n}", start);
    if (start === -1 || end === -1) {
      failures.push("src/client/styles.css has no :root token block");
    } else {
      tokenBlock = css.slice(start, end);
      const outside = css.slice(0, start) + css.slice(end);
      for (const literal of new Set(outside.match(COLOUR) ?? [])) {
        failures.push(`colour literal outside the token block in styles.css: ${literal} (use a var(--wp-*) token)`);
      }
      if (!tokenBlock.toLowerCase().includes(CANONICAL_ORANGE)) {
        failures.push(`canonical orange ${CANONICAL_ORANGE} is not defined in the token block`);
      }
    }
  }

  for (const file of walk(clientDir)) {
    const name = basename(file);
    const ext = extname(file);
    if (file === stylesPath) continue;
    const raw = readFileSync(file, "utf8");
    const text = ext === ".css" ? stripCssComments(raw) : ext === ".svg" ? raw : stripJsComments(raw);

    // 3 · Stale oranges, anywhere, including the brand assets.
    for (const stale of STALE_ORANGES) {
      if (text.toLowerCase().includes(stale)) failures.push(`stale West Peek orange ${stale} in ${rel(file)}`);
    }

    for (const literal of new Set(text.match(COLOUR) ?? [])) {
      const lower = literal.toLowerCase();
      if (ext === ".ts" || ext === ".tsx" || ext === ".css") {
        failures.push(`colour literal in ${rel(file)}: ${literal} (components consume tokens, they do not declare colour)`);
        continue;
      }
      if (BRAND_ASSETS.has(name)) continue; // the approved parent-brand mark carries its own colours
      if (!ALLOWED_LITERALS.has(lower)) {
        failures.push(`unapproved colour literal in ${rel(file)}: ${literal}`);
      }
    }
  }

  // 4 · No generic blue / indigo / violet / purple / cyan as a product colour.
  for (const literal of new Set(tokenBlock.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [])) {
    const hsl = hexHue(literal);
    if (!hsl) continue;
    if (hsl.hue >= 175 && hsl.hue <= 330 && hsl.sat > 0.12) {
      failures.push(
        `non-West-Peek hue in the token block: ${literal} (hue ${hsl.hue.toFixed(0)}°) — blue, cyan, indigo, violet, and purple may not be product colours`,
      );
    }
  }

  // 5 · The approved mark is actually wired into the primary shell.
  const appPath = join(clientDir, "App.tsx");
  if (!existsSync(appPath)) {
    failures.push("src/client/App.tsx is missing — the shell cannot carry the brand anchor");
  } else if (!readFileSync(appPath, "utf8").includes("/wp-mark.svg")) {
    failures.push("the approved West Peek mark (/wp-mark.svg) is not wired into the primary shell");
  }
  if (!existsSync(join(clientDir, "public", "wp-mark.svg"))) {
    failures.push("approved West Peek mark asset is missing: src/client/public/wp-mark.svg");
  }

  return failures;
}

/* ── self-test ────────────────────────────────────────────────────────────────
   Each fixture plants exactly one violation and asserts the scan names it. If a rule is ever
   narrowed, its fixture must still fail — that is what stops the scan from quietly going blind. */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";

function fixtureRoot() {
  const dir = mkdtempSync(join(tmpdir(), "wp-brand-"));
  mkdirSync(join(dir, "src", "client", "public"), { recursive: true });
  cpSync(join(ROOT, "WEST_PEEK_BRAND_SYSTEM.md"), join(dir, "WEST_PEEK_BRAND_SYSTEM.md"));
  cpSync(join(ROOT, "src", "client", "public", "wp-mark.svg"), join(dir, "src", "client", "public", "wp-mark.svg"));
  writeFileSync(
    join(dir, "src", "client", "styles.css"),
    `:root {\n  --wp-orange: ${CANONICAL_ORANGE};\n  --wp-ink: #15120f;\n}\n\n.card { color: var(--wp-ink); }\n`,
  );
  writeFileSync(join(dir, "src", "client", "App.tsx"), `export const mark = "/wp-mark.svg";\n`);
  return dir;
}

function selfTest() {
  const cases = [
    {
      name: "a clean fixture passes",
      mutate: () => {},
      expect: (f) => f.length === 0,
      describe: "no failures",
    },
    {
      name: "a colour literal in a CSS rule is caught",
      mutate: (dir) => {
        const p = join(dir, "src", "client", "styles.css");
        writeFileSync(p, readFileSync(p, "utf8") + `\n.rogue { background: #123456; }\n`);
      },
      expect: (f) => f.some((x) => x.includes("outside the token block") && x.includes("#123456")),
      describe: "colour literal outside the token block",
    },
    {
      name: "a colour literal in a component is caught",
      mutate: (dir) => {
        writeFileSync(join(dir, "src", "client", "Rogue.tsx"), `export const s = { color: "#abcdef" };\n`);
      },
      expect: (f) => f.some((x) => x.includes("Rogue.tsx") && x.includes("#abcdef")),
      describe: "colour literal in a component",
    },
    {
      name: "a stale West Peek orange is caught even in an allowed file",
      mutate: (dir) => {
        writeFileSync(join(dir, "src", "client", "public", "manifest.webmanifest"), `{ "theme_color": "#ff7a00" }\n`);
      },
      expect: (f) => f.some((x) => x.includes("stale West Peek orange #ff7a00")),
      describe: "stale orange",
    },
    {
      name: "a generic blue token is caught",
      mutate: (dir) => {
        const p = join(dir, "src", "client", "styles.css");
        writeFileSync(p, readFileSync(p, "utf8").replace("--wp-ink: #15120f;", "--wp-ink: #15120f;\n  --wp-link: #7fa8c9;"));
      },
      expect: (f) => f.some((x) => x.includes("non-West-Peek hue") && x.includes("#7fa8c9")),
      describe: "generic blue token (the exact pre-overhaul drift)",
    },
    {
      name: "a purple token is caught",
      mutate: (dir) => {
        const p = join(dir, "src", "client", "styles.css");
        writeFileSync(p, readFileSync(p, "utf8").replace("--wp-ink: #15120f;", "--wp-ink: #15120f;\n  --wp-private: #6b5b95;"));
      },
      expect: (f) => f.some((x) => x.includes("non-West-Peek hue") && x.includes("#6b5b95")),
      describe: "purple token (the exact pre-overhaul drift)",
    },
    {
      name: "a warm brand hue is NOT flagged as a blue",
      mutate: (dir) => {
        const p = join(dir, "src", "client", "styles.css");
        writeFileSync(p, readFileSync(p, "utf8").replace("--wp-ink: #15120f;", "--wp-ink: #15120f;\n  --wp-good: #1f6b45;\n  --wp-warn: #8a5200;\n  --wp-danger: #97231b;"));
      },
      expect: (f) => f.length === 0,
      describe: "semantic green / amber / red survive the hue rule",
    },
    {
      name: "an unwired brand mark is caught",
      mutate: (dir) => {
        writeFileSync(join(dir, "src", "client", "App.tsx"), `export const mark = "/some-other-logo.png";\n`);
      },
      expect: (f) => f.some((x) => x.includes("not wired into the primary shell")),
      describe: "brand anchor missing from the shell",
    },
    {
      name: "a gutted brand authority is caught",
      mutate: (dir) => {
        writeFileSync(join(dir, "WEST_PEEK_BRAND_SYSTEM.md"), "# West Peek Brand System\n\nnothing here\n");
      },
      expect: (f) => f.some((x) => x.includes("canonical orange #F05A1A missing")) && f.some((x) => x.includes("governing rule missing")),
      describe: "brand authority hollowed out",
    },
  ];

  let passed = 0;
  const problems = [];
  for (const c of cases) {
    const dir = fixtureRoot();
    try {
      c.mutate(dir);
      const failures = scan(dir);
      if (c.expect(failures)) passed += 1;
      else problems.push(`${c.name} — expected ${c.describe}, got: ${JSON.stringify(failures)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (problems.length) {
    console.error("brand-system self-test FAILED:\n- " + problems.join("\n- "));
    process.exit(1);
  }
  console.log(`brand-system self-test passed: ${passed}/${cases.length} planted violations caught`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const failures = scan(ROOT);
  if (failures.length) {
    console.error("West Peek brand-system validation FAILED:\n- " + failures.join("\n- "));
    process.exit(1);
  }
  console.log(
    "West Peek brand-system validation passed: authority present, canonical orange declared, " +
      "colour declared only in the token block, no stale orange, no blue/purple/cyan product colour, " +
      "approved mark wired into the shell.",
  );
}
