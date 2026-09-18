import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import {
  decidePreview,
  filePreview,
  resurfaceStalePreviews,
  sendOrPreview,
} from "../src/worker/services/previewApproval";
import {
  PREVIEW_NAG_AFTER_HOURS,
  previewNagDue,
  previewOwnerFor,
  previewStartsTicked,
} from "../src/shared/work/previewLane";
import { PARTNERS, PREVIEW_PARTNER, partnerByFirmUserId } from "../src/shared/registry/partners";
import { parkerAddressedNote, parkerSponsorAsk } from "../src/shared/events/parkerNote";

/**
 * THE PREVIEW LANE, REACHABLE (18 Sep 2026).
 *
 * `tests/previewLane.test.ts` proves the lane WORKS. Every one of its assertions passed on a
 * feature that had never run once in production, because nothing could reach it:
 * `CreateWorkCardInput` carried neither of her two fields, `sendOrPreview` was called from one
 * file, and no client called either endpoint. `preview_approval` held zero rows.
 *
 * This file proves it can be REACHED, and that the four things that used to happen silently now
 * happen loudly:
 *
 *   · WHOSE IT IS. Resolved through the partner registry and nowhere else.
 *   · IT NAGS, AND IT DOES NOT VANISH. 48 hours, the blocked-card cadence; a lapsed one surfaces.
 *   · THE DOORS DO SOMETHING. Send it back reopens the card; Dismiss closes it; a failed send is
 *     SEND_FAILED rather than a silent SENT.
 *   · THE ARCHIVE FAILURE IS WRITTEN DOWN, which is the thing that hid a CHECK bug for a day.
 */

let t: TestDb;
let env: Env;

const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
const SCOOTER = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const SCOOTER_PARTNER = partnerByFirmUserId("fu_scooter_taylor")!;

interface Sent {
  to: string[];
  subject: string;
  text: string;
}

function captureFetch(sent: Sent[], fail = false): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("api.resend.com")) throw new Error(`unexpected request to ${u}`);
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return fail
      ? new Response(JSON.stringify({ message: "the provider refused this message" }), { status: 422 })
      : new Response(JSON.stringify({ id: "re_reach" }), { status: 200 });
  });
}

