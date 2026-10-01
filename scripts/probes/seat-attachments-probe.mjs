#!/usr/bin/env node
/**
 * CAN A SUBSCRIPTION SEAT READ A PICTURE AND A PDF, HEADLESSLY? — a probe for the owner's Mac (1 Oct 2026).
 *
 *   node scripts/probes/seat-attachments-probe.mjs            run both seats against both file types
 *   node scripts/probes/seat-attachments-probe.mjs --seat codex
 *   node scripts/probes/seat-attachments-probe.mjs --self-test no CLIs, no network
 *
 * WHY A PROBE FIRST. A seat may be handed a picture or a document only if the CLI can actually read the file
 * headlessly on THIS machine — which cannot be established from the cloud sandbox this repo is built in. The
 * transport exists (0249); what this probe PROVES is what switches it on: it writes
 * ~/.west-peek-os/seat-attachments-proof.json, the claimer declares `read_image:<seat>` / `read_document:<seat>`
 * from exactly that file, and the Worker offers a seat a file only for what it declared. No proof, no file.
 * Nothing here touches the repo.
 *
 * WHAT IT DOES. Writes a solid-RED PNG and a one-page PDF whose only text is a code word into a temporary
 * directory, asks each installed seat to read the file by path and report what it saw, and checks the
 * answer for the thing only a model that really read the file could know. It spends a little of each plan.
 *
 *   Codex   `codex exec -i <png>` for the picture; the PDF by path with a read-only sandbox.
 *   Claude  `claude -p` with the Read tool pre-approved, which reads images and PDFs by path.
 *
 * A seat whose plan is out of usage is reported UNTESTED, never FAILED: a limit says nothing about
 * capability. The flags are from each tool's documented surface and are UNPROVEN until this has run.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { detectUsageLimit } from "../lib/seat-usage-limit.mjs";
import { claudeChildEnv } from "../lib/vault-env.mjs";
import { claudeAttachArgs, codexAttachArgs, mergeProof, proofPath, readProof, writeProof } from "../lib/seat-attachments.mjs";

export const PDF_CODE_WORD = "ZEBRA-7421";
const RUN_TIMEOUT_MS = 180_000;

// ── Pure parts ───────────────────────────────────────────────────────────────────────────────

let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A solid-colour RGB PNG. The only thing a model that really looked at it can say is the colour. */
export function solidPng(width, height, [r, g, b]) {
  const rowLen = 1 + width * 3;
  const raw = Buffer.alloc(rowLen * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowLen] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * rowLen + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A one-page PDF whose only text is `text`. Hand-built so the probe has no dependency. */
export function textPdf(text) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** What a correct reading looks like, per file type. */
export function verdictFor(kind, answer) {
  const a = String(answer ?? "").toLowerCase();
  if (kind === "image") return /\bred\b/.test(a);
  if (kind === "pdf") return a.includes(PDF_CODE_WORD.toLowerCase());
  return false;
}

/*
 * THE SAME INVOCATION THE CLAIMER USES, from one module (`scripts/lib/seat-attachments.mjs`): what this probe proves
 * is exactly what a real run later does, not a look-alike.
 */
export function codexArgs(kind, filePath, prompt) {
  return codexAttachArgs([{ kind: kind === "image" ? "image" : "document", path: filePath, name: path.basename(filePath) }], prompt);
}

export function claudeArgs(prompt) {
  return claudeAttachArgs(prompt);
}

export function promptFor(kind, fileName, seat = "codex") {
  if (kind === "image") {
    // Codex is handed the picture with -i, so it is "attached"; Claude Code reads it by path with Read.
    return seat === "codex"
      ? "Look at the attached image and reply with ONE word: the colour that fills it."
      : `Open the image file ./${fileName} in the current directory and reply with ONE word: the colour that fills it.`;
  }
  return `Open the file ./${fileName} in the current directory and reply with ONLY the code word printed on its page.`;
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────

function runCli(bin, args, cwd) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let done = false;
    let child;
    try {
      child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: claudeChildEnv(process.env) });
    } catch (e) {
      resolve({ started: false, out: "", err: String(e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill("SIGKILL");
      resolve({ started: true, timedOut: true, out, err });
    }, RUN_TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ started: false, out, err: `${err}${e.message}` });
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ started: true, code, out, err });
    });
  });
}

