/**
 * WHICH ROUTE DOES A MAC JOB'S TURN — ONE PLACE (owner, 13 Nov 2026).
 *
 * Two routes exist on the Mac: Claude Code (`claude -p`, her Claude seat) and Codex (`codex exec`, signed in with
 * her ChatGPT plan, never an API key). Which goes first is NOT decided here: it is the row of the ONE rule table,
 * `src/shared/ai/modelOrder.json`, that the Worker's router reads too. This file only works out which row a turn
 * takes:
 *
 *   1. JOB CLASS, from `scripts/claimer/model-roles.json`: kind × phase → HARD, CLEAR_BRIEF or SHORT. A kind or
 *      phase the table does not name is HARD. No classifier, and no rule names a model.
 *   2. PRIVATE OR NOT. Private when the Worker marked the job (`private_model_only`: it names a COMMITTED LP — owner
 *      ruling 4 Nov 2026), when any text the model would be handed carries a deal-term or fund-figure marker, or
 *      when a file beside the job cannot be read (a PDF, a spreadsheet, too many files). Doubt resolves to private.
 *      THIS CHECK COMES FIRST AND NOTHING IN THE TABLE CAN OVERRIDE IT.
 *
 *   Not private:  HARD        → Claude, then Codex. What Codex did is HELD until Claude has checked it: it does not
 *                               land or reach a partner first.
 *                 CLEAR_BRIEF → Codex, then Claude.
 *                 SHORT       → Codex, then Claude (the free lanes run in the Worker; the Mac has none).
 *   Private:      HARD        → Claude only. With Claude out of usage the turn WAITS for Claude by name; it never
 *                               goes to Codex, and the wait is not a failed attempt.
 *                 CLEAR_BRIEF and SHORT → Claude, then Codex as its backup (owner, 13 Nov 2026: "all private stuff
 *                               can go through codex i need a backup to claude").
 *
 * A SPENT PLAN IS A WAIT, NEVER A FAILURE. A route that says its plan is spent hands the turn to the next route in
 * the row; when the row runs out the turn ends with the notices and how long until the earlier reset, and the
 * Worker holds the card until then.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROLES_FILE = fileURLToPath(new URL("../claimer/model-roles.json", import.meta.url));
/** The one rule table, shared with the Worker's router (src/shared/ai/seatOrder.ts). */
export const ORDER_FILE = fileURLToPath(new URL("../../src/shared/ai/modelOrder.json", import.meta.url));
export const JOB_CLASSES = ["HARD", "CLEAR_BRIEF", "SHORT"];
/** The Mac's name for each seat in the table. A seat the Mac cannot run takes no part. */
const MAC_ROUTE = { claude_code: "claude", codex: "codex" };
export const CODEX_LIMIT_EXIT = 75;
export const CODEX_LIMIT_TAG = "NAMED STOP [CODEX_LIMIT]";

