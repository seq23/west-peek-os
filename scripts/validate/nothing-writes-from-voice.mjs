#!/usr/bin/env node
/**
 * nothing-writes-from-voice.mjs — `npm run validate:voice-is-read-only`.
 *
 * ONE ASSERTION: NOTHING ASKED IN THE LIVE ROOM — TYPED OR SPOKEN — CAN BECOME A RECORD WITHOUT A
 * PERSON CLICKING TO MAKE IT ONE.
 *
 * WHAT THIS GUARDS (Phase C, owner-approved 18 Sep 2026). The room answers questions, builds tables
 * and charts, and hands employees work — all from a voice or a text box, in a meeting, fast. The
 * one thing it must never do is turn a sentence somebody said into a decision, a commitment, an
 * open question, a stage move, a deal or a company. "AI prepares the decision, humans make it."
 * Phase B built the only door for that — the After draft, approved by a partner — and this scan
 * fails the build if the room grows a second one. Three writes are allowed from an ask, and only
 * three:
 *
 *   (a) a BLOCK on the meeting          saveMeetingArtifact / the artifact's own provenance UPDATE
 *   (b) a WORK CARD, preview-first       createWorkCardInternal (the ordinary door; instruction.ts
 *                                       reads card.prompt before any stage runs)
 *   (c) the After DRAFT                  draftMeetingAfter (a proposal, never a record)
 *
 * plus the append-only event spine, seating (which grants no authority), and the model call.
 *
 * HOW IT READS THE CODE. Comments stripped first (a rule in a comment is not a rule). Then:
 *
 *   1 · THE ROUTE BLOCK exists in index.ts, holds the room's routes, and every handler is one
 *       meetingRoom.ts exports — so the scan is reading the code the routes actually reach.
 *   2 · meetingRoom.ts IMPORTS none of the record-writing functions, by name.
 *   3 · meetingRoom.ts CALLS none of them, by name, anywhere.
 *   4 · every raw SQL write in meetingRoom.ts targets meeting_artifact and nothing else.
 *   5 · every `return {` inside askRoom carries an `artifact` — a question always ends in a saved
 *       block, never in chat that evaporates and never in silence.
 *   6 · the VOICE path (`transcribeWithSpeakers` in liveTranscription.ts) writes nothing at all,
 *       and `captureChunk` reaches the record only through `ingestTranscript` — the two gates.
 *   7 · the During face (RoomPanel.tsx) POSTs only to consent, chunk, roll and ask. No approve, no
 *       decision, no transition is reachable from the panel.
 *
 * HARD-FAILS ON ZERO: zero routes, zero imports read, zero calls examined, zero SQL statements,
 * zero returns in askRoom, zero client POSTs — each exits 1. An empty loop reporting success is the
 * defect this repo calls Rule 0.
 *
 * `--self-test` plants each defect in a fixture and proves it is caught, and proves the shipped
 * source passes.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTsComments } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ROOM = path.join(ROOT, "src", "worker", "services", "meetingRoom.ts");
const LIVE = path.join(ROOT, "src", "worker", "services", "liveTranscription.ts");
const INDEX = path.join(ROOT, "src", "worker", "index.ts");
const PANEL = path.join(ROOT, "src", "client", "pages", "RoomPanel.tsx");

/** Functions that make something a record, or move something. Named, so a violation names them back. */
export const FORBIDDEN_CALLS = [
  // Phase B: the four After objects and the stage proposal
  "recordDecision", "recordOpenQuestion", "resolveOpenQuestion", "proposeStageChange", "decideStageProposal",
  "approveMeetingAfter", "discardMeetingAfter", "honourCommitment",
  // P7: commitments, notes, consent, policy, transcript
  "createCommitment", "convertCommitment", "addNote", "importTranscript", "ingestTranscript", "recordConsent",
  "activateRecordingPolicy", "transitionMeeting", "createDebrief", "promoteToClaimCandidate",
  // the deal and the company
  "transitionOpportunity", "createOpportunity", "updateOpportunity", "archiveOpportunity", "createCompany", "mergeCompanies",
  // the room's own access, and anything that leaves the building
  "revokeAllAiAccess", "restoreAiAccess", "deliver", "sendOrPreview", "executeEffect", "sendEmail",
  // close-out assigns work out of prose; the room must not
  "runCloseout",
];

/** The only table the room may write with its own SQL. */
const OWN_TABLE = "meeting_artifact";