/** PROVEN / FAILED / UNTESTED for one seat and one file type. Pure given the CLI's result. */
export function judge(kind, result) {
  if (!result.started) return { status: "UNTESTED", why: `the CLI could not be started: ${result.err}` };
  if (result.timedOut) return { status: "FAILED", why: "no answer within the time limit" };
  const limit = detectUsageLimit({ stdout: result.out, stderr: result.err });
  if (limit.limited) return { status: "UNTESTED", why: `the plan is out of usage: ${limit.snippet}` };
  if (verdictFor(kind, result.out)) return { status: "PROVEN", why: "the answer contains what only a model that read the file could say" };
  return { status: "FAILED", why: `the answer did not show the file was read: ${String(result.out).trim().slice(0, 160) || "(empty)"}` };
}

async function main() {
  const only = process.argv.includes("--seat") ? process.argv[process.argv.indexOf("--seat") + 1] : null;
  const dir = mkdtempSync(path.join(tmpdir(), "wp-seat-attachments-"));
  try {
    writeFileSync(path.join(dir, "probe.png"), solidPng(64, 64, [220, 20, 20]));
    writeFileSync(path.join(dir, "probe.pdf"), textPdf(PDF_CODE_WORD));
    const rows = [];
    for (const seat of ["codex", "claude_code"]) {
      if (only && only !== seat) continue;
      for (const kind of ["image", "pdf"]) {
        const file = kind === "image" ? "probe.png" : "probe.pdf";
        const prompt = promptFor(kind, file, seat);
        const result =
          seat === "codex"
            ? await runCli("codex", codexArgs(kind, path.join(dir, file), prompt), dir)
            : await runCli("claude", claudeArgs(prompt), dir);
        const verdict = judge(kind, result);
        rows.push({ seat, kind, ...verdict });
        console.log(`${verdict.status.padEnd(8)} ${seat.padEnd(12)} ${kind.padEnd(6)} ${verdict.why}`);
      }
    }
    const proven = rows.filter((r) => r.status === "PROVEN").length;
    /*
     * THE PROOF FILE (0249). What this run PROVED is written where the claimer reads it, and the claimer declares
     * exactly those capabilities to the Worker — nothing else ever makes a seat eligible for a file. UNTESTED rows
     * change nothing (a plan out of usage says nothing about capability); a FAILED row withdraws an earlier proof.
     */
    if (rows.length > 0) {
      writeProof(mergeProof(readProof(), rows));
      console.log(`\nProof written to ${proofPath()}. Restart nothing: the claimer re-reads it every cycle.`);
    }
    console.log(`\n${proven} of ${rows.length} combinations PROVEN. A seat is offered a file only for the combinations PROVEN here.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function selfTest() {
  const png = solidPng(8, 8, [255, 0, 0]);
  const pdf = textPdf(PDF_CODE_WORD);
  const cases = [
    ["the PNG has the PNG signature and an IEND chunk", () => png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.subarray(-12, -8).readUInt32BE(0) === 0 && png.includes(Buffer.from("IEND"))],
    ["the PDF has a header, the code word and an EOF", () => pdf.toString("latin1").startsWith("%PDF-1.4") && pdf.toString("latin1").includes(PDF_CODE_WORD) && pdf.toString("latin1").trimEnd().endsWith("%%EOF")],
    ["an image answer of 'Red.' is a correct reading, 'blue' is not", () => verdictFor("image", "Red.") && !verdictFor("image", "blue")],
    ["a PDF answer must carry the code word; a plausible guess does not", () => verdictFor("pdf", `The code is ${PDF_CODE_WORD}`) && !verdictFor("pdf", "I cannot open PDFs")],
    ["a usage limit is UNTESTED, never FAILED", () => judge("image", { started: true, code: 1, out: "You've hit your weekly limit · resets Oct 2 at 8am", err: "" }).status === "UNTESTED"],
    ["a missing CLI is UNTESTED", () => judge("pdf", { started: false, out: "", err: "spawn codex ENOENT" }).status === "UNTESTED"],
    ["a wrong answer is FAILED with what it said", () => { const j = judge("image", { started: true, code: 0, out: "Blue", err: "" }); return j.status === "FAILED" && /Blue/.test(j.why); }],
    ["the Claude image prompt names the file path, because Claude reads it with Read rather than being handed it", () => /\.\/probe\.png/.test(promptFor("image", "probe.png", "claude_code")) && !/attached/.test(promptFor("image", "probe.png", "claude_code"))],
    ["the Codex image run passes the picture with -i and the PDF run does not", () => codexArgs("image", "/x.png", "p").includes("-i") && !codexArgs("pdf", "/x.pdf", "p").includes("-i")],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) { console.error(`SELF-TEST FAILED: ${failed} of ${cases.length}`); process.exit(1); }
  console.log(`SELF-TEST PASSED: ${cases.length} cases`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });
}
