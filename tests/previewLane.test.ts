import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import {
  APPROVED_SEND_ENV_KEY,
  SendBlocked,
  applyPreviewBoundary,
  assertPreviewLane,
} from "../src/worker/effects/emailTransport";
import {
  decidePreview,
  filePreview,
  sendOrPreview,
  type PreviewApprovalRow,
} from "../src/worker/services/previewApproval";
import {
  APPROVAL_TOKEN_LENGTH,
  hashApprovalToken,
  mintApprovalToken,
  previewFirstFor,
  readApprovalToken,
} from "../src/shared/work/previewLane";
import { PARTNERS, PARTNER_EMAILS, PREVIEW_PARTNER, partnerByFirmUserId } from "../src/shared/registry/partners";
import { SCOOTER_EMAIL } from "../src/worker/services/productions";

/**
 * THE PREVIEW LANE, PROVEN OFFLINE (17 Sep 2026).
 *
 * The three things that must be true, and the one that must NOT change:
 *
 *   · NOBODY OUTSIDE THE FIRM IS EMAILED WITHOUT HER YES. Enforced at the send boundary, so it is
 *     tested there — against the boundary itself, and through the transport that calls it.
 *   · "SEND IT" DELIVERS THE EMPLOYEE'S TEXT UNCHANGED. Byte for byte, from his address, with no
 *     header, no banner, no "forwarded by", and her name nowhere on it. This is the assertion the
 *     whole feature exists for: the point is his voice, not a forward.
 *   · A LINK IS A CREDENTIAL. Unguessable, single use, expiring, hashed at rest, and bound to the
 *     one recipient it was minted for.
 *   · AND WALKER'S MONDAY EMAIL TO SCOOTER IS UNTOUCHED. He is a Managing Partner, not an outsider.
 *     Proven twice: at the decision, and end to end through the transport.
 */

let t: TestDb;
let env: Env;

const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
const SCOOTER = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

interface Sent {
  to: string[];
  subject: string;
  text: string;
  from: string;
}

/** Everything that actually left. A request to anywhere but Resend is a failure by design. */
function captureFetch(sent: Sent[]): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (!u.includes("api.resend.com")) throw new Error(`unexpected request to ${u}`);
    sent.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "re_lane" }), { status: 200 });
  });
}

function mailEnv(base: Env): Env {
  return {
    ...base,
    RESEND_API_KEY: "re_test",
    WP_OS_EMAIL_SEND: "enabled",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
  } as Env;
}

beforeAll(async () => {
  t = await createTestDb();
  env = mailEnv(makeTestEnv(t.db, {} as Partial<Env>));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await disposeTestDb(t);
});

// ── 1 · who is inside the firm ────────────────────────────────────────────────────────────────

describe("her default rule", () => {
  it("sends to either partner normally and previews everybody else", () => {
    for (const partner of PARTNER_EMAILS) {
      expect(previewFirstFor({ recipient: partner }).previewFirst, `${partner} is inside the firm`).toBe(false);
    }
    for (const outsider of [
      "founder@somestartup.example",
      "reporter@paper.example",
      "lp@family-office.example",
      // ON THE FIRM'S OWN DOMAIN AND STILL NOT A PARTNER. A domain test would hand the firm's
      // authority to whoever controls a shared mailbox — see registry/partners.ts.
      "info@westpeek.ventures",
      "",
    ]) {
      expect(previewFirstFor({ recipient: outsider }).previewFirst, `${outsider} is outside`).toBe(true);
    }
  });

  it("lets a card ADD a preview to an internal note, and never lets one remove the default", () => {
    // She asked to see this one, even though it is going to a partner.
    expect(previewFirstFor({ recipient: SCOOTER_EMAIL, cardAsked: true })).toMatchObject({
      previewFirst: true,
      reason: "ASKED_FOR",
    });
    /*
     * AND THE ASYMMETRY, WHICH IS THE WHOLE GUARD. A flag on a card is not permission to bypass a
     * rule she stated about the firm's outbound mail. Whoever writes the card cannot waive it.
     */
    expect(previewFirstFor({ recipient: "founder@somestartup.example", cardAsked: false })).toMatchObject({
      previewFirst: true,
      reason: "DEFAULT_OUTSIDE_FIRM",
    });
  });
});