/** The only API paths the During face may POST to. */
const PANEL_POSTS_ALLOWED = ["/capture/consent", "/capture/chunk", "/room/roll", "/room/ask"];

function readTs(file) {
  return stripTsComments(readFileSync(file, "utf8"));
}

/** The source of one function, braces balanced from the line its body opens on (Phase B's reader). */
function fnBody(src, name) {
  const m = new RegExp(`(?:export )?(?:async )?function ${name}\\b[\\s\\S]*?\\{[ \\t]*\\n`).exec(src);
  if (!m) return null;
  let depth = 0;
  for (let i = m.index + m[0].lastIndexOf("{"); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(m.index, i + 1);
    }
  }
  return null;
}

// ── 1 · the route block ───────────────────────────────────────────────────────────────────────

/** `indexSrc` is the RAW file: the block's fences are comments, and the stripper would eat them. */
export function checkRoutes(indexSrc, roomSrc) {
  const violations = [];
  const start = indexSrc.indexOf("// === Phase C: the live room ===");
  const end = indexSrc.indexOf("// === end Phase C ====");
  if (start === -1 || end === -1 || end < start) {
    return { violations: ["index.ts has no contiguous `// === Phase C: the live room ===` … `// === end Phase C ====` block — the room's routes are not where the scan (and the next phase) expects them"], examined: 0 };
  }
  const block = stripTsComments(indexSrc.slice(start, end));
  const routes = [...block.matchAll(/\.(get|post)\("([^"]+)",\s*(\w+)\)/g)].map((m) => ({ method: m[1], path: m[2], handler: m[3] }));
  for (const r of routes) {
    if (!r.path.includes("/room")) violations.push(`${r.method.toUpperCase()} ${r.path} sits in the Phase C block but is not a room route`);
    if (!new RegExp(`export async function ${r.handler}\\b`).test(roomSrc)) violations.push(`${r.handler} (${r.method.toUpperCase()} ${r.path}) is not exported by meetingRoom.ts — the scan would be reading the wrong file`);
  }
  for (const must of ["/api/meetings/:id/room", "/api/meetings/:id/room/ask", "/api/meetings/:id/room/roll"]) {
    if (!routes.some((r) => r.path === must)) violations.push(`the room route ${must} is missing from the Phase C block`);
  }
  return { violations, examined: routes.length };
}

// ── 2–5 · meetingRoom.ts ──────────────────────────────────────────────────────────────────────

export function checkRoomService(src) {
  const violations = [];
  const counts = { imports: 0, calls: 0, sql: 0, returns: 0 };

  // 2 · imports, by name
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]+"/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/).pop();
      if (!name) continue;
      counts.imports += 1;
      if (FORBIDDEN_CALLS.includes(name)) violations.push(`meetingRoom.ts imports ${name} — a record-writing function is one call away from a spoken question`);
    }
  }

  // 3 · calls, by name, anywhere in the file
  for (const name of FORBIDDEN_CALLS) {
    counts.calls += 1;
    const re = new RegExp(`(?<![A-Za-z0-9_.])${name}\\s*\\(`);
    if (re.test(src)) violations.push(`meetingRoom.ts calls ${name}( — a question in the room can reach a record without a person`);
  }

  // 4 · raw SQL writes target meeting_artifact only
  for (const m of src.matchAll(/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi)) {
    counts.sql += 1;
    if (m[2] !== OWN_TABLE) violations.push(`meetingRoom.ts runs ${m[1].toUpperCase()} ${m[2]} — the room may write its own block and nothing else`);
  }

  // 5 · every return from askRoom carries an artifact
  const ask = fnBody(src, "askRoom");
  if (!ask) violations.push("askRoom is missing from meetingRoom.ts");
  else {
    const inner = ask.slice(ask.indexOf("{"));
    for (const m of inner.matchAll(/return\s*\{([^}]*)\}/g)) {
      counts.returns += 1;
      if (!/\bartifact\b/.test(m[1])) violations.push(`askRoom returns without an artifact (\`return {${m[1].trim().slice(0, 60)}…}\`) — a question that ends in no saved block ends in nothing`);
    }
    if (!/throw new RoomError\(\s*400,\s*"invalid_input"/.test(ask)) violations.push("askRoom does not refuse an empty question — a blank ask would cost a model run and save a block about nothing");
  }

  return { violations, counts };
}

// ── 6 · the voice path writes nothing ─────────────────────────────────────────────────────────