beforeAll(async () => {
  t = await createTestDb();
  env = {
    ...makeTestEnv(t.db, {} as Partial<Env>),
    RESEND_API_KEY: "re_test",
    WP_OS_EMAIL_SEND: "enabled",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
  } as Env;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 1 · whose preview is it ───────────────────────────────────────────────────────────────────

describe("the preview goes to whoever ticked the box", () => {
  it("prefers the ticker, then whoever asked by email, then her — and can only ever yield a partner", () => {
    expect(previewOwnerFor({ tickedByFirmUserId: "fu_scooter_taylor" })).toBe(SCOOTER_PARTNER);
    expect(previewOwnerFor({ requestedByEmail: SCOOTER_PARTNER.email })).toBe(SCOOTER_PARTNER);
    // The tick WINS over the request: she can ask to see something Scooter asked for.
    expect(
      previewOwnerFor({ tickedByFirmUserId: PREVIEW_PARTNER.firmUserId, requestedByEmail: SCOOTER_PARTNER.email }),
    ).toBe(PREVIEW_PARTNER);
    // A scheduled job ticked nothing and asked nobody.
    expect(previewOwnerFor({})).toBe(PREVIEW_PARTNER);

    /*
     * THE GUARANTEE THAT USED TO COME FREE FROM A CONSTANT. `PREVIEW_PARTNER` could not be anybody
     * but a partner because it was one. Now that the owner is dynamic, the ONLY way to obtain one
     * is a registry lookup — so a value that matches nobody falls through rather than passing
     * through, and the approval link cannot be mailed outside the firm.
     */
    for (const stranger of ["fu_someone_else", "founder@startup.example", "", "  ", "fu_", "admin"]) {
      const owner = previewOwnerFor({ tickedByFirmUserId: stranger, requestedByEmail: stranger });
      expect(PARTNERS, `"${stranger}" must not become an owner`).toContain(owner);
      expect(owner).toBe(PREVIEW_PARTNER);
    }
  });

  it("starts the box ticked for an outsider and unticked for either partner — and that is ALL it does", () => {
    for (const p of PARTNERS) expect(previewStartsTicked(p.email), p.email).toBe(false);
    for (const outsider of ["founder@startup.example", "info@westpeek.ventures", "", null, undefined]) {
      expect(previewStartsTicked(outsider), String(outsider)).toBe(true);
    }
  });

  it("files a preview Scooter ticked to SCOOTER, on his Home and at his address", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);
    const out = await sendOrPreview(env, {
      to: "bookings@venue.example",
      email: {
        employee: "Parker",
        what: "the note to the venue",
        tldr: "I am asking about your space for a small evening in March.",
        sections: [
          { label: "The Room", bullets: ["An evening for twenty people in March."] },
          { label: "Why I am writing", bullets: ["Is the space free on a weekday evening?"] },
        ],
      },
      objectType: "work_card",
      objectId: "wc_owner_test",
      firmScope: "west-peek",
      cardAsked: null,
      tickedByFirmUserId: "fu_scooter_taylor",
    });

    expect(out.previewed).toBe(true);
    expect(out.owner).toBe("fu_scooter_taylor");
    // The single-use credential went to HIS address. It is the link that sends the mail.
    expect(sent.map((s) => s.to).flat()).toEqual([SCOOTER_PARTNER.email]);
    // And the venue heard nothing.
    expect(sent.some((s) => s.to.includes("bookings@venue.example"))).toBe(false);

    const row = await t.db
      .prepare("SELECT owner_firm_user_id, deliverable_id, archive_error FROM preview_approval WHERE id = ?1")
      .bind(out.approvalId!)
      .first<{ owner_firm_user_id: string; deliverable_id: string | null; archive_error: string | null }>();
    expect(row!.owner_firm_user_id).toBe("fu_scooter_taylor");
    // The Home copy was filed, and to HIM — not to a constant.
    expect(row!.deliverable_id, "the archive copy must exist").not.toBeNull();
    expect(row!.archive_error).toBeNull();
    const filed = await t.db
      .prepare("SELECT prepared_for, kind FROM deliverable WHERE id = ?1")
      .bind(row!.deliverable_id)
      .first<{ prepared_for: string; kind: string }>();
    expect(filed).toMatchObject({ prepared_for: "fu_scooter_taylor", kind: "approval_preview" });
  });
});

// ── 2 · her two fields, on the card ───────────────────────────────────────────────────────────

describe("every work card carries her two fields", () => {
  it("writes who it is for, whether to show her first, and who ticked it", async () => {
    const res = await handleRequest(
      new Request("https://os.joinwestpeek.com/api/work-cards", {
        method: "POST",
        headers: { ...SCOOTER, "content-type": "application/json" },
        body: JSON.stringify({
          title: "Draft the note to the venue about March",
          result_recipient: "Bookings@Venue.Example",
          preview_first: true,
        }),
      }),
      env,
    );
    expect(res.status).toBe(201);
    const card = (await res.json()) as { id: string };
    const row = await t.db
      .prepare("SELECT result_recipient, preview_first, preview_owner_id FROM work_card WHERE id = ?1")
      .bind(card.id)
      .first<{ result_recipient: string; preview_first: number; preview_owner_id: string }>();
    // Lower-cased on the way in, so two spellings of one address are one address.
    expect(row).toMatchObject({
      result_recipient: "bookings@venue.example",
      preview_first: 1,
      preview_owner_id: "fu_scooter_taylor",
    });
  });

  it("keeps NULL meaning 'nobody said', which is what leaves the default rule in charge", async () => {
    const res = await handleRequest(
      new Request("https://os.joinwestpeek.com/api/work-cards", {
        method: "POST",
        headers: { ...SEQUOIA, "content-type": "application/json" },
        body: JSON.stringify({ title: "Something a machine opened" }),
      }),
      env,
    );
    const card = (await res.json()) as { id: string };
    const row = await t.db
      .prepare("SELECT result_recipient, preview_first, preview_owner_id FROM work_card WHERE id = ?1")
      .bind(card.id)
      .first<{ result_recipient: string | null; preview_first: number | null; preview_owner_id: string | null }>();
    /*
     * THREE VALUES, NOT TWO. Collapsing "nobody said" into 0 would mean every machine-created card
     * carried "she said do not preview this", which is the opposite of what silence means.
     */
    expect(row).toMatchObject({ result_recipient: null, preview_first: null, preview_owner_id: null });
  });

  it("lets her change the tick on a card that already exists", async () => {
    const made = await handleRequest(
      new Request("https://os.joinwestpeek.com/api/work-cards", {
        method: "POST",
        headers: { ...SEQUOIA, "content-type": "application/json" },
        body: JSON.stringify({ title: "A note for Scooter", result_recipient: "scooter@westpeek.ventures", preview_first: false }),
      }),
      env,
    );
    const card = (await made.json()) as { id: string };
    // HER REAL CASE: something for Scooter that she wants to see first. One tick, after the fact.
    const changed = await handleRequest(
      new Request(`https://os.joinwestpeek.com/api/work-cards/${card.id}`, {
        method: "PATCH",
        headers: { ...SEQUOIA, "content-type": "application/json" },
        body: JSON.stringify({ preview_first: true }),
      }),
      env,
    );
    expect(changed.status).toBe(200);
    const row = await t.db
      .prepare("SELECT preview_first FROM work_card WHERE id = ?1")
      .bind(card.id)
      .first<{ preview_first: number }>();
    expect(row!.preview_first).toBe(1);
  });
});

