#!/usr/bin/env node
/**
 * a-preview-guards-the-send.mjs — `npm run validate:preview-lane`.
 *
 * ONE ASSERTION: NOBODY OUTSIDE THE FIRM CAN BE EMAILED WITHOUT AN APPROVED PREVIEW, AND THEY
 * CANNOT BECAUSE OF WHERE THE RULE LIVES — AT THE SEND BOUNDARY — RATHER THAN BECAUSE EVERY
 * FEATURE REMEMBERED IT.
 *
 * Operator, 17 Sep 2026: "anything to anyone other than sequoia@ and scooter@ should be default
 * preview. everything else does not need to be default preview unless i specifically ask for it."
 *
 * The sibling validator `preview-sends-nowhere.mjs` proves the OTHER direction: that a preview run
 * reaches nobody. This one proves that a LIVE run reaches nobody outside the firm unless she said
 * yes to that exact message going to that exact person. Two halves of one boundary, deliberately
 * two scans: the first would still pass if the lane were deleted.
 *
 * WHAT IS CHECKED
 *
 *   1 · THE BOUNDARY ASSERTS THE LANE. `applyPreviewBoundary` — the function both transports call
 *       before they touch a network or a binding, which `preview-sends-nowhere.mjs` already proves
 *       they call FIRST — must call `assertPreviewLane(`. Enforcing the lane anywhere else would
 *       be a convention, and this repo's recurring defect is "a guard that cannot reach what it
 *       governs".
 *
 *   2 · THE ASSERTION REFUSES, AND ASKS THE REGISTRY. `assertPreviewLane` must decide partnership
 *       with `isPartnerEmail(` and must THROW. A version that logged, filtered or returned false
 *       would leave the message on the wire.
 *
 *   3 · THE APPROVAL IS PER RECIPIENT, NOT A FLAG. The assertion must compare the approved address
 *       against the message's own recipients. A boolean "she approved something" would let one yes
 *       carry a different message to a different person.
 *
 *   4 · THE PARTNER ADDRESSES ARE ASKED FOR, NEVER TYPED. Neither the lane module nor the boundary
 *       may contain a literal `sequoia@` or `scooter@`. That is the defect `registry/partners.ts`
 *       exists to end, and a fifth copy of the fact inside the one guard that depends on it would
 *       be the worst place to keep it.
 *
 *   5 · THE TOKEN IS BUILT LIKE A CREDENTIAL. `shared/work/previewLane.ts` must mint from
 *       `getRandomValues`, must be at least 20 symbols, and must expose a hash — because the row
 *       stores `token_sha256` and a plaintext column would make a database read an authorisation.
 *       And migration 0183 must carry `token_sha256`, `expires_at` and `used_at`: single use and
 *       expiry are columns, not intentions.
 *
 *   6 · THE TOKEN ROUTES DO NOT SHADOW EACH OTHER, AND THE GET DOES NOT DECIDE. The unauthenticated
 *       GET must be a different path shape from the authenticated decide route (this router matches
 *       in registration order on segment count, so an identical shape would silently 401 her phone
 *       forever), and the GET handler must not call `decidePreview` — a link scanner that prefetches
 *       a URL must not be able to send mail.
 *
 * HARD-FAILS ON ZERO: zero sources scanned, or zero send paths examined, exits 1. A scan that
 * examined nothing is not a passing scan.
 *
 * `--self-test` runs the defects this exists to catch through the same function and requires each
 * to be caught.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");

const BOUNDARY = path.join("src", "worker", "effects", "emailTransport.ts");
const LANE = path.join("src", "shared", "work", "previewLane.ts");
const SERVICE = path.join("src", "worker", "services", "previewApproval.ts");
const ROUTES = path.join("src", "worker", "index.ts");
const MIGRATION = path.join("migrations", "0183_a_preview_she_can_approve_and_send.sql");

/** Comments out, line count preserved — prose must not decide the outcome in either direction. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1);
}

/** The body of a named function, braces balanced. Null when it is not there at all. */
export function functionBody(source, name) {
  const at = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at < 0) return null;
  const open = source.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/** A typed partner address anywhere but the registry itself. */
const TYPED_PARTNER = /\b(sequoia|scooter)\s*@\s*westpeek\.ventures/i;

