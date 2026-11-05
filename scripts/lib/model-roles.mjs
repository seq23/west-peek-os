/**
 * WHO DOES THE WORK ON THE MAC — ONE PLACE (owner, 3 Nov 2026: "after today we need to default OpenAI
 * and Claude just be the brains").
 *
 *   worker  Codex on her ChatGPT plan (`codex exec`): hands-on work — edits, builds, repairs, landing.
 *   brain   Claude Code (`claude -p`): planning, deciding, reviewing, brain writes.
 *
 * The table is `scripts/claimer/model-roles.json`, read here and nowhere else. The local-job claimer
 * refuses a job kind the table does not name; the duty asks `routeFor` before every model turn.
 *
 * THE PRIVACY GATE COMES FIRST AND CANNOT BE OVERRIDDEN BY THE TABLE. The worker route's no-training
 * basis is an account SETTING, not a contractual bar (migration 0187), so unless the config records it
 * as proven, the worker counts as a training-permitting route. A turn goes to it only when the Worker has
 * not marked the job private (`private_model_only`: it names a COMMITTED LP — owner ruling 4 Nov 2026), EVERY
 * text the model would be handed has been read and none of it carries a deal-term or fund-figure marker,
 * and every file beside it is either scannable text without a marker or an image. LP prospects, brand and
 * TLC work are not confidential and may go to the worker. Anything that cannot
 * be read (a PDF, a spreadsheet, too many files, an unreadable file) keeps the turn on the brain.
 * A false positive costs one Claude run; a false negative would be permanent. That asymmetry is why
 * the markers are broad and the doubt resolves to the brain.
 *
 * A CODEX LIMIT IS A WAIT, NEVER A HAND-OVER. When the worker says its plan is spent (`ai-run` exits
 * 75 with `NAMED STOP [CODEX_LIMIT] resets <time>`, or `codex exec` prints the notice), the turn ends
 * with that named stop and a reset time; the Worker holds the card and the next run retries it.
 * Claude is never called in its place.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROLES_FILE = fileURLToPath(new URL("../claimer/model-roles.json", import.meta.url));
export const CODEX_LIMIT_EXIT = 75;
export const CODEX_LIMIT_TAG = "NAMED STOP [CODEX_LIMIT]";

/** The one table. `text` is injectable so a test can hand it a variant. */
export function loadRoles(text = readFileSync(ROLES_FILE, "utf8")) {
  const cfg = JSON.parse(text);
  const markers = (cfg.confidential_markers ?? []).map((m) => new RegExp(m, "i"));
  if (markers.length === 0) throw new Error(`${ROLES_FILE} names no confidential markers — refusing to route anything to the worker without them`);
  return { ...cfg, markers };
}

/** The marker found in a text, or null. */
export function confidentialMarkerIn(text, roles = loadRoles()) {
  const s = String(text ?? "");
  for (const re of roles.markers) {
    const m = s.match(re);
    if (m) return m[0];
  }
  return null;
}

/** Why the files in these folders cannot go to the worker, or null when every one was read and is clean. */
export function materialsBlock(dirs, roles = loadRoles()) {
  const textExt = new Set(roles.scannable_extensions ?? []);
  const imageExt = new Set(roles.image_extensions ?? []);
  const maxFiles = Number(roles.max_material_files ?? 2000);
  const maxBytes = Number(roles.max_scan_bytes ?? 2 * 1024 * 1024);
  let seen = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return `${dir} could not be listed`;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const why = walk(p);
        if (why) return why;
        continue;
      }
      if (++seen > maxFiles) return `more than ${maxFiles} files beside the job, too many to read`;
      const ext = path.extname(e.name).slice(1).toLowerCase();
      if (imageExt.has(ext)) continue;
      if (!textExt.has(ext)) return `${e.name} cannot be read for confidential text`;
      let st;
      try {
        st = statSync(p);
      } catch {
        return `${e.name} could not be read`;
      }
      if (st.size > maxBytes) return `${e.name} is too large to read for confidential text`;
      const hit = confidentialMarkerIn(readFileSync(p, "utf8"), roles);
      if (hit) return `${e.name} contains "${hit}"`;
    }
    return null;
  };
  for (const d of dirs ?? []) {
    if (!d || !existsSync(d)) continue;
    const why = walk(d);
    if (why) return why;
  }
  return null;
}

/**
 * The role for one model turn: `{ role: "worker"|"brain", why }`.
 *   1. The table: kind × phase, anything unnamed is brain.
 *   2. The privacy gate, only for a worker turn, unless the worker route is recorded as no-training.
 */
export function routeFor({ kind, phase, prompt, materialDirs = [], privateModelOnly = false }, roles = loadRoles()) {
  const want = roles.jobs?.[String(kind ?? "")]?.[String(phase ?? "")] ?? roles.default_role ?? "brain";
  if (want !== "worker") return { role: "brain", why: `${kind ?? "?"} ${phase ?? "?"} is planning or review — Claude` };
  if (roles.worker_route?.no_training_proven === true) return { role: "worker", why: `${kind} ${phase} is hands-on — Codex` };
  // The Worker read the commitment records: this job names an LP who has committed to a West Peek fund.
  if (privateModelOnly === true) return { role: "brain", why: "kept on Claude: the Worker marked this job private (it names a committed LP), and Codex on her ChatGPT plan is not proven no-training" };
  const hit = confidentialMarkerIn(prompt, roles);
  if (hit) return { role: "brain", why: `kept on Claude: the prompt contains "${hit}", and Codex on her ChatGPT plan is not proven no-training` };
  const block = materialsBlock(materialDirs, roles);
  if (block) return { role: "brain", why: `kept on Claude: ${block}, and Codex on her ChatGPT plan is not proven no-training` };
  return { role: "worker", why: `${kind} ${phase} is hands-on — Codex` };
}

/** The limit notice a worker run carried, or null. `spent` reads the CLI's own words. */
export function workerLimit(result, spent = () => null) {
  const text = `${result?.out ?? ""}\n${result?.err ?? ""}`;
  const named = text.match(/NAMED STOP \[CODEX_LIMIT\][^\n]*/);
  if (named) return named[0].trim();
  if (result?.code === CODEX_LIMIT_EXIT) return `${CODEX_LIMIT_TAG} (exit ${CODEX_LIMIT_EXIT})`;
  return spent(result) ?? null;
}

/**
 * Run one turn on its role. Side effects injected: `runBrain`, `runWorker` → `{ code, out, err }`.
 * Returns that plus `servedBy` ("claude" | "codex" | "none") and, on a Codex limit, `codexLimited`
 * with `resetsInSeconds` — and Claude is NOT called.
 */
export async function runByRole({ route, runBrain, runWorker, workerSpent, resetsIn, onLine }) {
  onLine?.(route.why);
  if (route.role !== "worker") return { ...(await runBrain()), servedBy: "claude", role: "brain" };
  const r = await runWorker();
  const limit = workerLimit(r, workerSpent);
  if (!limit) return { ...r, servedBy: "codex", role: "worker" };
  const note = limit.startsWith(CODEX_LIMIT_TAG) ? limit : `${CODEX_LIMIT_TAG} ${limit}`;
  return {
    ...r,
    code: r.code === 0 ? 1 : r.code,
    err: `${r.err ?? ""}\n${note} — the work waits for the reset and is retried; Claude does not take it over.`,
    servedBy: "none",
    role: "worker",
    codexLimited: note,
    resetsInSeconds: resetsIn ? resetsIn(note) : 3600,
  };
}