// ── 3 · nothing expires into silence ──────────────────────────────────────────────────────────

describe("an unanswered preview nags, and a lapsed one surfaces", () => {
  it("nags the OWNER at 48 hours, once, on the blocked-card cadence", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);
    const filed = await filePreview(env, {
      employee: "Walker",
      what: "the note nobody answered",
      subject: "Walker: a note",
      bodyText: "the body",
      recipient: "founder@startup.example",
      laneReason: "DEFAULT_OUTSIDE_FIRM",
      owner: SCOOTER_PARTNER,
    });

    // Not yet. 47 hours is not 48, and a nag that fires early is a nag she learns to ignore.
    const early = new Date(Date.now() + 47 * 3600_000);
    expect(previewNagDue({ createdAt: filed.approval.created_at, now: early })).toBe(false);
    const nothing = await resurfaceStalePreviews(env, early);
    expect(nothing.nagged).not.toContain(filed.approval.id);

    const late = new Date(Date.now() + (PREVIEW_NAG_AFTER_HOURS + 1) * 3600_000);
    const first = await resurfaceStalePreviews(env, late);
    expect(first.examined, "a run that examines nothing is not a passing run").toBeGreaterThan(0);
    expect(first.nagged).toContain(filed.approval.id);

    // IT RANG THE OWNER, one person — not "the partners".
    const notice = await t.db
      .prepare(
        "SELECT firm_user_id, severity, title FROM notification WHERE object_id = ?1 AND object_type = 'preview_approval' ORDER BY created_at DESC",
      )
      .bind(filed.approval.id)
      .first<{ firm_user_id: string; severity: string; title: string }>();
    expect(notice!.firm_user_id).toBe("fu_scooter_taylor");
    expect(notice!.title).toContain("Still waiting on you");

    const after = await t.db
      .prepare("SELECT nag_count, last_nagged_at FROM preview_approval WHERE id = ?1")
      .bind(filed.approval.id)
      .first<{ nag_count: number; last_nagged_at: string }>();
    expect(after!.nag_count).toBe(1);

    // AND NOT AGAIN IMMEDIATELY. The clock restarts from the nag, not from the filing.
    const again = await resurfaceStalePreviews(env, late);
    expect(again.nagged).not.toContain(filed.approval.id);
  });

  it("SURFACES a lapsed preview instead of dropping it, and sends it back rather than out", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);
    const filed = await filePreview(env, {
      employee: "Walker",
      what: "the note that lapsed",
      subject: "Walker: a lapsed note",
      bodyText: "the body",
      recipient: "reporter@paper.example",
      laneReason: "DEFAULT_OUTSIDE_FIRM",
      owner: PREVIEW_PARTNER,
    });
    await t.db
      .prepare("UPDATE preview_approval SET expires_at = ?2 WHERE id = ?1")
      .bind(filed.approval.id, new Date(Date.now() - 3600_000).toISOString())
      .run();

    /*
     * IT IS STILL ON HER HOME. The old list filtered `expires_at > now`, so at 72 hours the work
     * disappeared with nobody told and the only trace was a row.
     */
    const listed = await handleRequest(
      new Request("https://os.joinwestpeek.com/api/preview-approvals", { headers: SEQUOIA }),
      env,
    );
    const body = (await listed.json()) as {
      previews: Array<{ id: string; lapsed: boolean; lapsed_note: string | null }>;
    };
    const mine = body.previews.find((p) => p.id === filed.approval.id);
    expect(mine, "a lapsed preview must not vanish").toBeDefined();
    expect(mine!.lapsed).toBe(true);
    expect(mine!.lapsed_note).toContain("lapsed");
    // And it says how to get a fresh one, by name.
    expect(mine!.lapsed_note).toContain("Walker");

    // A 72-hour-old draft does not go out…
    sent.length = 0;
    await expect(
      decidePreview(env, filed.approval.id, { action: "SEND", byFirmUserId: PREVIEW_PARTNER.firmUserId, via: "HOME" }),
    ).rejects.toMatchObject({ status: 410 });
    expect(sent).toHaveLength(0);

    // …and the two ways OUT still work. Refusing these was refusing her only exit.
    const out = await decidePreview(env, filed.approval.id, {
      action: "RETURN",
      byFirmUserId: PREVIEW_PARTNER.firmUserId,
      via: "HOME",
      note: "Too old now — redo it with this week's numbers.",
    });
    expect(out.approval.state).toBe("RETURNED");
  });
});

