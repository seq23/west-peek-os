#!/usr/bin/env node
/**
 * every-employee-takes-the-lane.mjs — `npm run validate:employee-lane`.
 *
 * ONE ASSERTION: EVERY EMPLOYEE'S FINISHED WORK LEAVES THROUGH `sendOrPreview`, SO HER
 * "SHOW ME FIRST?" TICK MEANS THE SAME THING WHOEVER DID THE WORK.
 *
 * ─── WHAT THIS CATCHES THAT THE SIBLING SCANS DO NOT ──────────────────────────────────────────
 *
 * `a-preview-guards-the-send.mjs` guards the TRANSPORT BOUNDARY: nobody outside the firm is
 * emailed without an approval naming that exact address. That is a hard guarantee and it holds.
 *
 * It says nothing at all about the CALLERS, and on 18 Sep 2026 the callers were the whole problem.
 * `sendOrPreview` was called from exactly ONE file — Walker's hire search. blogHelp, productions,
 * requestReply and Parker's packets all reached `sendPartnerEmail` directly. Every one of those
 * addresses a PARTNER, so the boundary was perfectly happy, every validator was green, and
 * `work_card.preview_first` — her tick — did nothing whatsoever on four of the five employees.
 * A feature that works on one caller is the "exists but nothing invokes it" defect, and this scan
 * is the caller-side half the boundary cannot see.
 *
 * WHAT IS CHECKED
 *
 *   1 · NO SERVICE CALLS `sendPartnerEmail` OR `sendPartnersEmail` UNLESS IT IS IN THE REGISTER
 *       BELOW, WITH A STATED REASON. The register is in this file, next to the rule, because a
 *       register in a data file with nothing reading it is this repo's other recurring defect.
 *
 *   2 · EVERY REGISTER ENTRY POINTS AT A FILE THAT STILL CALLS WHAT IT WAS EXEMPTED FOR. A stale
 *       exemption is a hole waiting for the next file with that name — so an entry that has
 *       stopped being needed FAILS, and must be deleted rather than left "just in case".
 *
 *   3 · AN ENTRY MARKED `alsoUsesLane` MUST STILL CALL `sendOrPreview(`. Parker's packet goes to
 *       both partners at once, which the single-address lane cannot express — but the ADDRESSED
 *       note that packet produces must still go through the lane, and without this the exemption
 *       for the first would silently license dropping the second.
 *
 *   4 · `sendOrPreview` ITSELF MUST ASK `previewFirstFor(` AND MUST PASS `cardAsked`. A lane that
 *       stopped consulting the card's tick would pass every other check in this repo while making
 *       the checkbox decorative again.
 *
 *   5 · EVERY CALLER PASSES `cardAsked`. A call that omits it is a caller that reads her tick as
 *       "nobody said" forever — green, silent, and exactly the bug this file exists about. The
 *       one exception is a caller with no card at all, which must say so with `cardAsked: null`.
 *
 * HARD-FAILS ON ZERO: zero service sources scanned, or zero send sites examined, exits 1. A scan
 * that examined nothing is not a passing scan.
 *
 * `--self-test` runs the defects this exists to catch through the same function and requires each
 * to be caught.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SERVICES = path.join(ROOT, "src", "worker", "services");

const LANE = path.join("src", "worker", "services", "previewApproval.ts");

/**
 * THE ADMISSION REGISTER. A service may reach `execEmail.ts` directly only from here, and only
 * with a reason a reader can weigh. Adding a line is deliberate; it is not a formality.
 */
export const DIRECT_SEND_REGISTER = {
  "src/worker/services/execEmail.ts": {
    why: "It DEFINES sendPartnerEmail and sendPartnersEmail. The door cannot go through itself.",
  },
  "src/worker/services/previewApproval.ts": {
    why:
      "It IS the lane. Its sendPartnerEmail call mails the preview — the draft plus the three " +
      "buttons — to the partner who owns it, which is the notification the lane exists to send.",
  },
  "src/worker/services/roomPacket.ts": {
    why:
      "Parker's monthly packet is ONE message addressed to BOTH partners, deliberately: two " +
      "copies would be two conversations about one decision, and the second would carry a reply " +
      "code the first had already spent. sendOrPreview takes a single address and cannot say that.",
    // …and the addressed note that the same packet produces must still take the lane.
    alsoUsesLane: true,
  },
  "src/worker/services/banterReply.ts": {
    why:
      "Addendum 11 (22 Sep 2026, her decision): a card the intake classifier catches as pure " +
      "banter gets one reply from the sender's own chief of staff, sent immediately, deliberately " +
      "bypassing the preview-first gate — requiring her to approve every joke-reply would defeat " +
      "the point, it is meant to feel like an actual back-and-forth. Scoped to this ONE file so " +
      "webPropertyChange.ts's real employee-finished-work emails (RECEIVED/PLAN/PREVIEW/QUESTION/" +
      "STUCK/DONE) still all take the lane and this scan would still catch a regression there.",
  },
};

