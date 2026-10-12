import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * docs/OUTBOUND_EMAIL_MAP.md is read by code, not trusted (12 Oct 2026).
 *
 * A map of every West Peek sending path is only worth having while it is true. This test holds it
 * to the code in both directions:
 *   - every row parses, every id is unique, and there is at least one row (zero rows is a broken
 *     parse, never a pass);
 *   - every west-peek-os file a row cites exists;
 *   - the Summary table's counts add up to the number of rows;
 *   - a row citing The Industry Guides (local-guides-citation-velocity, theindustryguides.com) must
 *     send from a West Peek address: since 12 Oct 2026 those paths send as The Industry Guides and
 *     live on Boss OS's map, so they cannot drift back here;
 *   - every file in this repo that reaches a mail transport (Resend, Gmail send, the Cloudflare
 *     send_email binding, or a caller of one of those helpers) is cited by some row, so a new
 *     sender cannot land without a row.
 * Rows whose code lives elsewhere (boss-os, west-peek-network-os, westpeek-live, ~/bin, …) start
 * their Code cell with "other repo" and are skipped by the file-exists check only.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAP = "docs/OUTBOUND_EMAIL_MAP.md";

interface MapRow {
  id: string;
  from: string;
  code: string;
  status: string;
}

function parseMapRows(markdown: string): MapRow[] {
  const lines = markdown.split("\n");
  const header = lines.findIndex((l) => /^\|\s*Id\s*\|/.test(l));
  if (header < 0) return [];
  const cols = lines[header]!.split("|").slice(1, -1).map((c) => c.trim());
  const codeAt = cols.findIndex((c) => /^Code location$/i.test(c));
  const statusAt = cols.findIndex((c) => /^Status$/i.test(c));
  const fromAt = cols.findIndex((c) => /^From$/i.test(c));
  const rows: MapRow[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const id = /^`([a-z0-9-]+)`$/.exec(cells[0] ?? "")?.[1] ?? "";
    rows.push({ id, from: cells[fromAt] ?? "", code: cells[codeAt] ?? "", status: cells[statusAt] ?? "" });
  }
  return rows;
}

/** Sum of the "Paths" column in the Summary table. */
function summaryTotal(markdown: string): number {
  const lines = markdown.split("\n");
  const header = lines.findIndex((l) => /^\|\s*Runs where\s*\|\s*Paths\s*\|/.test(l));
  if (header < 0) return -1;
  let total = 0;
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    total += Number(line.split("|").slice(1, -1).map((c) => c.trim())[1]);
  }
  return total;
}

/** An Industry Guides path, by its Id or Code cell. */
const INDUSTRY_GUIDES = /local-guides-citation-velocity|theindustryguides\.com|industryguides|\blgcv\b/i;
/** A West Peek sending address. */
const WEST_PEEK_FROM = /@(?:[a-z0-9-]+\.)*(?:westpeek\.ventures|joinwestpeek\.com|westpeek\.live)\b/i;

/** Backticked paths in a west-peek-os Code cell. */
function citedFiles(code: string): string[] {
  return [...code.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
}

/** A file reaches a mail transport if it calls one, or IS one. */
const SENDER = new RegExp(
  [
    String.raw`\b(?:sendViaResend|sendViaCloudflare|sendViaGmail|trySendAsPartner)\s*\(`,
    String.raw`api\.resend\.com`,
    String.raw`gmail/v1/users/[^"'\x60\s]*/messages/send`,
    String.raw`\b(?:env\.EMAIL|email|binding)\.send\s*\(`,
    String.raw`api\.(?:sendgrid\.com|mailgun\.net|postmarkapp\.com|mailchannels\.net)`,
    String.raw`from\s+["']nodemailer["']`,
  ].join("|"),
);

const SCAN_ROOTS = ["src", "scripts", "deployment"];
/** Validators and tests quote the patterns they look for; they send nothing. */
const SCAN_SKIP = [/^scripts\/validate\//];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(name)) out.push(rel);
  }
}

function senderFiles(): string[] {
  const files: string[] = [];
  for (const r of SCAN_ROOTS) if (existsSync(path.join(ROOT, r))) walk(r, files);
  return files
    .filter((f) => !SCAN_SKIP.some((re) => re.test(f)))
    .filter((f) => SENDER.test(readFileSync(path.join(ROOT, f), "utf8")))
    .sort();
}

describe("docs/OUTBOUND_EMAIL_MAP.md matches the code", () => {
  const doc = readFileSync(path.join(ROOT, MAP), "utf8");
  const rows = parseMapRows(doc);

  it("says whose map it is and when it was last verified", () => {
    expect(doc).toContain("West Peek only; Boss OS keeps its own map");
    expect(doc).toMatch(/last verified \d{1,2} [A-Z][a-z]{2} 20\d\d/i);
  });

  it("has rows, every one with an id, a code cell and a status", () => {
    expect(rows.length, "zero rows parsed: the table or its header moved").toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.id, `row with no id: ${JSON.stringify(r)}`).not.toBe("");
      expect(r.code, `${r.id}: empty Code location`).not.toBe("");
      expect(r.status, `${r.id}: status`).toMatch(/^(CONFIRMED|SUSPECTED)$/);
    }
  });

  it("has Summary counts that add up to the rows", () => {
    expect(summaryTotal(doc), "Summary table missing or its counts do not match the Inventory").toBe(rows.length);
  });

  it("keeps Industry Guides paths off unless they send from a West Peek address", () => {
    const strays = rows
      .filter((r) => INDUSTRY_GUIDES.test(r.id) || INDUSTRY_GUIDES.test(r.code))
      .filter((r) => !WEST_PEEK_FROM.test(r.from))
      .map((r) => `${r.id}: From "${r.from}"`);
    expect(strays, "Industry Guides rows belong on Boss OS's map").toEqual([]);
    expect(rows.every((r) => r.from !== ""), "a row with no From: the From column moved").toBe(true);
  });

  it("has unique ids", () => {
    const seen = new Set<string>();
    const dupes = rows.map((r) => r.id).filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(dupes).toEqual([]);
  });

  it("cites only west-peek-os files that exist (other-repo rows are skipped)", () => {
    const local = rows.filter((r) => !/^other repo\b/i.test(r.code));
    expect(local.length, "no west-peek-os rows: the map has lost this repo's own senders").toBeGreaterThan(0);
    const missing: string[] = [];
    for (const r of local) {
      const files = citedFiles(r.code);
      if (files.length === 0) missing.push(`${r.id}: no backticked file`);
      for (const f of files) if (!existsSync(path.join(ROOT, f))) missing.push(`${r.id}: ${f}`);
    }
    expect(missing).toEqual([]);
  });

  it("cites every file in this repo that reaches a mail transport", () => {
    const senders = senderFiles();
    expect(senders.length, "the sender scan found nothing: its pattern is broken").toBeGreaterThan(0);
    const cited = new Set(rows.filter((r) => !/^other repo\b/i.test(r.code)).flatMap((r) => citedFiles(r.code)));
    const uncited = senders.filter((f) => !cited.has(f));
    expect(uncited, `sender files with no row in ${MAP}`).toEqual([]);
  });
});