// ── 4 · the three doors do something ──────────────────────────────────────────────────────────

describe("the three doors", () => {
  /** A real card an employee owns, so the sweep could pick it up again. */
  async function cardFor(title: string): Promise<string> {
    const id = `wc_${crypto.randomUUID()}`;
    await t.db
      .prepare(
        `INSERT INTO work_card (id, title, owner_type, owner_id, state, priority, privacy_label, firm_scope, created_by, work_attempts)
         VALUES (?1, ?2, 'AI', 'aie_walker', 'DONE', 'NORMAL', 'INTERNAL', 'west-peek', 'fu_sequoia_taylor', 3)`,
      )
      .bind(id, title)
      .run();
    return id;
  }

  it("SEND IT BACK reopens the card and puts her words where the model will read them", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);
    const cardId = await cardFor("Draft the note to the producer");
    const filed = await filePreview(env, {
      employee: "Walker",
      what: "the note to the producer",
      subject: "Walker: a note",
      bodyText: "the body",
      recipient: "jordan@producer.example",
      laneReason: "DEFAULT_OUTSIDE_FIRM",
      owner: PREVIEW_PARTNER,
      workCardId: cardId,
    });

    await decidePreview(env, filed.approval.id, {
      action: "RETURN",
      byFirmUserId: PREVIEW_PARTNER.firmUserId,
      via: "HOME",
      note: "Too long, and it does not say why we are writing.",
    });

    /*
     * THE PART THAT WAS MISSING. RETURN wrote a row, wrote an event and stopped — the same shape of
     * bug fixed in decks on 14 Sep. The card is now back in front of `claimNextCard`: owned by an
     * employee, OPEN, no lease, attempts reset.
     */
    const card = await t.db
      .prepare("SELECT state, work_attempts, lease_until, prompt, next_action FROM work_card WHERE id = ?1")
      .bind(cardId)
      .first<{ state: string; work_attempts: number; lease_until: string | null; prompt: string; next_action: string }>();
    expect(card!.state).toBe("OPEN");
    expect(card!.work_attempts).toBe(0);
    expect(card!.lease_until).toBeNull();
    // HER WORDS IN `prompt`, which is what steerFor reads. A note on the card alone is a note no
    // model ever sees, and the redo comes back identical to the draft she rejected.
    expect(card!.prompt).toContain("does not say why we are writing");
    expect(card!.next_action).toContain("sent back");

    // The employee hears about it through the channel a weekly duty can still read.
    const steer = await t.db
      .prepare("SELECT said_by FROM work_steer WHERE from_card_id = ?1")
      .bind(cardId)
      .first<{ said_by: string }>();
    if (steer) expect(steer.said_by).toBe(PREVIEW_PARTNER.firmUserId);
  });

  it("DISMISS closes a card that is still live, and leaves a finished one finished", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);

    const liveId = await cardFor("Something still being worked");
    /*
     * THE ALLOWANCE COMES BACK WITH IT (0194). `cardFor` makes a DONE card with its attempts spent,
     * and the database now refuses OPEN at the ceiling — so this fixture has to do what every real
     * put-back does. The trigger caught this test setting up a state production can no longer hold,
     * which is the guard doing its job on its first run.
     */
    await t.db
      .prepare("UPDATE work_card SET state = 'OPEN', work_attempts = 0, lease_until = NULL WHERE id = ?1")
      .bind(liveId)
      .run();
    const live = await filePreview(env, {
      employee: "Walker", what: "a note", subject: "Walker: a note", bodyText: "b",
      recipient: "founder@startup.example", laneReason: "DEFAULT_OUTSIDE_FIRM",
      owner: PREVIEW_PARTNER, workCardId: liveId,
    });
    const out = await decidePreview(env, live.approval.id, {
      action: "DISMISS", byFirmUserId: PREVIEW_PARTNER.firmUserId, via: "HOME",
    });
    // IT SAYS SO. "It dies there" told her nothing about the card that produced it.
    expect(out.detail).toContain("closed");
    const closed = await t.db.prepare("SELECT state FROM work_card WHERE id = ?1").bind(liveId).first<{ state: string }>();
    expect(closed!.state).toBe("CANCELLED");

    /*
     * AND A CARD THAT REALLY WAS FINISHED IS NOT REWRITTEN. Most previews are filed at the end of a
     * run, so the card is DONE by the time she answers; turning that into CANCELLED would falsify
     * the record of work that was actually done.
     */
    const doneId = await cardFor("Something already finished");
    const done = await filePreview(env, {
      employee: "Walker", what: "a note", subject: "Walker: a note", bodyText: "b",
      recipient: "founder@startup.example", laneReason: "DEFAULT_OUTSIDE_FIRM",
      owner: PREVIEW_PARTNER, workCardId: doneId,
    });
    await decidePreview(env, done.approval.id, {
      action: "DISMISS", byFirmUserId: PREVIEW_PARTNER.firmUserId, via: "HOME",
    });
    const stillDone = await t.db.prepare("SELECT state FROM work_card WHERE id = ?1").bind(doneId).first<{ state: string }>();
    expect(stillDone!.state).toBe("DONE");
  });

  it("NEVER records a silent SENT when the transport refuses it", async () => {
    const sent: Sent[] = [];
    captureFetch(sent, true); // the provider says 422
    const filed = await filePreview(env, {
      employee: "Walker", what: "a note that will not go", subject: "Walker: a note", bodyText: "b",
      recipient: "founder@startup.example", laneReason: "DEFAULT_OUTSIDE_FIRM",
      owner: PREVIEW_PARTNER,
    });

    const out = await decidePreview(env, filed.approval.id, {
      action: "SEND", byFirmUserId: PREVIEW_PARTNER.firmUserId, via: "HOME",
    });
    expect(out.sent).toBe(false);
    expect(out.approval.state, "a refused send is not a send").toBe("SEND_FAILED");
    expect(out.detail).toContain("NOT sent");

    // IT IS STILL ON HER HOME, saying what happened.
    const listed = await handleRequest(
      new Request("https://os.joinwestpeek.com/api/preview-approvals", { headers: SEQUOIA }),
      env,
    );
    const body = (await listed.json()) as { previews: Array<{ id: string; state: string; send_detail: string }> };
    const mine = body.previews.find((p) => p.id === filed.approval.id);
    expect(mine, "a failed send must not disappear").toBeDefined();
    expect(mine!.state).toBe("SEND_FAILED");

    // AND SHE CAN TRY AGAIN. She answered; the machinery did not.
    vi.unstubAllGlobals();
    const second: Sent[] = [];
    captureFetch(second);
    const retry = await decidePreview(env, filed.approval.id, {
      action: "SEND", byFirmUserId: PREVIEW_PARTNER.firmUserId, via: "HOME",
    });
    expect(retry.sent, retry.detail).toBe(true);
    expect(second.some((m) => m.to.includes("founder@startup.example"))).toBe(true);
  });
});

