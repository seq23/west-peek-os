import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { PAGE_HOSTS, pageHost } from "@shared/help/pageHosts";
import { pageGuide } from "@shared/help/pageGuide";
import { renderIntentAnswer, type GuideIntent } from "@shared/help/pageGuide/render";
import { parseMarkdown, plainText } from "@shared/help/markdownLite";

/**
 * Item 14 — the panel that lets a partner ask whoever runs the page they are on.
 *
 * What this suite holds, in order of how badly each would hurt:
 *
 * 1. **A switched-off host does not answer.** The card already refuses to smile over a page nobody
 *    is working; a box that answers anyway would teach a partner that the status is decoration. The
 *    refusal must be a RECORDED TURN, not an error that vanishes — the partner asked, and that they
 *    asked and got nothing back is part of the conversation.
 * 2. **An unhosted page has no panel at all.** Admin deliberately has no host, and a chat box there
 *    would invent an owner for machinery nobody runs.
 * 3. **The thread is per partner.** Two partners typing into one page thread would be a room, which
 *    needs presence and ordering across clients. What Sequoia asks Preston is not in Scooter's panel.
 * 4. **A failed turn keeps its number.** Turn numbers count every turn including the failures, or
 *    the next reply collides with a failed one on the UNIQUE constraint and the thread jams.
 * 5. **"How does this page work" is answered from the page's guide, not the model.** Owner, 19 Sep
 *    2026, after Walter described the Meetings page as it was a week earlier, in one paragraph: the
 *    answer is now the guide verbatim — structured, current, no run behind it — and the retired
 *    trio can never come back through this door.
 * 6. **So are "walk me through it" and "explain the buttons".** Same day, after Walter walked her
 *    through a fake meeting from memory and "skipped over the screen I get to when I open the room
 *    and can seat AI employees": the walkthrough and the buttons-by-band are the guide's, served
 *    verbatim for EVERY hosted page, with no AI run behind them. `validate:page-guides` reads this
 *    file for that pin.
 */

let t: TestDb;
let env: Env;

const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };
const SCOOTER = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a partner can ask whoever runs the page", () => {
  it("refuses in the host's own name when the host is not employed, and keeps the refusal in the thread", async () => {
    /*
     * The host is stood down HERE rather than found that way. This used to lean on "no employee is
     * ACTIVE in a fresh database", which stopped being true when migration 0136 employed the whole
     * roster — and the case the rule is about (a partner asking a seat that is switched off) is
     * still perfectly reachable, it just has to be set up.
     *
     * The name comes from `pageHost`, not from a literal, so re-pointing the LP page at a different
     * seat moves this test with it instead of quietly making it test nothing.
     */
    const lpHost = pageHost("lp")!;
    await t.db.prepare("UPDATE ai_employee SET status = 'PAUSED' WHERE name = ?1").bind(lpHost.name).run();

    const asked = await call<{ ok: boolean; detail: string | null }>("/api/pages/lp/reply", SEQUOIA, "POST", {
      message: "What does a soft commitment mean here?",
    });
    expect(asked.status).toBe(200);
    expect(asked.body.ok).toBe(false);
    expect(asked.body.detail).toMatch(/employ|not set up/i);

    const thread = await call<{ host: { name: string }; turns: Array<{ role: string; state: string; body: string }> }>(
      "/api/pages/lp/thread",
      SEQUOIA,
    );
    expect(thread.status).toBe(200);
    // Both turns survive: what was asked, and why nothing came back.
    expect(thread.body.turns).toHaveLength(2);
    expect(thread.body.turns[0]!.role).toBe("PARTNER");
    expect(thread.body.turns[1]!.state).toBe("REFUSED");
    // Named, not anonymous. "The assistant is unavailable" tells a partner nothing they can act on.
    expect(thread.body.turns[1]!.body).toContain(thread.body.host.name);
  });

  it("has nothing to offer on a page nobody hosts", async () => {
    // Admin surfaces are machinery, not rooms somebody runs. `pageHost` returns null and so must this.
    const res = await call("/api/pages/diagnostics/thread", SEQUOIA);
    expect(res.status).toBe(404);
  });

  it("keeps one thread per partner, so a question is not overheard", async () => {
    await call("/api/pages/portfolio/reply", SEQUOIA, "POST", { message: "Which of these is worth a second cheque?" });

    const hers = await call<{ turns: unknown[] }>("/api/pages/portfolio/thread", SEQUOIA);
    const his = await call<{ turns: unknown[] }>("/api/pages/portfolio/thread", SCOOTER);
    expect(hers.body.turns.length).toBeGreaterThan(0);
    expect(his.body.turns).toHaveLength(0);
  });

  it("numbers turns past the failures, so a jammed thread cannot happen", async () => {
    // Two refused exchanges on one page: if numbering counted only OK turns, the second ask would
    // reuse turn 1 and violate UNIQUE (nav_key, firm_user_id, turn_no).
    await call("/api/pages/thesis/reply", SEQUOIA, "POST", { message: "What belongs in the mandate?" });
    const second = await call<{ ok: boolean }>("/api/pages/thesis/reply", SEQUOIA, "POST", {
      message: "And what should we refuse outright?",
    });
    expect(second.status).toBe(200);

    const thread = await call<{ turns: Array<{ turn_no: number }> }>("/api/pages/thesis/thread", SEQUOIA);
    expect(thread.body.turns.map((x) => x.turn_no)).toEqual([1, 2, 3, 4]);
  });

  it("will not accept an empty question or a pasted document", async () => {
    const empty = await call("/api/pages/lp/reply", SEQUOIA, "POST", { message: " " });
    expect(empty.status).toBe(400);

    const essay = await call<{ detail: string }>("/api/pages/lp/reply", SEQUOIA, "POST", { message: "x".repeat(1201) });
    expect(essay.status).toBe(400);
    expect(essay.body.detail).toMatch(/shorter/i);
  });
});