/** The one table. `text` is injectable so a test can hand it a variant. */
export function loadRoles(text = readFileSync(ROLES_FILE, "utf8"), orderText = readFileSync(ORDER_FILE, "utf8")) {
  const cfg = { ...JSON.parse(text), table: JSON.parse(orderText) };
  const markers = (cfg.confidential_markers ?? []).map((m) => new RegExp(m, "i"));
  if (markers.length === 0) throw new Error(`${ROLES_FILE} names no confidential markers — refusing to route anything without them`);
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

/** The job class of a kind's phase: what the table names, and HARD for anything it does not. */
export function jobClassFor(kind, phase, roles = loadRoles()) {
  const named = roles.jobs?.[String(kind ?? "")]?.[String(phase ?? "")];
  return JOB_CLASSES.includes(named) ? named : (roles.table.default_class ?? "HARD");
}

/**
 * The route order for one model turn: `{ jobClass, private, workClass, order, held, role, why }`.
 * `order` is the routes in the order they are tried ("claude" | "codex"); `held` says a Codex result of this turn
 * waits for Claude's check; `role` is who leads ("brain" = Claude, "worker" = Codex).
 */
export function routeFor({ kind, phase, prompt, materialDirs = [], privateModelOnly = false }, roles = loadRoles()) {
  const jobClass = jobClassFor(kind, phase, roles);
  // THE PRIVACY CHECK, FIRST. The Worker read the commitment records; the markers and the files are read here.
  const hit = privateModelOnly === true ? null : confidentialMarkerIn(prompt, roles);
  const block = privateModelOnly === true || hit ? null : materialsBlock(materialDirs, roles);
  const reason =
    privateModelOnly === true
      ? "the Worker marked this job private (it names a committed LP)"
      : hit
        ? `the prompt contains "${hit}"`
        : block;
  const isPrivate = Boolean(reason);
  const cls = roles.table.classes[jobClass] ?? roles.table.classes[roles.table.default_class];
  const workClass = isPrivate ? cls.private : cls.open;
  const order = (roles.table.order[workClass]?.seats ?? []).map((seat) => MAC_ROUTE[seat]).filter(Boolean);
  if (order.length === 0) throw new Error(`${ORDER_FILE} names no route the Mac can run for ${workClass}`);
  const held = !isPrivate && order[0] === "claude" && (roles.table.codex_result_checked_by_claude ?? []).includes(workClass);
  const label = `${kind ?? "?"} ${phase ?? "?"}`;
  const names = order.map((r) => (r === "claude" ? "Claude" : "Codex")).join(", then ");
  const why = !isPrivate
    ? `${label} is ${jobClass} work: ${names}${held ? " (what Codex does waits for Claude's check)" : ""}`
    : order.includes("codex")
      ? `${label} is private ${jobClass} work (${reason}): ${names} as its backup; never a free lane`
      : `kept on Claude: ${reason}, and ${label} is hard work. Private hard work waits for Claude and never goes to Codex`;
  return { jobClass, private: isPrivate, workClass, order, held, role: order[0] === "codex" ? "worker" : "brain", why };
}

/** The limit notice a worker run carried, or null. `spent` reads the CLI's own words. */
export function workerLimit(result, spent = () => null) {
  const text = `${result?.out ?? ""}\n${result?.err ?? ""}`;
  const named = text.match(/NAMED STOP \[CODEX_LIMIT\][^\n]*/);
  if (named) return named[0].trim();
  if (result?.code === CODEX_LIMIT_EXIT) return `${CODEX_LIMIT_TAG} (exit ${CODEX_LIMIT_EXIT})`;
  return spent(result) ?? null;
}

export const CLAUDE_CHECK_TAG = "NAMED WAIT [CLAUDE_CHECK]";

/**
 * Run one turn down its row. Side effects injected: `runBrain`, `runWorker` → `{ code, out, err }`;
 * `brainSpent` / `workerSpent` read a spent-plan notice (or null); `workerUsable` says whether Codex is signed in
 * with the ChatGPT plan; `resetsIn(notices)` reads the earliest reset.
 *
 * A route whose plan is spent, or that cannot run, hands the turn to the next route in the row. Any other result,
 * a failure included, IS the turn's result: a failed build is not handed to a second route to fail again.
 * Returns the result plus `servedBy` ("claude" | "codex" | "none") and:
 *   · `heldForClaude` + `resetsInSeconds` when Codex did a turn whose row says Claude checks it first;
 *   · `bothSpent` + `resetsInSeconds` when every route in the row is out of usage;
 *   · the Claude run itself (servedBy "claude") when Claude is spent and nothing may stand in: the caller reads the
 *     notice from it and waits.
 */
export async function runInOrder({ route, runBrain, runWorker, brainSpent = () => null, workerSpent, workerUsable = () => ({ ok: true, why: "" }), resetsIn = () => 3600, onLine }) {
  onLine?.(route.why);
  const notices = [];
  const said = [];
  let last = null;
  let claudeRun = null;
  for (const name of route.order) {
    if (name === "claude") {
      const r = await runBrain();
      const limit = brainSpent(r);
      if (!limit) return { ...r, servedBy: "claude", role: route.role };
      notices.push(limit);
      said.push(`Claude Code said: ${limit}.`);
      claudeRun = r;
      last = r;
      continue;
    }
    const seat = workerUsable();
    if (!seat.ok) {
      said.push(`Codex cannot take it: ${seat.why}.`);
      continue;
    }
    if (notices.length) onLine?.(`Claude Code is out of usage (${notices[0]}); handing this turn to Codex on her ChatGPT plan, same worktree, same prompt`);
    const r = await runWorker();
    const limit = workerLimit(r, workerSpent);
    if (!limit) {
      if (!route.held) return { ...r, servedBy: "codex", role: route.role };
      return {
        ...r,
        servedBy: "codex",
        role: route.role,
        heldForClaude: `${CLAUDE_CHECK_TAG} Codex did this turn while Claude Code was out of usage (${notices[0] ?? "no notice"}). It is hard work, so Claude checks it before it lands or reaches a partner; the turn is retried when Claude's plan resets.`,
        resetsInSeconds: resetsIn(notices),
      };
    }
    notices.push(limit);
    said.push(`Codex said: ${limit}.`);
    last = r;
  }
  // Claude is spent and no other route in the row ran: its own run is the result, and the caller waits on its notice.
  if (claudeRun && notices.length === 1) {
    const rest = said.slice(1).join(" ");
    const whyNot = rest || (route.order.includes("codex") ? "" : "This turn runs on Claude only, so it waits for Claude; Codex does not take it.");
    return { ...claudeRun, err: `${claudeRun.err ?? ""}\n[${whyNot}]`, servedBy: "claude", role: route.role };
  }
  if (notices.length === 0) return { code: 1, out: "", err: said.join(" ") || "no route in this row could run", servedBy: "none", role: route.role };
  const both = notices.length > 1;
  return {
    ...(last ?? { out: "" }),
    code: last?.code ? last.code : 1,
    err: `${last?.err ?? ""}\n[${both ? "Both subscription seats are out of usage" : "The only route that could take this turn is out of usage"}. ${said.join(" ")} This turn cannot run until a plan resets — it is retried then.]`,
    servedBy: "none",
    role: route.role,
    bothSpent: true,
    resetsInSeconds: resetsIn(notices),
  };
}