// ── 5 · the archive failure is recorded, not swallowed ────────────────────────────────────────

describe("the empty catch that hid a CHECK bug for a day", () => {
  it("keeps the approval alive through an archive outage AND writes down why", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);

    /*
     * THE REAL FAILURE, REPRODUCED IN KIND. In production the `deliverable.kind` CHECK rejected
     * every `approval_preview` insert from migration 0183 until 0189, and `catch {}` threw the
     * reason away — so the only symptom anybody could see was a validator that needs production
     * credentials going red. Taking the table out of reach produces the same shape of failure at
     * the same statement, and it is put back immediately afterwards.
     */
    await t.db.exec("ALTER TABLE deliverable RENAME TO deliverable_hidden_for_test");
    let filed;
    try {
      filed = await filePreview(env, {
        employee: "Walker",
        what: "a note filed while the archive was down",
        subject: "Walker: a note",
        bodyText: "the body",
        recipient: "founder@startup.example",
        laneReason: "DEFAULT_OUTSIDE_FIRM",
        owner: PREVIEW_PARTNER,
      });
    } finally {
      await t.db.exec("ALTER TABLE deliverable_hidden_for_test RENAME TO deliverable");
    }

    // THE BEHAVIOUR IS UNCHANGED: losing her approval because the archive is down is the wrong trade.
    expect(filed.approval.state).toBe("PENDING");
    expect(filed.emailed, "the email with the three buttons still went").toBe(true);

    // AND THE REASON IS NO LONGER DISCARDED.
    const row = await t.db
      .prepare("SELECT deliverable_id, archive_error, archive_failed_at FROM preview_approval WHERE id = ?1")
      .bind(filed.approval.id)
      .first<{ deliverable_id: string | null; archive_error: string | null; archive_failed_at: string | null }>();
    expect(row!.deliverable_id).toBeNull();
    expect(row!.archive_error, "the reason must be written down").not.toBeNull();
    expect(row!.archive_failed_at).not.toBeNull();

    // On the spine too, so it is COUNTABLE. One row is an incident; a count is an outage.
    const event = await t.db
      .prepare("SELECT event_type FROM event_record WHERE object_id = ?1 AND event_type = 'preview_approval.archive_failed'")
      .bind(filed.approval.id)
      .first<{ event_type: string }>();
    expect(event, "an archive failure must reach the event spine").not.toBeNull();
  });
});