export function checkVoicePath(liveSrc) {
  const violations = [];
  let examined = 0;
  const voice = fnBody(liveSrc, "transcribeWithSpeakers");
  if (!voice) violations.push("transcribeWithSpeakers is missing from liveTranscription.ts — the room's voice path has no transcriber");
  else {
    examined += 1;
    if (/\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(voice)) violations.push("transcribeWithSpeakers writes to the database — the voice path must only turn audio into words");
    for (const name of FORBIDDEN_CALLS) {
      if (new RegExp(`(?<![A-Za-z0-9_.])${name}\\s*\\(`).test(voice)) violations.push(`transcribeWithSpeakers calls ${name}( — the voice path must only turn audio into words`);
    }
  }
  const chunk = fnBody(liveSrc, "captureChunk");
  if (!chunk) violations.push("captureChunk is missing from liveTranscription.ts");
  else {
    examined += 1;
    if (!chunk.includes("ingestTranscript(")) violations.push("captureChunk does not go through ingestTranscript — the two consent gates would be skipped");
    if (/INSERT\s+INTO\s+meeting_note/i.test(chunk)) violations.push("captureChunk inserts notes itself instead of through the governed import");
    for (const name of FORBIDDEN_CALLS.filter((n) => n !== "ingestTranscript" && n !== "importTranscript")) {
      if (new RegExp(`(?<![A-Za-z0-9_.])${name}\\s*\\(`).test(chunk)) violations.push(`captureChunk calls ${name}( — recording must file words, not records`);
    }
  }
  return { violations, examined };
}

// ── 7 · the During face reaches only the room's own routes ────────────────────────────────────

