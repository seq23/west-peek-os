#!/usr/bin/env node
/**
 * every-door-keeps-the-message.mjs — `npm run validate:every-door-keeps-the-message`.
 *
 * ONE ASSERTION: NO INBOUND EMAIL REACHES A WORK CARD WITHOUT HAVING BEEN KEPT FIRST, AND NO CARD
 * IS EVER WRITTEN THE RAW MIME INSTEAD OF THE WORDS.
 *
 * WHAT THIS EXISTS BECAUSE OF. On 21 Sep 2026 Scooter replied to a hire-search email. The door read
 * the reply as a new request, wrote the first 4,000 characters of RAW MIME — `Received:`,
 * `ARC-Seal:`, `DKIM-Signature:` — into the card's description, and stored no `.eml`. His words
 * were never written anywhere and are unrecoverable.
 *
 * Neither half of that was an oversight in one place. Keeping the message was a PER-DOOR
 * responsibility: exactly one of five doors did it (`openAssignmentCard`, since PR #150) plus the
 * oversize branch, and the other seven call sites kept nothing. `raw.slice(0, 4000)` was written
 * out separately in `openRoutingCard` and `openPortfolioUpdateCard`, and fixed in a third door a
 * day before the failure. Both are the shape this repo names: two components each keeping their own
 * list, with nothing linking them. A comment saying "keep the message" is not a guard. This is.
 *
 * WHAT IS CHECKED
 *   1 · EVERY call site of every door — `openRoutingCard`, `openAssignmentCard`,
 *       `openPortfolioUpdateCard`, `intakeDealFromEmail`, `steerFromReply` — is reached with a
 *       stored key in hand (`emlKey` named in the call or set on the argument just above it).
 *   2 · NO door writes `raw.slice(` into anything, and each one that carries a message on a card
 *       reads it through `readableMessage` — decoded, quote-stripped, capped for readability.
 *   3 · NO `catch` in the inbound path swallows an R2 `put`: a try block containing a put must have
 *       a catch that calls `appendEvent`, so a failed store is on the spine rather than silent.
 *   4 · The store is HOISTED: `handleInboundEmailOnce` calls `keepTheMessage` before it calls any
 *       door, `keepTheMessage` writes the `inbound_message` row in the same place it writes the
 *       object, and it is the ONLY place in `src/` that mints an `inbound-email/` key. A second
 *       minting site is a second door keeping its own list again.
 *   5 · The spoof refusal survives: a message whose From claims an assigning partner and which
 *       failed the verdict is not archived under that partner's name.
 *   6 · The request-message routes gate on `getVisibleWorkCard` — the one function that checks BOTH
 *       firm scope and privacy label — and never on a bare `SELECT id FROM work_card`, which is the
 *       missing guard the notes routes still carry and the shape not to copy.
 *
 * HARD-FAILS ON ZERO. Zero sources, zero door call sites, or zero R2 puts in the inbound path exits
 * 1: a scan that found nothing to guard has not proven anything is guarded.
 *
 * `--self-test` runs the real pre-fix shapes through the same functions — a door called with no
 * key, `raw.slice(0, 4000)` back in a description, the swallowed `catch {}`, the store pushed back
 * inside a door, the spoof refusal deleted, and the notes routes' bare SELECT copied into the new
 * route — and requires each to be caught.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");

const INBOUND = path.join("src", "worker", "effects", "inboundEmail.ts");
const DEAL_INTAKE = path.join("src", "worker", "services", "dealIntake.ts");
const PORTFOLIO = path.join("src", "worker", "services", "portfolioReporting.ts");
const THREAD = path.join("src", "worker", "services", "emailThread.ts");
const ROUTE = path.join("src", "worker", "services", "requestMessage.ts");

/** The files a message passes through between the mailbox and a work card. */
const INBOUND_PATH = [INBOUND, DEAL_INTAKE, PORTFOLIO, THREAD, ROUTE];