// ── 6 · Parker emits a message, not a bare packet ─────────────────────────────────────────────

describe("Parker writes to the person, not just about them", () => {
  it("addresses the recipient, and carries none of the firm's economics", () => {
    const note = parkerAddressedNote({
      recipient: "sponsor@brand.example",
      what: "Room",
      monthName: "March",
      title: "What community actually costs",
      premise: "Who pays for a community, and what do they get back?",
      venue: "a private room in Austin",
      targetMin: 18,
      targetMax: 24,
      packetUrl: "https://os.joinwestpeek.com/api/documents/doc_1/download",
      theAsk: parkerSponsorAsk({ what: "Room", monthName: "March" }),
    });

    // IT IS FROM PARKER. "Send it" releases HIS message — never a forward with her name on it.
    expect(note.employee).toBe("Parker");
    expect(note.tldr).toContain("I'm Parker");
    // It says what it is asking for, in the first thing anybody reads.
    expect(note.tldr).toContain("sponsor slots");

    /*
     * AND IT CANNOT LEAK THE FIRM'S NUMBERS, because it is never handed them: the input has no
     * economics field at all. The partners' copy carries what the Room costs, what the firm keeps,
     * and which sponsors were ranked above which — none of which belongs in a note to one of them.
     */
    const whole = JSON.stringify(note).toLowerCase();
    for (const word of ["the firm's keep", "estimated cost", "sponsor_total", "ranked"]) {
      expect(whole, `"${word}" must not reach a sponsor`).not.toContain(word);
    }
    // Every input it DOES carry is something the recipient is entitled to see.
    expect(whole).toContain("march");
    expect(JSON.stringify(note)).toContain("a private room in Austin");
    expect(JSON.stringify(note)).toContain("18–24 people");

    // There is always a way out for them, which is what makes a cold note honest.
    expect(JSON.stringify(note)).toContain("Say so and I will not write again");
  });
});

