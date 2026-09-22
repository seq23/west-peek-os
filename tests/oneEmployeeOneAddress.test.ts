import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { replyToRequester, threadRootFor, type NoticeKind } from "../src/worker/services/requestReply";
import { sendPartnerEmail } from "../src/worker/services/execEmail";
import { execFooter } from "../src/shared/email/execEmail";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";
import { employeeSenderHeader } from "../src/shared/registry/employeeMail";
import { THREAD_TOKEN_RE } from "../src/shared/email/thread";

/**
 * ONE EMPLOYEE, ONE ADDRESS, AND EVERY EMAIL NAMES WHO ROUTED THE WORK (22 Sep 2026).
 *
 * THE DEFECT, seen in production the same day. One card, one employee, TWO sender addresses on TWO
 * domains: the intake notice went out "Delivered to scooter@westpeek.ventures as
 * os@westpeek.ventures" and the finished-work email went out as
 * "Porter · West Peek <porter@joinwestpeek.com>". Same conversation, split identity — in the
 * partner's mail client that is two correspondents writing two threads about one request.
 *
 * THE CAUSE WAS AN OMISSION. `transport()` in `services/execEmail.ts` never set `from`, so every
 * message through the firm's one door fell through to `env.WP_OS_EMAIL_FROM` — which is why
 * `WP_OS_EMAIL_FROM` is set to the firm's LP-facing address in this file's env, deliberately. Every
 * assertion below would have passed trivially against a stub that did not have one.
 *
 * WHAT IS PROVEN HERE:
 *
 *   · FIVE NOTICES ON ONE CARD, ONE SENDER. RECEIVED, PLAN, QUESTION, STUCK and DONE all leave as
 *     the employee, and none of them as the firm.
 *   · FIVE NOTICES ON ONE CARD, ONE THREAD. Every one after the first carries the FIRST one's token
 *     in `References` and names it in `In-Reply-To`, so a client shows one conversation.
 *   · THE DOER SIGNS AND THE EMAIL NAMES THE ROUTER. A card handed over by a chief of staff carries
 *     "Walker routed this to me; the work is mine."; a card nobody handed over carries a footer that
 *     is BYTE-IDENTICAL to the one it had before this existed.
 *   · EVERY ROSTER EMPLOYEE SIGNS AS THEMSELVES, one address each, resolved from the roster.
 *   · A SENDER THAT CANNOT BE RESOLVED REFUSES rather than falling back to the firm — and mints no
 *     thread row, because a reply matched to a conversation that never happened steers real work.
 */

let t: TestDb;
let env: Env;

interface Wire {
  to: string[];
  from: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}
const wire: Wire[] = [];