/** Every door an inbound message can reach a card through. */
const DOORS = ["openRoutingCard", "openAssignmentCard", "openPortfolioUpdateCard", "intakeDealFromEmail", "steerFromReply"];

/** The doors that put a message on a card and must therefore read it, never slice it. */
const DOORS_THAT_CARRY_WORDS = [
  [DEAL_INTAKE, "openRoutingCard"],
  [DEAL_INTAKE, "openAssignmentCard"],
  [DEAL_INTAKE, "intakeDealFromEmail"],
  [PORTFOLIO, "openPortfolioUpdateCard"],
];

/** Comments out, line count kept, so prose can neither pass nor fail the scan. */
export function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
  return out;
}

/** The text of a call starting at `at`, to its matching close paren. */
function callText(code, at) {
  const open = code.indexOf("(", at);
  if (open === -1) return code.slice(at, at + 400);
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(at, i + 1);
    }
  }
  return code.slice(at);
}

/** A function body: from its declaration to the next top-level `export`/`function`. */
function bodyOf(code, name) {
  const at = code.search(new RegExp(`(?:export )?(?:async )?function ${name}\\b`));
  if (at === -1) return null;
  const next = code.indexOf("\nexport ", at + 1);
  return code.slice(at, next === -1 ? code.length : next);
}

/** Every `try { … } catch (…) { … }` pair in a file, as text. */
function tryCatches(code) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = code.indexOf("try {", from);
    if (at === -1) return out;
    let depth = 0;
    let end = -1;
    for (let i = code.indexOf("{", at); i < code.length; i++) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end === -1) return out;
    const rest = code.slice(end + 1);
    const catchAt = rest.search(/^\s*catch\b/);
    let catchBody = "";
    if (catchAt !== -1) {
      const braceAt = rest.indexOf("{", catchAt);
      if (braceAt !== -1) {
        let d = 0;
        for (let i = braceAt; i < rest.length; i++) {
          if (rest[i] === "{") d += 1;
          else if (rest[i] === "}") {
            d -= 1;
            if (d === 0) {
              catchBody = rest.slice(braceAt, i + 1);
              break;
            }
          }
        }
      }
    }
    out.push({ tryBody: code.slice(at, end + 1), catchBody, index: at });
    from = end + 1;
  }
}