// ── 7 · putting a card back gives it its attempts back ────────────────────────────────────────

describe("the Work page's own put-back", () => {
  /**
   * THE SECOND ROUTE INTO THE DEAD STATE, and the one that actually produced it.
   *
   * `ALLOWED_TRANSITIONS` permits BLOCKED → OPEN and IN_PROGRESS → OPEN from this handler. Every
   * other door that puts a card back — `answerBlock`, `reopen`, the preview lane's "send it back",
   * migration 0173's own backfill — writes `work_attempts = 0` with it. This one did not, so a
   * person walking a card back to OPEN left the count at the ceiling: unclaimable, not BLOCKED,
   * and therefore carrying no reason, no doors and no nag. That is exactly the state "Draft event
   * kit: October workshop with Kirx Diaz" sat in for fourteen hours.
   */
  it("resets the allowance when a card is walked back into the queue", async () => {
    const id = `wc_${crypto.randomUUID()}`;
    await t.db
      .prepare(
        `INSERT INTO work_card (id, title, owner_type, owner_id, state, priority, privacy_label, firm_scope,
             created_by, work_attempts, work_steps, lease_until)
         VALUES (?1, 'Draft event kit: October workshop', 'AI', 'aie_parker', 'IN_PROGRESS', 'NORMAL', 'INTERNAL',
             'west-peek', 'fu_sequoia_taylor', 3, 9, '2026-09-18T01:15:09.000Z')`,
      )
      .bind(id)
      .run();

    const res = await handleRequest(
      new Request(`https://os.joinwestpeek.com/api/work-cards/${id}`, {
        method: "PATCH",
        headers: { ...SEQUOIA, "content-type": "application/json" },
        body: JSON.stringify({ state: "OPEN" }),
      }),
      env,
    );
    expect(res.status, "the button must work, not 409").toBe(200);

    const row = await t.db
      .prepare("SELECT state, work_attempts, work_steps, lease_until FROM work_card WHERE id = ?1")
      .bind(id)
      .first<{ state: string; work_attempts: number; work_steps: number; lease_until: string | null }>();
    expect(row!.state).toBe("OPEN");
    // A fresh allowance, because a person putting a card back is SAYING try this again. Handing it
    // back still exhausted would honour the button and not the intent.
    expect(row!.work_attempts, "an OPEN card at the ceiling can never be picked up").toBe(0);
    expect(row!.work_steps).toBe(0);
    // And not leased to a run that is no longer happening.
    expect(row!.lease_until).toBeNull();
  });

  it("leaves the allowance alone when the state is not what changed", async () => {
    const made = await handleRequest(
      new Request("https://os.joinwestpeek.com/api/work-cards", {
        method: "POST",
        headers: { ...SEQUOIA, "content-type": "application/json" },
        body: JSON.stringify({ title: "A card being renamed, not re-queued", owner_type: "AI", owner_id: "aie_parker" }),
      }),
      env,
    );
    const card = (await made.json()) as { id: string };
    await t.db.prepare("UPDATE work_card SET work_attempts = 2 WHERE id = ?1").bind(card.id).run();

    await handleRequest(
      new Request(`https://os.joinwestpeek.com/api/work-cards/${card.id}`, {
        method: "PATCH",
        headers: { ...SEQUOIA, "content-type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      }),
      env,
    );
    const row = await t.db
      .prepare("SELECT work_attempts FROM work_card WHERE id = ?1")
      .bind(card.id)
      .first<{ work_attempts: number }>();
    /*
     * A RENAME IS NOT A RE-QUEUE. Resetting on every update would make the ceiling unreachable —
     * any edit mid-run would hand the card three more goes — which is the opposite failure and a
     * worse one, because it is invisible.
     */
    expect(row!.work_attempts).toBe(2);
  });
});