/** Comments out, line count preserved — prose must not decide the outcome in either direction. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1);
}

const DIRECT_SEND = /\bsendPartnersEmail\s*\(|\bsendPartnerEmail\s*\(/;

/**
 * The body of a `sendOrPreview({ … })` call, brace-balanced from the opening `{` of its argument
 * object. Returns one string per call site.
 */
export function laneCallSites(code) {
  const out = [];
  const re = /sendOrPreview\s*\(\s*env\s*,\s*\{/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const open = code.indexOf("{", m.index + "sendOrPreview".length);
    if (open < 0) continue;
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          out.push(code.slice(open, i + 1));
          break;
        }
      }
    }
  }
  return out;
}

export function checkSources(sources, register = DIRECT_SEND_REGISTER) {
  const violations = [];
  let sendSitesExamined = 0;

  // ── 1 · nobody reaches the door directly unless the register says so ────────────────────────
  for (const [file, source] of Object.entries(sources)) {
    const code = stripComments(source);
    if (!DIRECT_SEND.test(code)) continue;
    sendSitesExamined += 1;
    if (!register[file]) {
      violations.push(
        `${file} calls sendPartnerEmail/sendPartnersEmail directly. An employee's finished work goes ` +
          "through sendOrPreview, which asks previewFirstFor and therefore reads her " +
          '"Show me first?" tick. A caller that bypasses it makes that tick do nothing — which is ' +
          "exactly what four of the five employees did until 18 Sep 2026. If this genuinely cannot " +
          `take the lane, add it to DIRECT_SEND_REGISTER in ${path.basename(fileURLToPath(import.meta.url))} with the reason.`,
      );
    }
  }

  // ── 2 and 3 · the register is not allowed to go stale ───────────────────────────────────────
  for (const [file, entry] of Object.entries(register)) {
    const source = sources[file];
    if (source === undefined) {
      violations.push(
        `${file} is in DIRECT_SEND_REGISTER and does not exist. A stale exemption is a hole waiting ` +
          "for the next file to be given that name — delete the line.",
      );
      continue;
    }
    const code = stripComments(source);
    if (!DIRECT_SEND.test(code)) {
      violations.push(
        `${file} is in DIRECT_SEND_REGISTER and no longer calls a direct send. Delete the entry: an ` +
          "exemption kept 'just in case' is an exemption nobody re-argues.",
      );
    }
    if (!entry.why || entry.why.trim().length < 20) {
      violations.push(`${file}'s register entry has no reason on it. An exemption a reader cannot weigh is a hole.`);
    }
    if (entry.alsoUsesLane && !/sendOrPreview\s*\(/.test(code)) {
      violations.push(
        `${file} is exempted only for the message it sends to BOTH partners, and it no longer calls ` +
          "sendOrPreview at all. The exemption for one message is not a licence to drop the lane for " +
          "the addressed one — that is how Parker went back to emitting a packet nobody can send.",
      );
    }
  }

  // ── 4 · the lane still reads the card's tick ────────────────────────────────────────────────
  const lane = sources[LANE];
  if (!lane) {
    violations.push(`${LANE} is missing — there is no lane for anybody to take.`);
  } else {
    const code = stripComments(lane);
    sendSitesExamined += 1;
    if (!/previewFirstFor\s*\(/.test(code)) {
      violations.push(
        `${LANE} does not ask previewFirstFor(). That is the one function that decides preview-first, ` +
          "and it is where her rule and her tick are read together.",
      );
    }
    if (!/cardAsked\s*:/.test(code)) {
      violations.push(
        `${LANE} never passes cardAsked to the decision. work_card.preview_first would then be a column ` +
          "nothing reads — which is what it was from migration 0183 until the day this scan was written.",
      );
    }
    if (!/previewOwnerFor\s*\(/.test(code)) {
      violations.push(
        `${LANE} does not ask previewOwnerFor(). The preview goes to whoever ticked the box; resolving ` +
          "the owner anywhere but the registry is how an approval link reaches somebody outside the firm.",
      );
    }
  }

  // ── 5 · every caller passes the tick ────────────────────────────────────────────────────────
  for (const [file, source] of Object.entries(sources)) {
    if (file === LANE) continue;
    for (const site of laneCallSites(stripComments(source))) {
      sendSitesExamined += 1;
      if (!/\bcardAsked\s*:/.test(site)) {
        violations.push(
          `${file} calls sendOrPreview without cardAsked. That caller reads her tick as "nobody said" ` +
            "forever, silently. A caller with no card at all still has to say so, with cardAsked: null.",
        );
      }
    }
  }

  return { violations, sendSitesExamined };
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  const F = {
    lane: LANE,
    exec: "src/worker/services/execEmail.ts",
    packet: "src/worker/services/roomPacket.ts",
    blog: "src/worker/services/blogHelp.ts",
  };
  const cleanRegister = {
    [F.exec]: { why: "It defines the door; the door cannot go through itself." },
    [F.lane]: { why: "It is the lane; it mails the preview to the partner who owns it." },
    [F.packet]: { why: "One message addressed to both partners at once, which one address cannot say.", alsoUsesLane: true },
  };
  const clean = {
    [F.lane]:
      "export async function sendOrPreview(env, input) { const lane = previewFirstFor({ recipient: to, cardAsked: input.cardAsked }); " +
      "const owner = previewOwnerFor({}); return sendPartnerEmail(env, { to: owner.email }); }",
    [F.exec]: "export async function sendPartnerEmail(env, input) { return transport(env, input); }",
    [F.packet]:
      "const out = await sendPartnersEmail(env, { to: BOTH });\n" +
      "const note = await sendOrPreview(env, { to, email: note, cardAsked: null, firmScope });",
    [F.blog]: "const mail = await sendOrPreview(env, { to: partner.email, email, cardAsked: true, firmScope });",
  };

  const cases = {
    "a service reaching the door directly with no register entry": {
      sources: { ...clean, [F.blog]: "const mail = await sendPartnerEmail(env, { to: partner.email, email });" },
      register: cleanRegister,
    },
    "a register entry for a file that is gone": {
      sources: clean,
      register: { ...cleanRegister, "src/worker/services/vanished.ts": { why: "a reason long enough to pass the length check" } },
    },
    "a register entry that no longer sends directly": {
      sources: { ...clean, [F.packet]: "const note = await sendOrPreview(env, { to, cardAsked: null });" },
      register: cleanRegister,
    },
    "an exemption with no reason on it": {
      sources: clean,
      register: { ...cleanRegister, [F.exec]: { why: "because" } },
    },
    "a both-partners exemption that quietly dropped the addressed note": {
      sources: { ...clean, [F.packet]: "const out = await sendPartnersEmail(env, { to: BOTH });" },
      register: cleanRegister,
    },
    "a lane that stopped asking previewFirstFor": {
      sources: { ...clean, [F.lane]: clean[F.lane].replace("previewFirstFor({ recipient: to, cardAsked: input.cardAsked })", "({ previewFirst: false })") },
      register: cleanRegister,
    },
    "a lane that stopped reading the card's tick": {
      sources: { ...clean, [F.lane]: clean[F.lane].replace("cardAsked: input.cardAsked", "") },
      register: cleanRegister,
    },
    "a lane that resolves the owner without the registry": {
      sources: { ...clean, [F.lane]: clean[F.lane].replace("previewOwnerFor({})", "{ email: 'whoever@example.com' }") },
      register: cleanRegister,
    },
    "a caller that forgets cardAsked": {
      sources: { ...clean, [F.blog]: "const mail = await sendOrPreview(env, { to: partner.email, email, firmScope });" },
      register: cleanRegister,
    },
    "the lane itself deleted": {
      sources: { [F.exec]: clean[F.exec], [F.blog]: clean[F.blog], [F.packet]: clean[F.packet] },
      register: { [F.exec]: cleanRegister[F.exec], [F.packet]: cleanRegister[F.packet] },
    },
  };

  const failures = [];
  const cleanResult = checkSources(clean, cleanRegister);
  if (cleanResult.violations.length > 0) {
    failures.push(`the clean fixture was rejected: ${cleanResult.violations.join("; ")}`);
  }
  if (cleanResult.sendSitesExamined === 0) failures.push("the clean fixture examined zero send sites");
  for (const [name, fixture] of Object.entries(cases)) {
    if (checkSources(fixture.sources, fixture.register).violations.length === 0) {
      failures.push(`NOT CAUGHT: ${name}`);
    }
  }

  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `SELF-TEST PASSED: clean fixture passes; all ${Object.keys(cases).length} violating fixtures are caught, ` +
      "including a stale exemption and a caller that silently stops reading her tick.",
  );
  process.exit(0);
}

function readTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

const sources = readTree(SERVICES);
if (Object.keys(sources).length === 0) {
  console.error(`EMPLOYEE-LANE SCAN FAILED — examined 0 services under ${path.relative(ROOT, SERVICES)}.`);
  process.exit(1);
}

const { violations, sendSitesExamined } = checkSources(sources);

if (sendSitesExamined === 0) {
  console.error("EMPLOYEE-LANE SCAN FAILED — examined 0 send sites. Either every service stopped sending mail,");
  console.error("or the lane and the door were both renamed. Both must fail loudly: a scan that passes by");
  console.error("finding nothing to check is the 'runs but inert' defect this repo keeps producing.");
  process.exit(1);
}
if (violations.length > 0) {
  console.error("EMPLOYEE-LANE SCAN FAILED — an employee can finish work without her tick meaning anything:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("\nHer rule: every work card carries 'Who is this for?' and 'Show me first?'. The tick has to");
  console.error("mean the same thing whoever did the work, and it only can if every employee leaves through");
  console.error("sendOrPreview. See src/worker/services/previewApproval.ts and migration 0190.");
  process.exit(1);
}

console.log(
  `EMPLOYEE-LANE SCAN PASSED: ${sendSitesExamined} send site(s) across ${Object.keys(sources).length} services; ` +
    `every direct send is one of the ${Object.keys(DIRECT_SEND_REGISTER).length} registered exemptions and each is ` +
    "still needed; the lane reads previewFirstFor, cardAsked and previewOwnerFor; every caller passes the tick.",
);