export function checkSources(sources, migration) {
  const violations = [];
  let sendPathsExamined = 0;

  // ── 1 · the boundary asserts the lane ──────────────────────────────────────────────────────
  const boundary = sources[BOUNDARY];
  if (!boundary) {
    violations.push(`${BOUNDARY} is missing — there is no send boundary to hang the lane on.`);
  } else {
    const code = stripComments(boundary);
    const applyBody = functionBody(code, "applyPreviewBoundary");
    if (!applyBody) {
      violations.push(`${BOUNDARY}: applyPreviewBoundary is gone. Both transports call it; the lane rides on it.`);
    } else {
      sendPathsExamined += 1;
      if (!/assertPreviewLane\s*\(/.test(applyBody)) {
        violations.push(
          `${BOUNDARY}: applyPreviewBoundary does not call assertPreviewLane(). That is the one function ` +
            "every transport calls before it touches a network or a binding, so a lane enforced anywhere " +
            "else is a convention the next transport forgets.",
        );
      }
    }

    // ── 2 and 3 · it refuses, it asks the registry, and it compares the address ──────────────
    const assertBody = functionBody(code, "assertPreviewLane");
    if (!assertBody) {
      violations.push(`${BOUNDARY}: assertPreviewLane is not defined. Her default rule is enforced nowhere.`);
    } else {
      sendPathsExamined += 1;
      if (!/isPartnerEmail\s*\(/.test(assertBody)) {
        violations.push(
          `${BOUNDARY}: assertPreviewLane does not ask isPartnerEmail(). "Is this one of the two partners?" ` +
            "has exactly one answer, in shared/registry/partners.ts, and this guard must use it rather " +
            "than a domain test — info@westpeek.ventures is on that domain and is not a partner.",
        );
      }
      /*
       * THE NO-APPROVAL BRANCH SPECIFICALLY. Not "does the function throw anywhere" — the version
       * this catches had a perfectly good throw further down for a mismatched recipient and a
       * `console.warn` on the branch that actually matters, which is the one a message with no
       * approval at all takes.
       */
      if (!/!\s*approved[^{]*\{[^}]*throw\s+new\s+SendBlocked/.test(assertBody)) {
        violations.push(
          `${BOUNDARY}: assertPreviewLane does not throw SendBlocked when there is no approval at all. ` +
            "A guard that logs, filters or returns false on that branch leaves the message on the wire.",
        );
      }
      if ((assertBody.match(/throw\s+new\s+SendBlocked/g) ?? []).length < 2) {
        violations.push(
          `${BOUNDARY}: assertPreviewLane has fewer than two refusals. There are two ways to fail it — ` +
            "no approval, and an approval for somebody else — and both must throw.",
        );
      }
      if (!/approved\s*\.\s*recipient/.test(assertBody)) {
        violations.push(
          `${BOUNDARY}: assertPreviewLane never compares the approved recipient against the message's own. ` +
            "A boolean 'she approved something' lets one yes carry a different message to a different person.",
        );
      }
    }

    // ── 4 · no typed partner address in the guard ───────────────────────────────────────────
    if (TYPED_PARTNER.test(code)) {
      violations.push(
        `${BOUNDARY} types a partner address. Ask the registry — four unlinked copies of that fact is ` +
          "the defect shared/registry/partners.ts was written to end.",
      );
    }
  }

  // ── 5 · the token is built like a credential ────────────────────────────────────────────────
  const lane = sources[LANE];
  if (!lane) {
    violations.push(`${LANE} is missing — there is no lane at all.`);
  } else {
    const code = stripComments(lane);
    sendPathsExamined += 1;
    if (!/getRandomValues\s*\(/.test(code)) {
      violations.push(
        `${LANE} does not mint from crypto.getRandomValues(). This is the only secret in the scheme and ` +
          "a predictable one is not a secret.",
      );
    }
    const len = /APPROVAL_TOKEN_LENGTH\s*(?::\s*number\s*)?=\s*(\d+)/.exec(code);
    if (!len || Number(len[1]) < 20) {
      violations.push(
        `${LANE}: APPROVAL_TOKEN_LENGTH is ${len ? len[1] : "absent"}. A link that SENDS MAIL on her behalf ` +
          "is an authorising credential, not a routing tag like the 4-character packet token. At least 20.",
      );
    }
    if (!/SHA-256/.test(code) || !/hashApprovalToken/.test(code)) {
      violations.push(
        `${LANE} does not hash the token. The row must keep sha256(token) only: a database read, a backup ` +
          "or a log line must not yield a working authorisation.",
      );
    }
    if (TYPED_PARTNER.test(code)) {
      violations.push(`${LANE} types a partner address instead of asking the registry.`);
    }
    if (!/previewFirstFor/.test(code)) {
      violations.push(`${LANE} has no previewFirstFor — preview-first is decided nowhere.`);
    }
  }

  if (migration === null || migration === undefined) {
    violations.push(`${MIGRATION} is missing — the approval has no table.`);
  } else {
    for (const column of ["token_sha256", "expires_at", "used_at"]) {
      if (!new RegExp(`\\b${column}\\b`).test(migration)) {
        violations.push(
          `${MIGRATION} has no ${column} column. Single use and expiry are columns, not intentions: ` +
            "without them a leaked link works forever and works twice.",
        );
      }
    }
    if (/\btoken\s+TEXT\b/.test(migration)) {
      violations.push(
        `${MIGRATION} stores the token in the clear. Hash only — see the threat model in ${LANE}.`,
      );
    }
  }

  // ── 6 · the doors ───────────────────────────────────────────────────────────────────────────
  const routes = sources[ROUTES];
  if (!routes) {
    violations.push(`${ROUTES} is missing — the routes cannot be checked.`);
  } else {
    const code = stripComments(routes);
    const paths = [...code.matchAll(/\.(get|post)\(\s*"(\/api\/[^"]*)"[\s\S]{0,200}?\)/g)].map((m) => ({
      method: m[1].toUpperCase(),
      path: m[2],
      unauth: /auth:\s*false/.test(m[0]),
    }));
    const open = paths.filter((p) => p.unauth && /approve/.test(p.path));
    if (open.length < 2) {
      violations.push(
        `${ROUTES}: the token doors are not registered unauthenticated. She answers these from a phone, ` +
          "from the email, where there is no session — the token IS the credential.",
      );
    }
    /*
     * SHAPE COLLISION. This router matches on segment COUNT and registration ORDER, so
     * /api/x/:id/decide and /api/x/:token/decide are the same route and the second is unreachable.
     */
    const shape = (p) => p.path.split("/").map((s) => (s.startsWith(":") ? ":" : s)).join("/");
    for (const a of paths.filter((p) => p.unauth)) {
      for (const b of paths.filter((p) => !p.unauth)) {
        if (a.method === b.method && shape(a) === shape(b)) {
          violations.push(
            `${ROUTES}: ${a.method} ${a.path} and ${b.method} ${b.path} are the same shape to this router. ` +
              "The first registered wins, so one of them answers nothing, forever, silently.",
          );
        }
      }
    }
  }

  const service = sources[SERVICE];
  if (!service) {
    violations.push(`${SERVICE} is missing — there is no decision path.`);
  } else {
    const code = stripComments(service);
    sendPathsExamined += 1;
    const openBody = functionBody(code, "handleOpenPreviewApproval");
    if (!openBody) {
      violations.push(`${SERVICE}: handleOpenPreviewApproval is gone — the email buttons open nothing.`);
    } else if (/decidePreview\s*\(/.test(openBody)) {
      violations.push(
        `${SERVICE}: the unauthenticated GET calls decidePreview(). A GET that sends mail is sent by the ` +
          "first link scanner, mail client or corporate proxy that prefetches the URL — standard behaviour " +
          "in several of them. It must render buttons that POST back.",
      );
    }
    /*
     * ONE DECISION PATH. The phone door and the Home door must both call decidePreview rather than
     * each deciding for itself, exactly as packetReplyDecision.ts calls decidePacket.
     */
    for (const handler of ["handleDecidePreviewApproval", "handleDecidePreviewApprovalByToken"]) {
      const body = functionBody(code, handler);
      if (!body) {
        violations.push(`${SERVICE}: ${handler} is gone — one of the two doors does not exist.`);
      } else if (!/decidePreview\s*\(/.test(body)) {
        violations.push(
          `${SERVICE}: ${handler} does not call decidePreview(). Two doors are two ways IN, never two ` +
            "implementations — that is how the phone and the page drift into different rules.",
        );
      }
    }
    const sendBody = functionBody(code, "sendApproved");
    if (!sendBody) {
      violations.push(`${SERVICE}: sendApproved is gone — nothing puts the approved bytes on the wire.`);
    } else {
      if (/renderExecEmail\s*\(/.test(sendBody)) {
        violations.push(
          `${SERVICE}: sendApproved re-renders the message. She approved specific bytes; re-composing them ` +
            "is a second chance to differ from the thing she said yes to. Send what was stored.",
        );
      }
      if (!/row\s*\.\s*body_text/.test(sendBody) || !/row\s*\.\s*subject/.test(sendBody)) {
        violations.push(
          `${SERVICE}: sendApproved does not send the stored subject and body. The point of the feature is ` +
            "the employee's voice, unchanged — not a forward.",
        );
      }
    }
  }

  return { violations, sendPathsExamined };
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  const cleanMigration =
    "CREATE TABLE preview_approval (id TEXT PRIMARY KEY, token_sha256 TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT);";
  const clean = {
    [BOUNDARY]:
      "export function applyPreviewBoundary(env, p) { const out = p; assertPreviewLane(env, out); return out; }\n" +
      "export function assertPreviewLane(env, p) { const outside = [p.to].flat().filter((a) => !isPartnerEmail(a)); " +
      "if (outside.length === 0) return; const approved = approvedSendOf(env); " +
      'if (!approved) { throw new SendBlocked("no"); } ' +
      'if (outside.some((a) => a !== approved.recipient)) { throw new SendBlocked("wrong one"); } }',
    [LANE]:
      "export const APPROVAL_TOKEN_LENGTH = 26;\n" +
      "export function mintApprovalToken(r = crypto) { r.getRandomValues(new Uint8Array(64)); return 'X'; }\n" +
      'export async function hashApprovalToken(t) { return crypto.subtle.digest("SHA-256", t); }\n' +
      "export function previewFirstFor(i) { return { previewFirst: !isPartnerEmail(i.recipient) }; }",
    [SERVICE]:
      "export function handleOpenPreviewApproval(ctx) { return htmlPage('x', 'buttons'); }\n" +
      "export function handleDecidePreviewApproval(ctx) { return decidePreview(ctx.env, id, {}); }\n" +
      "export function handleDecidePreviewApprovalByToken(ctx) { return decidePreview(ctx.env, row.id, {}); }\n" +
      "function sendApproved(env, row) { return send({ to: row.recipient, subject: row.subject, text: row.body_text }); }",
    [ROUTES]:
      '.post("/api/preview-approvals/:id/decide", handleDecidePreviewApproval)\n' +
      '.get("/api/approve/:token", handleOpenPreviewApproval, { auth: false })\n' +
      '.post("/api/approve/:token/decide", handleDecidePreviewApprovalByToken, { auth: false })',
  };

  const cases = {
    "a boundary that stopped asserting the lane": {
      sources: { ...clean, [BOUNDARY]: clean[BOUNDARY].replace("assertPreviewLane(env, out);", "") },
      migration: cleanMigration,
    },
    "an assertion that logs instead of throwing": {
      sources: {
        ...clean,
        [BOUNDARY]: clean[BOUNDARY].replace(/throw new SendBlocked\("no"\);/, 'console.warn("no");'),
      },
      migration: cleanMigration,
    },
    "an assertion that takes any approval for any recipient": {
      sources: {
        ...clean,
        [BOUNDARY]: clean[BOUNDARY].replace(/if \(outside\.some[^}]*\}/, ""),
      },
      migration: cleanMigration,
    },
    "a guard that tests the domain instead of asking the registry": {
      sources: {
        ...clean,
        [BOUNDARY]: clean[BOUNDARY].replace(/isPartnerEmail\(a\)/, 'a.endsWith("@westpeek.ventures")'),
      },
      migration: cleanMigration,
    },
    "a typed partner address in the guard": {
      sources: {
        ...clean,
        [BOUNDARY]: clean[BOUNDARY].replace("return; const approved", 'return; if (a === "sequoia@westpeek.ventures") return; const approved'),
      },
      migration: cleanMigration,
    },
    "a token short enough to guess": {
      sources: { ...clean, [LANE]: clean[LANE].replace("APPROVAL_TOKEN_LENGTH = 26", "APPROVAL_TOKEN_LENGTH = 4") },
      migration: cleanMigration,
    },
    "a token minted from Math.random": {
      sources: { ...clean, [LANE]: clean[LANE].replace("r.getRandomValues(new Uint8Array(64));", "Math.random();") },
      migration: cleanMigration,
    },
    "a token stored in the clear": {
      sources: clean,
      migration: "CREATE TABLE preview_approval (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at TEXT, used_at TEXT);",
    },
    "a token with no expiry and no single use": {
      sources: clean,
      migration: "CREATE TABLE preview_approval (id TEXT PRIMARY KEY, token_sha256 TEXT NOT NULL);",
    },
    "a GET that sends the mail itself": {
      sources: {
        ...clean,
        [SERVICE]: clean[SERVICE].replace(
          "export function handleOpenPreviewApproval(ctx) { return htmlPage('x', 'buttons'); }",
          "export function handleOpenPreviewApproval(ctx) { return decidePreview(ctx.env, id, {}); }",
        ),
      },
      migration: cleanMigration,
    },
    "a phone door that decides for itself": {
      sources: {
        ...clean,
        [SERVICE]: clean[SERVICE].replace(
          "export function handleDecidePreviewApprovalByToken(ctx) { return decidePreview(ctx.env, row.id, {}); }",
          "export function handleDecidePreviewApprovalByToken(ctx) { return db.update('SENT'); }",
        ),
      },
      migration: cleanMigration,
    },
    "a send that re-renders instead of sending what she approved": {
      sources: {
        ...clean,
        [SERVICE]: clean[SERVICE].replace(
          "function sendApproved(env, row) { return send({ to: row.recipient, subject: row.subject, text: row.body_text }); }",
          "function sendApproved(env, row) { return send(renderExecEmail(row)); }",
        ),
      },
      migration: cleanMigration,
    },
    "a token route shadowed by the authenticated one": {
      sources: {
        ...clean,
        [ROUTES]:
          '.post("/api/preview-approvals/:id/decide", handleDecidePreviewApproval)\n' +
          '.get("/api/preview-approvals/:token", handleOpenPreviewApproval, { auth: false })\n' +
          '.post("/api/preview-approvals/:token/decide", handleDecidePreviewApprovalByToken, { auth: false })',
      },
      migration: cleanMigration,
    },
    "token doors quietly put behind the session wall": {
      sources: {
        ...clean,
        [ROUTES]:
          '.post("/api/preview-approvals/:id/decide", handleDecidePreviewApproval)\n' +
          '.get("/api/approve/:token", handleOpenPreviewApproval)\n' +
          '.post("/api/approve/:token/decide", handleDecidePreviewApprovalByToken)',
      },
      migration: cleanMigration,
    },
  };

  const failures = [];
  const cleanResult = checkSources(clean, cleanMigration);
  if (cleanResult.violations.length > 0) {
    failures.push(`the clean fixture was rejected: ${cleanResult.violations.join("; ")}`);
  }
  if (cleanResult.sendPathsExamined === 0) failures.push("the clean fixture examined zero send paths");
  for (const [name, fixture] of Object.entries(cases)) {
    if (checkSources(fixture.sources, fixture.migration).violations.length === 0) {
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
      "including a shadowed token route and a GET that sends mail by itself.",
  );
  process.exit(0);
}

function readTree(dir, extensions) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((e) => entry.name.endsWith(e))) {
        out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
      }
    }
  };
  walk(dir);
  return out;
}

const sources = readTree(SRC, [".ts", ".tsx"]);
if (Object.keys(sources).length === 0) {
  console.error(`PREVIEW-LANE SCAN FAILED — examined 0 sources under ${path.relative(ROOT, SRC)}.`);
  process.exit(1);
}
const migrationPath = path.join(ROOT, MIGRATION);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : null;

const { violations, sendPathsExamined } = checkSources(sources, migration);

if (sendPathsExamined === 0) {
  console.error("PREVIEW-LANE SCAN FAILED — examined 0 send paths. Either the boundary, the lane module and");
  console.error("the service were all renamed, or there is no lane. Both must fail loudly: a scan that passes");
  console.error("by finding nothing to check is the 'runs but inert' defect this repo keeps producing.");
  process.exit(1);
}
if (violations.length > 0) {
  console.error("PREVIEW-LANE SCAN FAILED — somebody outside the firm could be emailed without her yes:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("\nHer rule: anything to anyone other than the two partners is preview-first. It is enforced at");
  console.error(`the send boundary (${BOUNDARY}), and the token that approves one is a credential, not a tag.`);
  process.exit(1);
}

console.log(
  `PREVIEW-LANE SCAN PASSED: ${sendPathsExamined} send path(s) across ${Object.keys(sources).length} sources; ` +
    "the boundary asserts the lane and throws; the approval names one recipient and is compared against it; " +
    "the token is 128-bit, hashed, single-use and expiring; the GET decides nothing and the two doors share " +
    "one decision.",
);