const SCOOTER = "scooter@westpeek.ventures";
const FIRM_FROM = "os@westpeek.ventures";
const CARD = "wc_one_address";
const ROUTED_FROM = "wc_one_address_router";
const PORTER_FROM = "Porter · West Peek <porter@joinwestpeek.com>";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    // THE FALLBACK THE DEFECT USED. Left set on purpose: if a send path ever stops naming its
    // sender again, these assertions see this address rather than a missing one.
    WP_OS_EMAIL_FROM: FIRM_FROM,
  } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      wire.push(JSON.parse(String(init?.body)) as Wire);
      return new Response(JSON.stringify({ id: `re_${wire.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren')").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

async function openCard(over: { assignedFrom?: string | null } = {}): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card (id, title, state, owner_type, owner_id, priority, firm_scope, requested_by_email, assigned_from_card_id, created_by)
     VALUES (?1, ?2, 'IN_PROGRESS', 'AI', 'aie_porter', 'NORMAL', 'west-peek', ?3, ?4, 'fu_sequoia_taylor')`,
  )
    .bind(CARD, `From ${SCOOTER}: the ventures forms are down`, SCOOTER, over.assignedFrom ?? null)
    .run();
}

/** The card the work was handed on FROM, owned by Scooter's chief of staff. */
async function openRouterCard(): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card (id, title, state, owner_type, owner_id, priority, firm_scope, created_by)
     VALUES (?1, 'the ventures forms are down', 'DONE', 'AI', 'aie_walker', 'NORMAL', 'west-peek', 'fu_scooter_taylor')`,
  )
    .bind(ROUTED_FROM)
    .run();
}

async function card(): Promise<Parameters<typeof replyToRequester>[1]> {
  return (await env.WP_OS_DB.prepare(
    "SELECT id, title, kind, requested_by_email, firm_scope, preview_first, preview_owner_id, requester_notes, requester_notes_by, assigned_from_card_id FROM work_card WHERE id = ?1",
  )
    .bind(CARD)
    .first())! as never;
}

/** One notice of each kind, in the order a real card produces them. */
const SEQUENCE: ReadonlyArray<{ kind: NoticeKind; outcome: "DONE" | "BLOCKED" }> = [
  { kind: "RECEIVED", outcome: "BLOCKED" },
  { kind: "PLAN", outcome: "BLOCKED" },
  { kind: "QUESTION", outcome: "BLOCKED" },
  { kind: "STUCK", outcome: "BLOCKED" },
  { kind: "DONE", outcome: "DONE" },
];

async function sendSequence(): Promise<void> {
  for (const step of SEQUENCE) {
    const out = await replyToRequester(env, await card(), step.outcome, "Porter", `${step.kind}: where the work stands.`, {
      kind: step.kind,
      cause: step.kind,
    });
    expect(out.sent, `${step.kind} should have been sent: ${out.reason}`).toBe(true);
  }
}

beforeEach(async () => {
  wire.length = 0;
  for (const id of [CARD, ROUTED_FROM]) {
    await env.WP_OS_DB.prepare("DELETE FROM work_card_notice WHERE work_card_id = ?1").bind(id).run();
    await env.WP_OS_DB.prepare("DELETE FROM email_thread WHERE object_id = ?1").bind(id).run();
    await env.WP_OS_DB.prepare("DELETE FROM work_card WHERE id = ?1").bind(id).run();
  }
});

describe("one employee, one address", () => {
  it("signs all five notices on one card as the employee, never as the firm", async () => {
    await openCard();
    await sendSequence();

    expect(wire.length, "five notices, five messages").toBe(5);
    for (const [i, msg] of wire.entries()) {
      expect(msg.from, `${SEQUENCE[i]!.kind} signs as Porter`).toBe(PORTER_FROM);
      expect(msg.from, "and never as the firm's LP-facing address — the 22 Sep defect").not.toContain(FIRM_FROM);
      expect(msg.from).toContain("@joinwestpeek.com");
      expect(msg.from, "an employee is never on the partners' domain").not.toContain("@westpeek.ventures");
    }
    expect(new Set(wire.map((m) => m.from)).size, "ONE sender for the whole conversation").toBe(1);
  });

  it("threads all five notices on the same References token", async () => {
    await openCard();
    await sendSequence();

    const root = await threadRootFor(env, CARD);
    expect(root, "the first notice's token is the conversation's root").toMatch(/^wpt_[0-9a-f]{32}$/);

    const [first, ...rest] = wire;
    expect(first!.headers?.References, "the first message names only itself").toContain(root!);
    for (const [i, msg] of rest.entries()) {
      const refs = msg.headers?.References ?? "";
      expect(refs, `${SEQUENCE[i + 1]!.kind} descends from the root`).toContain(root!);
      expect(msg.headers?.["In-Reply-To"], `${SEQUENCE[i + 1]!.kind} replies to the root`).toContain(root!);
      // Its own token rides alongside, so a reply to THIS message is still placeable.
      expect((refs.match(THREAD_TOKEN_RE) ?? []).length, "root plus its own").toBe(2);
    }
    const chains = new Set(wire.map((m) => (m.headers?.References ?? "").match(THREAD_TOKEN_RE)?.[0]?.toLowerCase()));
    expect(chains, "one chain, not five").toEqual(new Set([root]));
  });
});

describe("the doer signs, and the email names the router", () => {
  it("names the chief of staff who routed it, on every notice", async () => {
    await openRouterCard();
    await openCard({ assignedFrom: ROUTED_FROM });
    await sendSequence();

    for (const [i, msg] of wire.entries()) {
      expect(msg.text, `${SEQUENCE[i]!.kind} names the router`).toContain("Walker routed this to me; the work is mine.");
      expect(msg.text, "and still names the doer").toContain("— Porter, Systems & Intake Operator.");
      expect(msg.from, "the work is Porter's, so Porter signs it").toBe(PORTER_FROM);
    }
  });

  it("with no hand-off, the footer is byte-identical to the one before the rule existed", async () => {
    await openCard();
    await sendSequence();

    const before = execFooter("Porter");
    for (const [i, msg] of wire.entries()) {
      const footer = msg.text.split("\n").filter((l) => l.trim() !== "").at(-1)!;
      expect(footer, `${SEQUENCE[i]!.kind} carries the unchanged footer`).toBe(before);
      expect(footer, "nobody routed it, so nobody is named as having").not.toContain("routed this to me");
    }
    expect(before, "and that footer never mentions a router").not.toContain("routed");
  });

  it("a hand-off to yourself is not a hand-off", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO work_card (id, title, state, owner_type, owner_id, priority, firm_scope, created_by)
       VALUES (?1, 'earlier', 'DONE', 'AI', 'aie_porter', 'NORMAL', 'west-peek', 'fu_scooter_taylor')`,
    )
      .bind(ROUTED_FROM)
      .run();
    await openCard({ assignedFrom: ROUTED_FROM });
    await sendSequence();
    for (const msg of wire) expect(msg.text).not.toContain("routed this to me");
  });
});