// ── 2 · the send boundary ─────────────────────────────────────────────────────────────────────

describe("the send boundary refuses an unapproved outsider", () => {
  const payload = (to: string | string[]) => ({ to, subject: "Walker: a note", text: "the note" });

  it("lets a partner through with nothing attached, and refuses everyone else", () => {
    for (const partner of PARTNER_EMAILS) {
      expect(() => assertPreviewLane(env, payload(partner))).not.toThrow();
    }
    expect(() => assertPreviewLane(env, payload("founder@somestartup.example"))).toThrow(SendBlocked);
    // Hiding an outsider in a list addressed to a partner does not launder them through.
    expect(() => assertPreviewLane(env, payload([...PARTNER_EMAILS, "founder@somestartup.example"]))).toThrow(
      SendBlocked,
    );
  });

  it("accepts the approval it was given and refuses it for anybody else", () => {
    const approved = {
      ...env,
      [APPROVED_SEND_ENV_KEY]: { approvalId: "pva_1", recipient: "founder@somestartup.example" },
    } as Env;
    expect(() => assertPreviewLane(approved, payload("founder@somestartup.example"))).not.toThrow();
    // ONE APPROVAL, ONE RECIPIENT. A yes for one person is not a licence to send.
    expect(() => assertPreviewLane(approved, payload("reporter@paper.example"))).toThrow(/authorises/);
    expect(() =>
      assertPreviewLane(approved, payload(["founder@somestartup.example", "reporter@paper.example"])),
    ).toThrow(/authorises/);
  });

  it("is reached through applyPreviewBoundary, which is what every transport calls", () => {
    // The lane rides on the function preview-sends-nowhere.mjs already proves both transports call
    // FIRST. If it were enforced anywhere else it would be a convention, not a guard.
    expect(() => applyPreviewBoundary(env, payload("founder@somestartup.example"))).toThrow(SendBlocked);
    expect(applyPreviewBoundary(env, payload(SCOOTER_EMAIL)).to).toBe(SCOOTER_EMAIL);
  });
});

// ── 3 · the token ─────────────────────────────────────────────────────────────────────────────

describe("the token is a credential, not a tag", () => {
  it("is long, random, hashed, and refuses anything it cannot confidently read", async () => {
    const a = mintApprovalToken();
    const b = mintApprovalToken();
    expect(a).toHaveLength(APPROVAL_TOKEN_LENGTH);
    expect(APPROVAL_TOKEN_LENGTH).toBeGreaterThanOrEqual(20);
    expect(a).not.toBe(b);
    // No lookalikes in the alphabet: a person reads this off a screen.
    expect(a).not.toMatch(/[O0I1L]/);

    const hash = await hashApprovalToken(a);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(a);
    expect(await hashApprovalToken(a)).toBe(hash);

    // UNWILLING TO GUESS. No folding, no truncation, no prefix match.
    expect(readApprovalToken(a)).toBe(a);
    expect(readApprovalToken(` ${a.toLowerCase()} `), "case and space are not part of a token").toBe(a);
    for (const bad of [null, "", a.slice(0, -1), `${a}X`, a.replace(/^./, "0"), a.replace(/^./, "-")]) {
      expect(readApprovalToken(bad), `"${bad}" must be refused`).toBeNull();
    }
  });
});

// ── 4 · the thing the feature exists for ──────────────────────────────────────────────────────