export function checkSources(sources) {
  const violations = [];
  let doorSites = 0;
  let putBlocks = 0;

  // ── 1 · every door is reached with a key in hand ────────────────────────────────────────────
  for (const [file, raw] of Object.entries(sources)) {
    const code = stripComments(raw);
    const lines = code.split("\n");
    for (const door of DOORS) {
      const re = new RegExp(`\\b${door}\\s*\\(`, "g");
      let m;
      while ((m = re.exec(code)) !== null) {
        const before = code.slice(0, m.index);
        // The definition is not a call site.
        if (/(?:export )?(?:async )?function\s+$/.test(before)) continue;
        const line = before.split("\n").length;
        doorSites += 1;
        const call = callText(code, m.index);
        /*
         * TWO SHAPES, AND THE LOOSE VERSION OF THIS CHECK CAUGHT NEITHER OF THEM.
         *
         * A door called with an object literal must name `emlKey` INSIDE the call — scanning a
         * window of preceding lines passed happily because some OTHER door call in the same
         * function mentioned it, which is exactly the false green this scan exists to refuse.
         * A door handed a prepared variable (`intakeDealFromEmail(env, deal)`) is checked on that
         * variable by name: `deal.emlKey` has to be set within the thirty lines above it.
         */
        const takesLiteral = /\{/.test(call.slice(call.indexOf("(")));
        const handed = /,\s*([A-Za-z_$][\w$]*)\s*\)\s*$/.exec(call)?.[1] ?? null;
        const ok = takesLiteral
          ? /\bemlKey\b/.test(call)
          : Boolean(handed) &&
            new RegExp(`\\b${handed}\\.emlKey\\b`).test(lines.slice(Math.max(0, line - 31), line).join("\n"));
        if (!ok) {
          violations.push(
            `${file}:${line}: ${door} is reached with no stored key in hand. Every message is kept ONCE at the ` +
              `door (keepTheMessage) and the key is handed down; a call with no emlKey is a card whose original ` +
              `email nobody can ever find again.`,
          );
        }
      }
    }
  }

  // ── 2 · the words, never the MIME ───────────────────────────────────────────────────────────
  for (const [file, door] of DOORS_THAT_CARRY_WORDS) {
    const raw = sources[file];
    if (!raw) {
      violations.push(`${file} is missing — the door ${door} cannot be checked.`);
      continue;
    }
    const body = bodyOf(stripComments(raw), door);
    if (!body) {
      violations.push(`${file}: ${door} is gone, so nothing carries a message onto a card here.`);
      continue;
    }
    if (/\braw\b[^\n]*\.slice\s*\(/.test(body)) {
      violations.push(
        `${file}: ${door} slices \`raw\` into what it writes. \`raw\` is the whole RFC 5322 message, so the ` +
          `first four thousand characters are Received: and DKIM headers and the sender's words are cut off ` +
          `before they begin — exactly what reached Porter on 21 Sep 2026. Use readableMessage().`,
      );
    }
    if (!/readableMessage\s*\(/.test(body)) {
      violations.push(
        `${file}: ${door} no longer reads the message through readableMessage(), so nothing decodes it or ` +
          `strips the quoted half. One reader, or three doors drift apart again.`,
      );
    }
  }

  // ── 3 · a failed store is never silent ──────────────────────────────────────────────────────
  for (const file of INBOUND_PATH) {
    const raw = sources[file];
    if (!raw) continue;
    for (const block of tryCatches(stripComments(raw))) {
      if (!/WP_OS_DOCUMENTS\s*\.\s*put\s*\(/.test(block.tryBody)) continue;
      putBlocks += 1;
      if (!/appendEvent\s*\(/.test(block.catchBody)) {
        const line = stripComments(raw).slice(0, block.index).split("\n").length;
        violations.push(
          `${file}:${line}: an R2 put is wrapped in a catch that does not append an event. The store was broken ` +
            `from the day it shipped and said nothing, because \`catch { emlKey = null }\` is indistinguishable ` +
            `from a store that never ran.`,
        );
      }
    }
  }

  // ── 4 · the store is hoisted, and there is one of it ────────────────────────────────────────
  const inboundRaw = sources[INBOUND];
  if (!inboundRaw) {
    violations.push(`${INBOUND} is missing — nothing keeps an inbound message at all.`);
  } else {
    const code = stripComments(inboundRaw);
    const once = bodyOf(code, "handleInboundEmailOnce");
    if (!once) {
      violations.push(`${INBOUND}: handleInboundEmailOnce is gone, so there is no once-per-message entry to keep it at.`);
    } else {
      const keepAt = once.indexOf("keepTheMessage(");
      if (keepAt === -1) {
        violations.push(
          `${INBOUND}: handleInboundEmailOnce never calls keepTheMessage. The store belongs at the entry, before ` +
            `anything branches — a per-door store kept one message in eight.`,
        );
      } else {
        const firstDoor = DOORS.map((d) => once.search(new RegExp(`\\b${d}\\s*\\(`)))
          .filter((i) => i !== -1)
          .sort((a, b) => a - b)[0];
        if (firstDoor !== undefined && firstDoor < keepAt) {
          violations.push(
            `${INBOUND}: a door is reached before keepTheMessage runs. "Before any branch" is the whole point: ` +
              `a store that happens inside one arm keeps only the messages that take that arm.`,
          );
        }
      }
    }

    const keeper = bodyOf(code, "keepTheMessage");
    if (!keeper) {
      violations.push(`${INBOUND}: keepTheMessage is gone.`);
    } else {
      if (!/INSERT OR IGNORE INTO inbound_message/.test(keeper)) {
        violations.push(
          `${INBOUND}: keepTheMessage no longer writes the inbound_message row. The object and its index row are ` +
            `written in the same place or they disagree, and recovery goes back to grepping card descriptions.`,
        );
      }
      // 5 · the spoof refusal.
      if (!/ASSIGNING_PARTNERS/.test(keeper) || !/verdict\.passed/.test(keeper)) {
        violations.push(
          `${INBOUND}: keepTheMessage no longer refuses a forged partner message. os@joinwestpeek.com is publicly ` +
            `addressable; archiving a failed-authentication message under a partner's name gives an attacker ` +
            `durable storage in the firm's own bucket.`,
        );
      }
    }

    // One minting site, across the whole tree.
    let minting = 0;
    for (const [, src] of Object.entries(sources)) {
      minting += (stripComments(src).match(/`inbound-email\/\$\{/g) ?? []).length;
    }
    if (minting !== 1) {
      violations.push(
        `${minting} place(s) mint an \`inbound-email/\` key; there must be exactly one (keepTheMessage). A second ` +
          `minting site is a second door keeping its own copy, which is the defect this whole overhaul removed.`,
      );
    }
  }

  // ── 6 · the routes gate on the card's real visibility ───────────────────────────────────────
  const routeRaw = sources[ROUTE];
  if (!routeRaw) {
    violations.push(`${ROUTE} is missing — nothing serves the message a card came from.`);
  } else {
    const code = stripComments(routeRaw);
    if (!/getVisibleWorkCard\s*\(/.test(code)) {
      violations.push(
        `${ROUTE}: the request-message routes do not go through getVisibleWorkCard, which is the one function that ` +
          `checks BOTH firm scope and privacy label.`,
      );
    }
    if (/SELECT\s+id\s+FROM\s+work_card/i.test(code)) {
      violations.push(
        `${ROUTE}: a bare \`SELECT id FROM work_card\` decides visibility here. That is the notes routes' known ` +
          `missing guard — it checks neither scope nor label — and copying it would serve a RESTRICTED card's ` +
          `email to anyone who can guess an id.`,
      );
    }
    if (!/authorize\s*\(/.test(code) || !/inbound_message\.read_raw/.test(code)) {
      violations.push(
        `${ROUTE}: the raw route is not gated through authorize() on inbound_message.read_raw. Headers, routing and ` +
          `signatures are a Managing Partner's to read.`,
      );
    }
  }

  return { violations, doorSites, putBlocks };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

const CLEAN_INBOUND = [
  "async function keepTheMessage(env, input) {",
  "  const claimsToBePartner = ASSIGNING_PARTNERS.includes(addressIn(h) ?? '');",
  "  if (claimsToBePartner && !authority.verdict.passed) { return { key: null }; }",
  "  const key = `inbound-email/${day}/${crypto.randomUUID()}.eml`;",
  "  try {",
  "    await env.WP_OS_DOCUMENTS.put(key, buffered, {});",
  "  } catch (err) {",
  "    await appendEvent(env, { eventType: 'inbound_email.store_failed' });",
  "    return { key: null };",
  "  }",
  "  await env.WP_OS_DB.prepare(`INSERT OR IGNORE INTO inbound_message (id) VALUES (?1)`).run();",
  "  return { key };",
  "}",
  "",
  "async function handleInboundEmailOnce(message, env, options) {",
  "  const kept = await keepTheMessage(env, { message });",
  "  const cardId = await openAssignmentCard(env, { raw, emlKey: kept.key });",
  "  const routed = await openRoutingCard(env, { raw, emlKey: kept.key });",
  "  const updated = await openPortfolioUpdateCard(env, { raw, emlKey: kept.key });",
  "  const steer = await steerFromReply(env, { raw, emlKey: kept.key });",
  "  deal.emlKey = kept.key;",
  "  const entry = await intakeDealFromEmail(env, deal);",
  "}",
].join("\n");

const CLEAN_DEAL_INTAKE = [
  "export function readableMessage(raw, cap = 4000) { return splitQuoted(textBodyOf(raw)).written.slice(0, cap); }",
  "",
  "export async function openRoutingCard(env, input) {",
  "  const card = await createWorkCardInternal(env, id, { description: readableMessage(input.raw) });",
  "  return card.id;",
  "}",
  "",
  "export async function openAssignmentCard(env, input) {",
  "  const written = readableMessage(input.raw, 100000);",
  "  const emlKey = input.emlKey;",
  "  return card.id;",
  "}",
  "",
  "export async function intakeDealFromEmail(env, deal) {",
  "  return openIntoFunnel(env, { raw: readableMessage(deal.raw), emlKey: deal.emlKey });",
  "}",
].join("\n");

const CLEAN_PORTFOLIO = [
  "export async function openPortfolioUpdateCard(env, input) {",
  "  const card = await createWorkCardInternal(env, id, { description: readableMessage(input.raw), emlKey: input.emlKey });",
  "  return card.id;",
  "}",
].join("\n");

const CLEAN_THREAD = ["export async function steerFromReply(env, message) { return { steered: true }; }"].join("\n");

const CLEAN_ROUTE = [
  "export async function handleGetRequestMessage(ctx) {",
  "  const card = await getVisibleWorkCard(ctx.env, ctx.identity, ctx.params.id);",
  "  return json({});",
  "}",
  "export async function handleGetRequestMessageRaw(ctx) {",
  "  const card = await getVisibleWorkCard(ctx.env, ctx.identity, ctx.params.id);",
  "  const decision = await authorize(ctx.env, actor, 'inbound_message.read_raw', {});",
  "  return new Response('');",
  "}",
].join("\n");

function cleanTree() {
  return {
    [INBOUND]: CLEAN_INBOUND,
    [DEAL_INTAKE]: CLEAN_DEAL_INTAKE,
    [PORTFOLIO]: CLEAN_PORTFOLIO,
    [THREAD]: CLEAN_THREAD,
    [ROUTE]: CLEAN_ROUTE,
  };
}

function selfTest() {
  const failures = [];

  const clean = checkSources(cleanTree());
  if (clean.violations.length !== 0) failures.push(`clean fixture was flagged: ${clean.violations[0]}`);
  if (clean.doorSites === 0) failures.push("clean fixture found no door call site to guard");
  if (clean.putBlocks === 0) failures.push("clean fixture found no R2 put to guard");

  const cases = {
    "a door called with no stored key": (t) => {
      t[INBOUND] = t[INBOUND].replace("await openRoutingCard(env, { raw, emlKey: kept.key })", "await openRoutingCard(env, { raw })");
    },
    "the deal door reached without the key set above it": (t) => {
      t[INBOUND] = t[INBOUND].replace("  deal.emlKey = kept.key;\n", "");
    },
    "raw.slice back in a routing card's description": (t) => {
      t[DEAL_INTAKE] = t[DEAL_INTAKE].replace(
        "{ description: readableMessage(input.raw) }",
        "{ description: input.raw.slice(0, 4000) }",
      );
    },
    "raw.slice back in a portfolio update card": (t) => {
      t[PORTFOLIO] = t[PORTFOLIO].replace("readableMessage(input.raw)", "input.raw.slice(0, 4000)");
    },
    "the swallowed catch around the R2 put": (t) => {
      t[INBOUND] = t[INBOUND].replace(
        "    await appendEvent(env, { eventType: 'inbound_email.store_failed' });\n",
        "",
      );
    },
    "the store pushed back inside a door": (t) => {
      t[INBOUND] = t[INBOUND].replace("  const kept = await keepTheMessage(env, { message });\n", "  const kept = { key: null };\n");
    },
    "a door reached before the message is kept": (t) => {
      t[INBOUND] = t[INBOUND].replace(
        "  const kept = await keepTheMessage(env, { message });\n  const cardId = await openAssignmentCard(env, { raw, emlKey: kept.key });",
        "  const cardId = await openAssignmentCard(env, { raw, emlKey: null });\n  const kept = await keepTheMessage(env, { message });",
      );
    },
    "the index row no longer written beside the object": (t) => {
      t[INBOUND] = t[INBOUND].replace("INSERT OR IGNORE INTO inbound_message (id) VALUES (?1)", "SELECT 1");
    },
    "the spoof refusal deleted": (t) => {
      t[INBOUND] = t[INBOUND].replace("  if (claimsToBePartner && !authority.verdict.passed) { return { key: null }; }\n", "");
    },
    "a second place minting its own inbound-email key": (t) => {
      t[DEAL_INTAKE] += "\nconst mine = `inbound-email/${day}/${crypto.randomUUID()}.eml`;\n";
    },
    "the notes routes' bare SELECT copied into the new route": (t) => {
      t[ROUTE] = t[ROUTE].replace(
        "  const card = await getVisibleWorkCard(ctx.env, ctx.identity, ctx.params.id);\n  return json({});",
        "  const card = await ctx.env.WP_OS_DB.prepare('SELECT id FROM work_card WHERE id = ?1').first();\n  return json({});",
      );
    },
    "the raw route no longer authorized": (t) => {
      t[ROUTE] = t[ROUTE].replace("  const decision = await authorize(ctx.env, actor, 'inbound_message.read_raw', {});\n", "");
    },
  };

  for (const [name, mutate] of Object.entries(cases)) {
    const tree = cleanTree();
    mutate(tree);
    if (checkSources(tree).violations.length === 0) failures.push(`violating fixture NOT caught: ${name}`);
  }

  return { failures, cases: Object.keys(cases).length };
}

// ── real tree ─────────────────────────────────────────────────────────────────────────────────

function readTree(dir, exts) {
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (exts.some((e) => entry.name.endsWith(e))) out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

if (process.argv.includes("--self-test")) {
  const { failures, cases } = selfTest();
  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(`SELF-TEST PASSED: the clean fixture passes; all ${cases} bypasses are caught, including a door called with no stored key and raw.slice back in a card's description.`);
  process.exit(0);
}

const sources = readTree(SRC, [".ts", ".tsx"]);
if (Object.keys(sources).length === 0) {
  console.error(`KEPT-MESSAGE SCAN FAILED — examined 0 sources under ${path.relative(ROOT, SRC)}.`);
  process.exit(1);
}

const { violations, doorSites, putBlocks } = checkSources(sources);

if (doorSites === 0) {
  console.error("KEPT-MESSAGE SCAN FAILED — found 0 places where an inbound email can reach a work card.");
  console.error("Either the intake is not wired up — this repo's 'exists but nothing invokes it' defect — or it");
  console.error("is reached by a path this scan cannot see. Neither is a passing result.");
  process.exit(1);
}
if (putBlocks === 0) {
  console.error("KEPT-MESSAGE SCAN FAILED — found 0 R2 puts in the inbound path, so nothing keeps a message at all.");
  process.exit(1);
}

if (violations.length > 0) {
  console.error("KEPT-MESSAGE SCAN FAILED — an inbound email could be lost, or a card could carry MIME instead of words:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("\nEvery message that passes the dedupe is kept ONCE at the door, indexed in `inbound_message`, and");
  console.error("the key is handed to every door. A card carries the sender's decoded words and the key the whole");
  console.error("message lives under. A failed store is an event, never a silence.");
  process.exit(1);
}

console.log(
  `KEPT-MESSAGE SCAN PASSED: ${doorSites} door call site(s) across ${Object.keys(sources).length} sources, each ` +
    `reached with a stored key; no door slices raw MIME into a card; ${putBlocks} R2 put(s) in the inbound path, ` +
    `each with a catch that appends an event; the store is hoisted to handleInboundEmailOnce, writes its index ` +
    `row beside the object, refuses a forged partner message, and is the only place an inbound-email key is minted; ` +
    `the request-message routes gate on getVisibleWorkCard and authorize inbound_message.read_raw.`,
);
