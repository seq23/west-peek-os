/**
 * THE BRAIN'S SETTLED FACTS, READ ON THE MAC (15 Nov 2026). The west-peek brain lives in Boss OS and is synced to the
 * Mac read-only at ~/Brains/west-peek.md; the Worker does not read it. This takes ONLY its `## Partners` and
 * `## Businesses and projects` sections and the "which business is this word?" lookup (never the whole 11,000-word
 * body), with every `<!-- confidential -->` span removed (an unclosed one removes the rest: fail closed), for the
 * local-jobs claimer to write onto the partner profile through the existing POST /api/partner-profiles/:email. Pure,
 * except `readBrainFacts`, which reads the file.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const BRAIN_PATH = path.join(homedir(), "Brains", "west-peek.md");
export const BRAIN_SECTIONS = ["Partners", "Businesses and projects"];

export function withoutPrivateSpans(text) {
  let rest = String(text ?? "");
  let out = "";
  for (;;) {
    const open = /<!--\s*confidential\s*-->/i.exec(rest);
    if (!open) return out + rest;
    out += rest.slice(0, open.index);
    const after = rest.slice(open.index + open[0].length);
    const close = /<!--\s*\/\s*confidential\s*-->/i.exec(after);
    if (!close) return out;
    rest = after.slice(close.index + close[0].length);
  }
}

/** The `## <prefix>…` section and everything under it, up to the next `## ` heading. */
function level2(lines, prefix) {
  const want = prefix.toLowerCase();
  const start = lines.findIndex((l) => /^##\s+/.test(l) && !/^###/.test(l) && l.replace(/^##\s+/, "").trim().toLowerCase().startsWith(want));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) if (/^##\s+/.test(lines[i]) && !/^###/.test(lines[i])) { end = i; break; }
  return lines.slice(start, end).join("\n");
}

/** { md, missing }: the sections found (joined) and the headings that were not there. */
export function brainFactsFrom(body) {
  const lines = withoutPrivateSpans(body).replace(/\r/g, "").split("\n");
  const parts = [];
  const missing = [];
  for (const h of BRAIN_SECTIONS) {
    const s = level2(lines, h);
    if (s) parts.push(s.trim());
    else missing.push(`## ${h}`);
  }
  const joined = parts.join("\n\n");
  if (!/which business/i.test(joined)) {
    const at = lines.findIndex((l) => /^#{2,4}\s+.*which business/i.test(l));
    if (at < 0) missing.push("which business is this word?");
    else {
      const level = /^(#+)/.exec(lines[at])[1].length;
      let end = lines.length;
      for (let i = at + 1; i < lines.length; i += 1) { const m = /^(#+)\s+/.exec(lines[i]); if (m && m[1].length <= level) { end = i; break; } }
      parts.push(lines.slice(at, end).join("\n").trim());
    }
  }
  return { md: parts.join("\n\n"), missing };
}

/** The file's facts and its modified time, or null when the file is not there. */
export function readBrainFacts(file = BRAIN_PATH) {
  try {
    const mtimeMs = statSync(file).mtimeMs;
    return { mtimeMs, ...brainFactsFrom(readFileSync(file, "utf8")) };
  } catch {
    return null;
  }
}