export function checkPanel(panelSrc) {
  const violations = [];
  const posts = [...panelSrc.matchAll(/api(?:<[^>]*>)?\(\s*`([^`]+)`\s*,\s*\{\s*method:\s*"POST"/g)].map((m) => m[1]);
  for (const p of posts) {
    if (!PANEL_POSTS_ALLOWED.some((ok) => p.endsWith(ok))) violations.push(`RoomPanel.tsx POSTs to ${p} — the During face may only consent, send a chunk, roll the draft, or ask`);
  }
  for (const bad of ["/approve", "/decisions", "/open-questions", "/stage-proposals", "/transition", "/commitments", "/closeout"]) {
    if (panelSrc.includes(bad)) violations.push(`RoomPanel.tsx mentions ${bad} — a control that makes a record does not belong on the During face`);
  }
  return { violations, examined: posts.length };
}

// ── Self-test ─────────────────────────────────────────────────────────────────────────────────

async function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };

  const room = readTs(ROOM);
  const good = checkRoomService(room);
  say(good.violations.length === 0 && good.counts.returns >= 5 && good.counts.sql >= 1, `the shipped meetingRoom.ts passes (${good.counts.imports} imports, ${good.counts.calls} names checked, ${good.counts.sql} SQL writes, ${good.counts.returns} returns in askRoom): ${good.violations.join("; ")}`);

  const withDecision = room.replace("const artifact = await save(\"answer\", text.slice", "await recordDecision(env, actor, meetingId, { decision_text: text });\n  const artifact = await save(\"answer\", text.slice");
  say(checkRoomService(withDecision).violations.some((v) => /calls recordDecision\(/.test(v)), "a room that records a decision from an answer is caught");

  const withImport = room.replace('import { latestBrief } from "./meetingBrief";', 'import { latestBrief } from "./meetingBrief";\nimport { transitionOpportunity } from "./investment";');
  say(checkRoomService(withImport).violations.some((v) => /imports transitionOpportunity/.test(v)), "an import of the deal transition is caught even before it is called");

  const withSql = room.replace("await env.WP_OS_DB.prepare(\"UPDATE meeting_artifact SET asked_text", "await env.WP_OS_DB.prepare(\"UPDATE meeting SET status = 'HELD' WHERE id = ?1\").bind(meetingId).run();\n  await env.WP_OS_DB.prepare(\"UPDATE meeting_artifact SET asked_text");
  say(checkRoomService(withSql).violations.some((v) => /UPDATE meeting —/.test(v)), "a raw write to any table but the block's own is caught");

  const withInsert = room + '\nasync function sneak(env) { await env.WP_OS_DB.prepare("INSERT INTO meeting_commitment (id) VALUES (?1)").bind("x").run(); }\n';
  say(checkRoomService(withInsert).violations.some((v) => /INSERT INTO meeting_commitment/.test(v)), "an INSERT into the commitments table is caught");

  const silentReturn = room.replace("return { asked: question, via, answered_by: who, artifact, work_card_id: null };", "return { asked: question, via, answered_by: who, work_card_id: null };");
  say(checkRoomService(silentReturn).violations.some((v) => /returns without an artifact/.test(v)), "an ask that can end without a saved block is caught");

  const index = readFileSync(INDEX, "utf8");
  const routes = checkRoutes(index, room);
  say(routes.violations.length === 0 && routes.examined >= 3, `the Phase C route block holds ${routes.examined} room routes, every one handled by meetingRoom.ts`);
  say(checkRoutes(index.replace("// === Phase C: the live room ===", "// === Phase C ==="), room).examined === 0, "a missing route block is a zero, not a pass");
  say(checkRoutes(index.replace('.post("/api/meetings/:id/room/ask", handleRoomAsk)', '.post("/api/meetings/:id/room/ask", handleApproveMeetingAfter)'), room).violations.some((v) => /handleApproveMeetingAfter/.test(v)), "a room route handled outside meetingRoom.ts is caught");

  const live = readTs(LIVE);
  const voice = checkVoicePath(live);
  say(voice.violations.length === 0 && voice.examined === 2, "the shipped voice path writes nothing and captureChunk goes through the gates");
  const voiceWrites = live.replace("const w = await transcribeChunk(env.AI, audioBase64);", "const w = await transcribeChunk(env.AI, audioBase64);\n    await env.WP_OS_DB.prepare(\"INSERT INTO meeting_note (id) VALUES ('x')\").run();");
  say(checkVoicePath(voiceWrites).violations.some((v) => /transcribeWithSpeakers writes/.test(v)), "a voice path that writes a note is caught");
  const skipsGate = live.replace("const out = await ingestTranscript(", "const out = await ingestTranscriptDirect(");
  say(checkVoicePath(skipsGate).violations.some((v) => /ingestTranscript/.test(v)), "a chunk path that skips the governed import is caught");

  const panel = readTs(PANEL);
  const p = checkPanel(panel);
  say(p.violations.length === 0 && p.examined >= 4, `the During face POSTs to ${p.examined} routes, all its own`);
  say(checkPanel(panel.replace("/room/roll`", "/after-draft/${meetingId}/approve`")).violations.some((v) => /approve/.test(v)), "a During face that can approve the draft is caught");

  if (failed > 0) process.exit(1);
  console.log("SELF-TEST PASSED: a decision written from an answer, an imported deal transition, a raw write to another table, an INSERT into commitments, a silent return, a missing or mis-handled route, a writing voice path, a gate-skipping chunk and an approving panel are each caught; the shipped source passes.");
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const room = readTs(ROOM);
  const routes = checkRoutes(readFileSync(INDEX, "utf8"), room);
  const service = checkRoomService(room);
  const voice = checkVoicePath(readTs(LIVE));
  const panel = checkPanel(readTs(PANEL));

  const empty = [
    routes.examined === 0 && "found 0 room routes in index.ts",
    service.counts.imports === 0 && "read 0 imports in meetingRoom.ts",
    service.counts.calls === 0 && "checked 0 forbidden names",
    service.counts.sql === 0 && "found 0 SQL writes in meetingRoom.ts (the block's own provenance UPDATE should be there)",
    service.counts.returns === 0 && "found 0 returns in askRoom",
    voice.examined === 0 && "examined 0 functions on the voice path",
    panel.examined === 0 && "found 0 POSTs in RoomPanel.tsx",
  ].filter(Boolean);
  if (empty.length > 0) {
    console.error(`VOICE-IS-READ-ONLY SCAN FAILED — ${empty.join("; ")}.`);
    console.error("An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }

  const violations = [...routes.violations, ...service.violations, ...voice.violations, ...panel.violations];
  if (violations.length > 0) {
    console.error("VOICE-IS-READ-ONLY SCAN FAILED — something said in the room could become a record without a person:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(
    `VOICE-IS-READ-ONLY SCAN PASSED: ${routes.examined} room routes all handled by meetingRoom.ts; ${service.counts.imports} imports and ${service.counts.calls} record-writing names checked, none reachable; ` +
      `${service.counts.sql} SQL write(s), all on ${OWN_TABLE}; ${service.counts.returns} returns in askRoom each carry a saved block; the voice path writes nothing and captureChunk keeps the gates; ` +
      `the During face POSTs to ${panel.examined} routes, all its own.`,
  );
}