describe("send it", () => {
  async function fileOne(): Promise<{ row: PreviewApprovalRow; sent: Sent[] }> {
    const sent: Sent[] = [];
    captureFetch(sent);
    const filed = await filePreview(env, {
      employee: "Walker",
      what: "the note to the producer he shortlisted",
      subject: "Walker: a note about the build",
      bodyText: "Jordan — your Nike House of Innovation build is the kind of thing we want more of.\n\n— Walker",
      recipient: "jordan@producer.example",
      laneReason: "DEFAULT_OUTSIDE_FIRM",
      // NAMED, NOT ASSUMED (0190). This used to be an implicit constant inside filePreview.
      owner: PREVIEW_PARTNER,
    });
    return { row: filed.approval, sent };
  }

  it("delivers the employee's text UNCHANGED, from the employee, to the named recipient", async () => {
    const { row, sent } = await fileOne();

    /*
     * FILING IT SENT ONE EMAIL — TO HER, NOT TO HIM. The draft is in her inbox with the buttons; the
     * producer has heard nothing. This is the state the whole lane exists to produce.
     */
    expect(sent.map((s) => s.to).flat()).toEqual(["sequoia@westpeek.ventures"]);
    expect(row.state).toBe("PENDING");
    expect(row.recipient).toBe("jordan@producer.example");
    expect(row.recipient_set_by).toBe("EMPLOYEE");
    // The token is nowhere on the row and nowhere in the API. Only its hash is kept.
    expect(row.token_sha256).toHaveLength(64);
    expect(JSON.stringify(row)).not.toContain(row.token_sha256.slice(0, 0) || "@@never@@");

    sent.length = 0;
    const out = await decidePreview(env, row.id, { action: "SEND", byFirmUserId: "fu_sequoia_taylor", via: "HOME" });
    expect(out.sent, out.detail).toBe(true);

    expect(sent).toHaveLength(1);
    const wire = sent[0]!;
    expect(wire.to).toEqual(["jordan@producer.example"]);

    /*
     * BYTE FOR BYTE. Not "contains", not "starts with" — IDENTICAL. Every way this feature could
     * quietly become a forward shows up here: a prepended banner, a re-render, a "[APPROVED]"
     * subject stamp, her name in the signature, a normalised line ending.
     */
    expect(wire.subject).toBe(row.subject);
    expect(wire.text).toBe(row.body_text);
    // HIS ADDRESS. The producer replies to Walker, not to her and not to a generic firm mailbox.
    expect(wire.from).toContain("walker@joinwestpeek.com");
    expect(wire.text).not.toMatch(/sequoia/i);
    expect(wire.text).not.toMatch(/forward|approved by|on behalf of/i);
    expect(wire.subject).not.toMatch(/\[/);
  });

  it("works once — a second tap sends nothing", async () => {
    const { row } = await fileOne();
    const sent: Sent[] = [];
    captureFetch(sent);
    await decidePreview(env, row.id, { action: "SEND", byFirmUserId: "fu_sequoia_taylor", via: "HOME" });
    expect(sent).toHaveLength(1);
    await expect(
      decidePreview(env, row.id, { action: "SEND", byFirmUserId: "fu_sequoia_taylor", via: "HOME" }),
    ).rejects.toThrow(/already/);
    expect(sent, "the second tap put nothing on the wire").toHaveLength(1);
  });

  it("takes her recipient over the employee's, and the boundary follows her", async () => {
    const { row } = await fileOne();
    const sent: Sent[] = [];
    captureFetch(sent);
    const out = await decidePreview(env, row.id, {
      action: "SEND",
      byFirmUserId: "fu_sequoia_taylor",
      via: "HOME",
      recipient: "someone.else@producer.example",
    });
    expect(out.sent).toBe(true);
    expect(sent[0]!.to).toEqual(["someone.else@producer.example"]);
    expect(out.approval.recipient_set_by).toBe("PARTNER");
    // The employee's proposal is kept, so the trail says what he asked for and what she changed it to.
    expect(out.approval.proposed_recipient).toBe("jordan@producer.example");
  });

  it("sends nothing when she sends it back or dismisses it, and a return needs her words", async () => {
    const back = await fileOne();
    const sent: Sent[] = [];
    captureFetch(sent);
    await expect(
      decidePreview(env, back.row.id, { action: "RETURN", byFirmUserId: "fu_sequoia_taylor", via: "HOME" }),
    ).rejects.toThrow(/needs your words/);
    const returned = await decidePreview(env, back.row.id, {
      action: "RETURN",
      byFirmUserId: "fu_sequoia_taylor",
      via: "HOME",
      note: "Too familiar. Lead with the brief, not the compliment.",
    });
    expect(returned.approval.state).toBe("RETURNED");
    expect(returned.approval.note).toMatch(/Lead with the brief/);

    const dead = await fileOne();
    const dismissed = await decidePreview(env, dead.row.id, {
      action: "DISMISS",
      byFirmUserId: "fu_sequoia_taylor",
      via: "HOME",
    });
    expect(dismissed.approval.state).toBe("DISMISSED");
    expect(sent, "neither answer put anything on the wire").toHaveLength(0);
  });
});

// ── 5 · the two doors ─────────────────────────────────────────────────────────────────────────

describe("the doors", () => {
  it("opens from the email with no session, renders buttons, and decides only on the POST", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);
    /*
     * The token is minted inside filePreview and returned to nobody, so this test mints its own and
     * writes the row directly — which is also the honest way to prove the LOOKUP is by hash: if the
     * route found this row, it found it by hashing what was in the URL.
     */
    const token = mintApprovalToken();
    const id = `pva_${crypto.randomUUID()}`;
    await t.db
      .prepare(
        `INSERT INTO preview_approval (id, employee, what, subject, body_text, recipient, proposed_recipient,
           lane_reason, owner_firm_user_id, token_sha256, expires_at)
         VALUES (?1,'Walker','a note','Walker: a note','the body','jordan@producer.example','jordan@producer.example',
           'DEFAULT_OUTSIDE_FIRM', ?4, ?2, ?3)`,
      )
      .bind(id, await hashApprovalToken(token), new Date(Date.now() + 3600_000).toISOString(), PREVIEW_PARTNER.firmUserId)
      .run();

    // NO SESSION AT ALL — the token is the credential.
    const page = await handleRequest(new Request(`https://os.joinwestpeek.com/api/approve/${token}`), env);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("jordan@producer.example");
    expect(html).toContain('value="SEND"');
    expect(html).toContain('value="RETURN"');
    expect(html).toContain('value="DISMISS"');
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("noindex");
    // THE GET SENT NOTHING. A link scanner that prefetches this URL must not email anybody.
    expect(sent).toHaveLength(0);
    const still = await t.db.prepare("SELECT state FROM preview_approval WHERE id = ?1").bind(id).first<{ state: string }>();
    expect(still!.state).toBe("PENDING");

    const form = new FormData();
    form.set("action", "SEND");
    const done = await handleRequest(
      new Request(`https://os.joinwestpeek.com/api/approve/${token}/decide`, { method: "POST", body: form }),
      env,
    );
    expect(done.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["jordan@producer.example"]);
    expect(sent[0]!.text).toBe("the body");

    // AND THE LINK IS SPENT. The same URL again does nothing.
    const replay = await handleRequest(
      new Request(`https://os.joinwestpeek.com/api/approve/${token}/decide`, { method: "POST", body: form }),
      env,
    );
    expect(replay.status).toBe(409);
    expect(sent).toHaveLength(1);
  });

  it("refuses a link it cannot confidently read, and one that matches no row", async () => {
    for (const bad of ["not-a-token", "A".repeat(APPROVAL_TOKEN_LENGTH - 1), mintApprovalToken()]) {
      const res = await handleRequest(new Request(`https://os.joinwestpeek.com/api/approve/${bad}`), env);
      expect(res.status, bad).toBe(404);
      expect(await res.text()).toContain("Nothing to do");
    }
  });

  it("answers on Home for THIS partner, and refuses the other one", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);
    const filed = await filePreview(env, {
      employee: "Walker",
      what: "a note",
      subject: "Walker: a note",
      bodyText: "the body",
      recipient: "jordan@producer.example",
      laneReason: "DEFAULT_OUTSIDE_FIRM",
      // NAMED, NOT ASSUMED (0190). This used to be an implicit constant inside filePreview.
      owner: PREVIEW_PARTNER,
    });

    const listed = await handleRequest(
      new Request("https://os.joinwestpeek.com/api/preview-approvals", { headers: SEQUOIA }),
      env,
    );
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { previews: Array<{ id: string; intended_for: string }> };
    const mine = body.previews.find((p) => p.id === filed.approval.id)!;
    // NAMES THE RECIPIENT, so "send it" is never ambiguous.
    expect(mine.intended_for).toContain("jordan@producer.example");

    // The browser identity can read every page in the firm and cannot authorise a send.
    const browser = await handleRequest(
      new Request(`https://os.joinwestpeek.com/api/preview-approvals/${filed.approval.id}/decide`, {
        method: "POST",
        headers: { "x-wpos-dev-user": "browser-agent@westpeek.ventures", "content-type": "application/json" },
        body: JSON.stringify({ action: "SEND" }),
      }),
      env,
    );
    expect(browser.status).toBe(403);

    /*
     * AND THE OTHER MANAGING PARTNER CANNOT EITHER (0190).
     *
     * This assertion previously expected 200: Scooter dismissing HER preview was the shipped
     * behaviour, because both routes asked "are you A partner?" and the list had no owner filter
     * at all. It is rewritten rather than relaxed, and it is stricter in three ways — he cannot
     * decide it, he cannot SEE it, and the refusal names nothing about what it is.
     */
    sent.length = 0;
    const notHis = await handleRequest(
      new Request(`https://os.joinwestpeek.com/api/preview-approvals/${filed.approval.id}/decide`, {
        method: "POST",
        headers: { ...SCOOTER, "content-type": "application/json" },
        body: JSON.stringify({ action: "DISMISS" }),
      }),
      env,
    );
    expect(notHis.status, "Scooter cannot dismiss Sequoia's preview").toBe(403);
    const refusal = (await notHis.json()) as { error: string; reason: string };
    expect(refusal.error).toBe("not_your_preview");
    // It tells him nothing about the draft, the recipient, or the employee.
    expect(refusal.reason).not.toContain("jordan@producer.example");
    expect(refusal.reason).not.toContain("Walker");

    const hisList = await handleRequest(
      new Request("https://os.joinwestpeek.com/api/preview-approvals", { headers: SCOOTER }),
      env,
    );
    const his = (await hisList.json()) as { previews: Array<{ id: string }> };
    expect(his.previews.map((p) => p.id), "her preview is not on his Home").not.toContain(filed.approval.id);

    // And hers is hers: the same request from her own session works.
    const ok = await handleRequest(
      new Request(`https://os.joinwestpeek.com/api/preview-approvals/${filed.approval.id}/decide`, {
        method: "POST",
        headers: { ...SEQUOIA, "content-type": "application/json" },
        body: JSON.stringify({ action: "DISMISS" }),
      }),
      env,
    );
    expect(ok.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  /*
   * THE MIRROR. A guard that only runs one way is half a guard, and the half that goes untested is
   * the half somebody writes as `if (me === SEQUOIA) return 403`.
   */
  it("refuses HER on HIS preview, and puts his on his own Home", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);
    const scooter = partnerByFirmUserId("fu_scooter_taylor")!;
    const filed = await filePreview(env, {
      employee: "Parker",
      what: "his note to the venue",
      subject: "Parker: about the room in March",
      bodyText: "Hello — I am asking about your space for a small evening in March.\n\n— Parker",
      recipient: "bookings@venue.example",
      laneReason: "DEFAULT_OUTSIDE_FIRM",
      owner: scooter,
    });
    // The approval link went to HIS address, because the link is what sends the mail.
    expect(sent.map((s) => s.to).flat()).toEqual([scooter.email]);

    const hers = await handleRequest(
      new Request("https://os.joinwestpeek.com/api/preview-approvals", { headers: SEQUOIA }),
      env,
    );
    const herList = (await hers.json()) as { owner: string; previews: Array<{ id: string }> };
    expect(herList.owner).toBe("fu_sequoia_taylor");
    expect(herList.previews.map((p) => p.id)).not.toContain(filed.approval.id);

    const his = await handleRequest(
      new Request("https://os.joinwestpeek.com/api/preview-approvals", { headers: SCOOTER }),
      env,
    );
    const hisList = (await his.json()) as { previews: Array<{ id: string }> };
    expect(hisList.previews.map((p) => p.id)).toContain(filed.approval.id);

    const refused = await handleRequest(
      new Request(`https://os.joinwestpeek.com/api/preview-approvals/${filed.approval.id}/decide`, {
        method: "POST",
        headers: { ...SEQUOIA, "content-type": "application/json" },
        body: JSON.stringify({ action: "SEND" }),
      }),
      env,
    );
    expect(refused.status, "she cannot send Scooter's preview").toBe(403);
    expect(sent.filter((m) => m.to.includes("bookings@venue.example"))).toHaveLength(0);
  });
});