describe("the roster is the list", () => {
  it("gives every employee exactly one address, and signs as it", async () => {
    const addresses = new Map<string, string>();
    for (const employee of AI_EMPLOYEE_ROSTER) {
      const header = employeeSenderHeader(employee.name);
      const address = header.slice(header.indexOf("<") + 1, -1);
      expect(address, `${employee.name} is on the employee domain`).toBe(`${employee.name.toLowerCase()}@joinwestpeek.com`);
      expect(addresses.has(address), `${address} is claimed by ${addresses.get(address) ?? ""} as well`).toBe(false);
      addresses.set(address, employee.name);
    }
    expect(addresses.size, "one address each, no two employees sharing a mailbox").toBe(AI_EMPLOYEE_ROSTER.length);

    // And the wire agrees with the registry, for a sample of the roster on the real send path.
    for (const name of ["Porter", "Walker", "Wren"]) {
      wire.length = 0;
      const out = await sendPartnerEmail(env, {
        to: SCOOTER,
        email: {
          employee: name,
          what: "a note",
          tldr: "One line.",
          sections: [
            { label: "What I did", bullets: ["A thing."] },
            { label: "Your call", bullets: ["Nothing."] },
          ],
        },
        objectType: "work_card",
        objectId: `${CARD}_${name}`,
        firmScope: "west-peek",
      });
      expect(out.sent, out.reason).toBe(true);
      expect(wire[0]!.from).toBe(employeeSenderHeader(name));
    }
  });

  it("refuses rather than falling back to the firm when the sender cannot be resolved", async () => {
    const out = await sendPartnerEmail(env, {
      to: SCOOTER,
      email: {
        employee: "Prestn",
        what: "a note",
        tldr: "One line.",
        sections: [
          { label: "What I did", bullets: ["A thing."] },
          { label: "Your call", bullets: ["Nothing."] },
        ],
      },
      objectType: "work_card",
      objectId: "wc_typo_sender",
      firmScope: "west-peek",
    });
    expect(out.sent).toBe(false);
    expect(out.reason).toMatch(/no sender could be resolved/i);
    expect(out.reason).toMatch(/not on the West Peek roster/i);
    expect(wire.length, "nothing reached the wire as the firm instead").toBe(0);

    const thread = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM email_thread WHERE object_id = ?1")
      .bind("wc_typo_sender")
      .first<{ n: number }>();
    expect(thread?.n, "and no thread row is left pointing at a conversation that never happened").toBe(0);
  });
});
