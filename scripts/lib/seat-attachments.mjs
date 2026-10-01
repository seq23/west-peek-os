/**
 * HANDING A FILE TO A SUBSCRIPTION SEAT, AND ONLY WHEN THIS MACHINE HAS PROVEN IT WORKS (0249, 1 Oct 2026).
 *
 * One module for the three things the claimer and the probe must agree on, so the probe proves exactly the
 * invocation the claimer later uses:
 *
 *   · the CLI arguments and the prompt wording for a run that carries files;
 *   · the PROOF FILE the probe writes after a seat really read a file here, and how it becomes capabilities;
 *   · the safe file name to write a downloaded attachment under.
 *
 * Nothing here talks to the network. The Worker never offers a file to a seat whose claimer did not declare
 * `read_image:<seat>` / `read_document:<seat>`, and this file is the only place those declarations come from.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/** A proof older than this is not a proof: a CLI update can change what it reads. */
export const PROOF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function proofPath(home = homedir()) {
  return path.join(home, ".west-peek-os", "seat-attachments-proof.json");
}

/** The proof file's contents, or null when there is none or it is unreadable. Never throws. */
export function readProof(home = homedir()) {
  try {
    const p = proofPath(home);
    if (!existsSync(p)) return null;
    const j = JSON.parse(readFileSync(p, "utf8"));
    return j && typeof j === "object" && j.seats && typeof j.seats === "object" ? j : null;
  } catch {
    return null;
  }
}

/**
 * Fold one probe run into the proof on disk. PROVEN sets true, FAILED sets false, and UNTESTED changes nothing —
 * a plan that was out of usage when the probe ran says nothing about whether the seat can read a file.
 * `rows` are the probe's `{ seat, kind: "image" | "pdf", status }`.
 */
export function mergeProof(previous, rows, nowMs = Date.now()) {
  const seats = { ...(previous?.seats ?? {}) };
  for (const r of rows) {
    if (r.status === "UNTESTED") continue;
    seats[r.seat] = { ...(seats[r.seat] ?? {}), [r.kind]: r.status === "PROVEN" };
  }
  return { at: new Date(nowMs).toISOString(), seats };
}

export function writeProof(proof, home = homedir()) {
  const p = proofPath(home);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
}

/**
 * The capability tokens a proof earns, e.g. ["read_image:codex"]. An absent, stale or unreadable proof earns none:
 * the safe direction is a file that goes to a lane that can see rather than to a seat that cannot.
 */
export function capabilitiesFromProof(proof, nowMs = Date.now()) {
  if (!proof?.seats || typeof proof.seats !== "object") return [];
  const at = Date.parse(String(proof.at ?? ""));
  if (!Number.isFinite(at) || nowMs - at > PROOF_MAX_AGE_MS || at > nowMs + 60_000) return [];
  const out = [];
  for (const seat of ["claude_code", "codex"]) {
    const s = proof.seats[seat];
    if (!s) continue;
    if (s.image === true) out.push(`read_image:${seat}`);
    if (s.pdf === true) out.push(`read_document:${seat}`);
  }
  return out;
}

/** A name that is a plain file name: no directory, no leading dash or dot, nothing but safe characters. */
export function safeFileName(label, n) {
  const base = path.basename(String(label ?? ""));
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 80);
  return cleaned || `file-${n + 1}`;
}

/** Which proven kinds this run needs, as the tokens the claimer must hold for the seat. */
export function requiredCapabilities(seat, attachments) {
  const need = new Set();
  for (const a of attachments ?? []) need.add(a.kind === "image" ? `read_image:${seat}` : `read_document:${seat}`);
  return [...need];
}

/** The first token this claimer lacks for the run's files, or null when it holds them all. */
export function missingCapability(seat, attachments, held) {
  return requiredCapabilities(seat, attachments).find((t) => !held.includes(t)) ?? null;
}

/**
 * Codex: pictures go with `-i`, documents are read by path from the working directory. The same shape the probe
 * proves. `files` is `[{ kind: "image" | "document", path, name }]`.
 */
export function codexAttachArgs(files, prompt) {
  const base = ["exec", "--skip-git-repo-check", "--sandbox", "read-only"];
  const images = files.filter((f) => f.kind === "image").flatMap((f) => ["-i", f.path]);
  return [...base, ...images, prompt];
}

/** Claude Code reads every file by path with the Read tool, which handles pictures and PDFs. */
export function claudeAttachArgs(prompt) {
  return ["-p", prompt, "--allowedTools", "Read"];
}

/** The sentence added to a run's prompt naming its files, in the words each seat needs. */
export function attachmentNote(seat, files) {
  const lines = files.map((f) => {
    if (seat === "codex" && f.kind === "image") return `- the attached image "${f.name}"`;
    return `- ${f.kind === "image" ? "the image" : "the document"} ./${f.name} in the current directory (open it and read it)`;
  });
  return `Files for this task — read them before you answer, and say so plainly if one cannot be read rather than guessing at its contents:\n${lines.join("\n")}`;
}