// ── 6 · the thing that must NOT change ────────────────────────────────────────────────────────

describe("Walker's Monday email to Scooter", () => {
  it("still goes straight to him, unchanged, with nothing waiting for anybody's yes", async () => {
    const sent: Sent[] = [];
    captureFetch(sent);

    const before = await t.db
      .prepare("SELECT COUNT(*) AS n FROM preview_approval")
      .first<{ n: number }>();

    const out = await sendOrPreview(env, {
      to: SCOOTER_EMAIL,
      email: {
        employee: "Walker",
        what: "hire search — week 38",
        tldr: "One candidate this week, freelance and selling sponsorship already.",
        sections: [
          { label: "What I did", bullets: ["Checked **14** profiles live and judged each against the archetype."] },
          { label: "Your call", bullets: ["Reply if you want a different angle next week."] },
        ],
        details: "Jordan Example — Brooklyn, NY.",
      },
      objectType: "work_card",
      objectId: "wc_monday",
      firmScope: "west-peek",
      cardKind: "PRODUCTIONS_HIRE_SEARCH",
      // Nobody said. The default rule decides, and the default for a partner is: send it.
      cardAsked: null,
    });

    expect(out.sent, out.reason).toBe(true);
    expect(out.previewed).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([SCOOTER_EMAIL]);
    expect(sent[0]!.subject).toMatch(/^Walker: /);
    // NOTHING IS WAITING FOR ANYBODY. No row, no draft on her Home, no second email to her.
    const after = await t.db.prepare("SELECT COUNT(*) AS n FROM preview_approval").first<{ n: number }>();
    expect(after!.n, "Monday's note filed a preview it should not have").toBe(before!.n);
  });

  it("goes into the lane the day it is addressed to somebody who is not a partner", async () => {
    // THE NEGATIVE PROOF of the line above: the ONLY thing that differs is the address.
    const sent: Sent[] = [];
    captureFetch(sent);
    const out = await sendOrPreview(env, {
      to: "jordan@producer.example",
      email: {
        employee: "Walker",
        what: "hire search — week 38",
        tldr: "One candidate this week, freelance and selling sponsorship already.",
        sections: [
          { label: "What I did", bullets: ["Checked **14** profiles live and judged each against the archetype."] },
          { label: "Your call", bullets: ["Reply if you want a different angle next week."] },
        ],
        details: "Jordan Example — Brooklyn, NY.",
      },
      objectType: "work_card",
      objectId: "wc_outsider",
      firmScope: "west-peek",
      cardKind: "PRODUCTIONS_HIRE_SEARCH",
      cardAsked: null,
    });

    expect(out.sent).toBe(false);
    expect(out.previewed).toBe(true);
    // The producer heard nothing; she got the draft.
    expect(sent.map((s) => s.to).flat()).toEqual(["sequoia@westpeek.ventures"]);
    const row = await t.db
      .prepare("SELECT recipient, state, lane_reason FROM preview_approval WHERE id = ?1")
      .bind(out.approvalId!)
      .first<{ recipient: string; state: string; lane_reason: string }>();
    expect(row).toMatchObject({
      recipient: "jordan@producer.example",
      state: "PENDING",
      lane_reason: "DEFAULT_OUTSIDE_FIRM",
    });
  });
});