describe("how does this page work", () => {
  const RETIRED_MEETINGS_TRIO = ["Prepare for a meeting", "Confer with an AI employee", "Run a close-out"];

  it("Walter answers on Meetings with the page's guide — numbered bands, bulleted acts, no model run, no old trio", async () => {
    const meetingsHost = pageHost("meetings")!;
    await t.db.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE name = ?1").bind(meetingsHost.name).run();

    const asked = await call<{ ok: boolean; reply: string | null; source?: string }>("/api/pages/meetings/reply", SCOOTER, "POST", {
      message: "how does this page work now?",
    });
    expect(asked.status).toBe(200);
    expect(asked.body.ok).toBe(true);
    expect(asked.body.source).toBe("guide");

    const reply = asked.body.reply!;
    const guide = pageGuide("meetings")!;
    // Every act in the spec is in the answer, in bold, and the shape is lists rather than a paragraph.
    for (const a of guide.acts) expect(reply).toContain(`**${a.label}**`);
    const blocks = parseMarkdown(reply);
    expect(blocks.some((b) => b.kind === "ordered" && b.items.length === guide.bands.length)).toBe(true);
    expect(blocks.some((b) => b.kind === "bulleted" && b.items.length === guide.acts.length)).toBe(true);
    for (const phrase of RETIRED_MEETINGS_TRIO) expect(reply).not.toContain(phrase);
    for (const current of ["Open the room", "They said yes — record", "Ask", "Approve — make these the record", "Move it", "Google Meet"]) {
      expect(reply).toContain(current);
    }

    // Recorded as a HOST turn with no run behind it, and marked as the guide so the thread says so.
    const thread = await call<{ turns: Array<{ role: string; state: string; detail: string | null; body: string }> }>(
      "/api/pages/meetings/thread",
      SCOOTER,
    );
    const host = thread.body.turns.find((x) => x.role === "HOST")!;
    expect(host.state).toBe("OK");
    expect(host.detail).toBe("GUIDE");
    expect(host.body).toBe(reply);
    const row = await t.db.prepare("SELECT ai_run_id FROM page_turn WHERE nav_key = 'meetings' AND role = 'HOST'").first<{ ai_run_id: string | null }>();
    expect(row?.ai_run_id).toBeNull();
  });

  it("Walter walks her through a real meeting from the guide — Seat, Join on Meet and what it does not do, the transcript after the call, Draft, Approve, Move it", async () => {
    const asked = await call<{ ok: boolean; reply: string | null; source?: string; shape?: string }>("/api/pages/meetings/reply", SCOOTER, "POST", {
      message: "walk me through a real meeting",
    });
    expect(asked.status).toBe(200);
    expect(asked.body.source).toBe("guide");
    expect(asked.body.shape).toBe("walkthrough");
    const reply = asked.body.reply!;
    expect(reply).toBe(renderIntentAnswer(pageGuide("meetings")!, "walkthrough"));
    const blocks = parseMarkdown(reply);
    // Two scenarios, each a numbered list under its own heading; the second is the in-person one.
    expect(blocks.filter((b) => b.kind === "heading").length).toBe(2);
    expect(blocks.filter((b) => b.kind === "ordered").length).toBe(2);
    for (const control of ["**Go to this meeting**", "**Seat**", "**Join on Meet**", "**Use my laptop mic for this Meet call**", "**Done — open the record**", "**Draft what came out of it**", "**Approve — make these the record**", "**Move it**", "**They said yes — record**", "**Record meeting**"]) {
      expect(reply, control).toContain(control);
    }
    // What Join on Meet does NOT do is said, and the transcript's arrival after the call is said.
    expect(reply).toMatch(/What does not happen: Join on Meet alone puts no employee in the call/);
    expect(reply).toMatch(/the OS joins it from the Mac/);
    expect(reply).toMatch(/never for LP or Broker/);
    expect(reply).toMatch(/one room, several doors/);
    expect(reply).toMatch(/Within the hour Google's transcript/);
    expect(reply).toMatch(/laptop microphone/);
    for (const phrase of RETIRED_MEETINGS_TRIO) expect(reply).not.toContain(phrase);
    const row = await t.db.prepare("SELECT ai_run_id, detail FROM page_turn WHERE nav_key = 'meetings' AND role = 'HOST' ORDER BY turn_no DESC LIMIT 1").first<{ ai_run_id: string | null; detail: string | null }>();
    expect(row?.detail).toBe("WALKTHROUGH");
    expect(row?.ai_run_id).toBeNull();
  });

  it("explain what all of the buttons do — every act, grouped by face, from the guide", async () => {
    const asked = await call<{ ok: boolean; reply: string | null; shape?: string }>("/api/pages/meetings/reply", SCOOTER, "POST", {
      message: "explain what all of the buttons do",
    });
    expect(asked.body.shape).toBe("buttons");
    const reply = asked.body.reply!;
    expect(reply).toBe(renderIntentAnswer(pageGuide("meetings")!, "buttons"));
    const headings = parseMarkdown(reply).filter((b) => b.kind === "heading").map((b) => plainText([b]));
    for (const face of ["Before", "During", "After", "Coming up", "Google Meet"]) expect(headings, face).toContain(face);
    for (const a of pageGuide("meetings")!.acts) expect(reply).toContain(`**${a.label}**`);
    const row = await t.db.prepare("SELECT ai_run_id, detail FROM page_turn WHERE nav_key = 'meetings' AND role = 'HOST' ORDER BY turn_no DESC LIMIT 1").first<{ ai_run_id: string | null; detail: string | null }>();
    expect(row?.detail).toBe("BUTTONS");
    expect(row?.ai_run_id).toBeNull();
  });

  it("every hosted page answers all three shapes verbatim, with no AI run behind any of them", async () => {
    const asks: Record<GuideIntent, string> = { how: "how does this page work?", walkthrough: "walk me through it, step by step", buttons: "what does each button do?" };
    let pinned = 0;
    for (const navKey of Object.keys(PAGE_HOSTS)) {
      const guide = pageGuide(navKey);
      if (!guide) continue;
      const host = pageHost(navKey)!;
      await t.db.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE name = ?1").bind(host.name).run();
      for (const shape of ["how", "walkthrough", "buttons"] as const) {
        const asked = await call<{ ok: boolean; reply: string | null; source?: string; shape?: string }>(`/api/pages/${navKey}/reply`, SEQUOIA, "POST", { message: asks[shape] });
        expect(asked.status, `${navKey} ${shape}`).toBe(200);
        expect(asked.body.source, `${navKey} ${shape}`).toBe("guide");
        expect(asked.body.shape, `${navKey} ${shape}`).toBe(shape);
        expect(asked.body.reply, `${navKey} ${shape}`).toBe(renderIntentAnswer(guide, shape));
        const row = await t.db.prepare("SELECT ai_run_id FROM page_turn WHERE nav_key = ?1 AND firm_user_id = 'fu_sequoia_taylor' AND role = 'HOST' ORDER BY turn_no DESC LIMIT 1").bind(navKey).first<{ ai_run_id: string | null }>();
        expect(row?.ai_run_id, `${navKey} ${shape}`).toBeNull();
        pinned += 1;
      }
    }
    // Rule 0: a loop over no pages proves nothing.
    expect(pinned).toBeGreaterThanOrEqual(3 * 15);
  });

  it("a question about one control still goes to the host, with a run behind it", async () => {
    const asked = await call<{ ok: boolean; source?: string }>("/api/pages/meetings/reply", SCOOTER, "POST", {
      message: "what does Move it actually do to the deal?",
    });
    expect(asked.status).toBe(200);
    expect(asked.body.source).toBeUndefined();
    const rows = await t.db
      .prepare("SELECT ai_run_id, detail FROM page_turn WHERE nav_key = 'meetings' AND role = 'HOST' ORDER BY turn_no DESC LIMIT 1")
      .first<{ ai_run_id: string | null; detail: string | null }>();
    expect(rows?.detail).not.toBe("GUIDE");
    expect(rows?.ai_run_id).not.toBeNull();
  });
});
