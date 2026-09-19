import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The shape of Meetings.
 *
 * Operator, 22 Aug 2026: "the meeting tab is not good enough it is not self explanatory from
 * looking at the page what im able to do… this page would probably be the longest and needs to be
 * clean and clear like the LP page."
 *
 * Every property below is one that was actually wrong, written in the manner of
 * tests/roomsLayout.test.ts: structural checks on the source, cheap, and failing for the right
 * reason. Two of them protect things with no other test behind them — that the page is ONE page
 * rather than two stacked on each other, and that a capture control is never rendered as live when
 * the server has said it cannot record.
 */

const MEETINGS = readFileSync(new URL("../src/client/pages/MeetingsPage.tsx", import.meta.url), "utf8");
const APP = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
const CLOSEOUT = readFileSync(new URL("../src/client/pages/CloseoutPanel.tsx", import.meta.url), "utf8");
// Phase C: the consent prompt and the recorder live on the During face now. Same rules, one file over.
const ROOM = readFileSync(new URL("../src/client/pages/RoomPanel.tsx", import.meta.url), "utf8");
const ADRS = readFileSync(new URL("../ARCHITECTURAL_DECISIONS.md", import.meta.url), "utf8");

/** Heading ranks in the order the file writes them. */
function ranks(src: string): number[] {
  return [...src.matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
}

/** The text of each h3, in order. */
function sections(src: string): string[] {
  return [...src.matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]!.trim());
}

describe("Meetings keeps the ranks the shell expects", () => {
  it("uses only h3 for a section and h4 for a thing inside one", () => {
    // The shell renders the page title as an h2. A section is therefore an h3 and a thing inside a
    // section is an h4; nothing goes deeper, because there is nothing deeper to navigate to.
    for (const [name, src] of [["MeetingsPage", MEETINGS], ["CloseoutPanel", CLOSEOUT]] as const) {
      expect(ranks(src).filter((r) => r < 3 || r > 4), `${name} uses a rank outside h3/h4`).toEqual([]);
    }
  });

  it("never prints an h5 anywhere on this surface", () => {
    expect(MEETINGS).not.toContain("<h5");
    expect(CLOSEOUT).not.toContain("<h5");
  });

  it("does not restate the page title the shell already printed", () => {
    expect(sections(MEETINGS)).not.toContain("Meetings");
  });
});

describe("Meetings reads the order a partner asks in", () => {
  it("is four sections, flat, in the decided order", () => {
    expect(sections(MEETINGS)).toEqual([
      "What is coming up",
      "What happened, and what came out of it",
      "Start a meeting now",
      "Where a deal stands with the committee",
    ]);
  });

  it("carries no static explainer of how a meeting becomes work — the record shows it instead (Phase B)", () => {
    // The chain used to be described in the abstract at the foot of the page. Every record now
    // renders its three faces, so the prose would describe what the page already shows. Read off
    // the code, not the comments: the file is allowed to SAY why the heading went.
    const code = MEETINGS.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toContain("<h3>How a meeting becomes work</h3>");
    expect(code).not.toContain('data-testid="meeting-chain"');
    // …and the committee's own sequence stayed, inside the committee section, not moved anywhere.
    const committee = MEETINGS.indexOf("Where a deal stands with the committee");
    const flow = MEETINGS.indexOf('data-testid="ic-flow"');
    expect(committee).toBeGreaterThan(0);
    expect(flow).toBeGreaterThan(committee);
    expect(MEETINGS.slice(committee, flow)).not.toMatch(/<h3>/);
  });

  it("renders the three faces on the record: the brief before, capture during, and what came out after", () => {
    expect(MEETINGS).toContain("<BeforePanel");
    expect(MEETINGS).toContain("<AfterPanel");
    const record = MEETINGS.slice(MEETINGS.indexOf("function MeetingRecord("));
    // Before comes before the notes; After comes after close-out — the order a meeting happens in.
    expect(record.indexOf("<BeforePanel")).toBeLessThan(record.indexOf('data-testid="note-form"'));
    expect(record.indexOf("<AfterPanel")).toBeGreaterThan(record.indexOf("<CloseoutPanel"));
  });

  it("says on every list row what the meeting is walking into, or what it produced — from server counts", () => {
    expect(MEETINGS).toContain("readinessInWords(m)");
    expect(MEETINGS).toContain("outputsInWords(m)");
    for (const field of ["brief_ready", "carried_open_questions", "we_owe_them", "decision_count", "commitment_overdue_count"]) {
      expect(MEETINGS, `${field} is not read off the row`).toContain(`m.${field}`);
    }
  });

  it("seats any employee on any type and WARNS about an internal-only seat in an external room", () => {
    // The owner's rule, 18 Sep 2026: "all AI employees can be added to any meeting."
    expect(MEETINGS).toContain("s.warning");
    expect(MEETINGS).toContain("seat-warning-");
    expect(MEETINGS).not.toContain("Internal-only employees are not offered");
  });

  it("gives every section an empty state, so nothing-yet never reads as broken", () => {
    // "Nothing has reached this stage" and "this is broken" look identical unless the page says
    // which one it is. Each of the four content sections carries its own named empty state.
    for (const hook of ["no-upcoming", "no-meetings", "no-live-meeting", "no-ic-deals"]) {
      expect(MEETINGS, `${hook} is missing`).toContain(`data-testid="${hook}"`);
    }
  });

  it("draws no rule of its own between sections", () => {
    // The stylesheet draws it from the h3. A hand-placed <hr> would be a second line.
    expect(MEETINGS).not.toContain("<hr");
  });
});

describe("Meetings is one page, not two stacked on each other", () => {
  /*
   * THE DEFECT THIS EXISTS TO PREVENT COMING BACK. App.tsx used to define a SECOND Meetings page
   * and mount it directly under the first. Both rendered `meeting-list` and both rendered
   * `meeting-${id}`, so every selector on this surface was ambiguous and opening a meeting in one
   * had no effect on the other. That is most of what "not self explanatory" meant.
   */
  it("leaves no second meetings list in the shell", () => {
    expect(APP).not.toContain('data-testid="meeting-list"');
    expect(APP).not.toContain('data-testid="meeting-detail"');
    expect(APP).not.toMatch(/function MeetingsPage\b/);
    expect(APP).not.toMatch(/function MeetingDetail\b/);
  });

  it("mounts the surface exactly once", () => {
    expect((APP.match(/<MeetingsSurface\b/g) ?? []).length).toBe(1);
  });

  it("keeps the record, the seating and the close-out inside the page that owns them", () => {
    expect(MEETINGS).toContain("<CloseoutPanel");
    expect(MEETINGS).toContain("<LiveHelpPanel");
    expect(MEETINGS).toContain('data-testid="meeting-detail"');
  });
});

describe("consent is asked for before anything is recorded, every time", () => {
  it("the During face is mounted in the live card, and the recorder lives on it", () => {
    expect(MEETINGS).toContain("<RoomPanel meetingId={liveMeeting.id} />");
    expect(MEETINGS).not.toContain("function CapturePanel");
    expect(ROOM).toContain("function RecordingLine");
  });

  it("carries the words to say out loud, not just a checkbox", () => {
    expect(ROOM).toContain('data-testid="consent-script"');
    expect(ROOM).toContain('className="consent-script"');
  });

  it("names both answers, so a refusal is recordable rather than a thing you skip", () => {
    expect(ROOM).toContain('data-testid="consent-yes"');
    expect(ROOM).toContain('data-testid="consent-no"');
  });

  it("the prompt opens from the one button, and is never shown as already answered", () => {
    // ONE line, ONE button (owner, 18 Sep 2026). Pressing Start opens the prompt; the prompt is
    // what collects consent; nothing pre-ticks it from a previous session.
    expect(ROOM).toContain("onClick={() => setPrompting(true)}");
    expect(ROOM).toContain("{prompting && (");
    expect(ROOM).not.toMatch(/localStorage|sessionStorage/);
  });

  it("re-arms the prompt when recording stops, so starting again asks again", () => {
    const stop = ROOM.slice(ROOM.indexOf("function stop()"));
    expect(stop.slice(0, 400)).toContain("setAsked(false)");
    expect(ROOM).toContain('data-testid="capture-reask"');
  });
});

describe("the room hears only while the button is held, and nothing here writes a record", () => {
  it("push-to-talk starts on press and releases the microphone on release; there is no wake phrase", () => {
    expect(ROOM).toContain('data-testid="room-ptt"');
    expect(ROOM).toContain("onPointerDown");
    expect(ROOM).toContain("onPointerUp={holdEnd}");
    expect(ROOM).toContain("cur.stream.getTracks().forEach((t) => t.stop())");
    expect(ROOM).not.toMatch(/wake\s*word|SpeechRecognition|webkitSpeechRecognition/);
  });

  it("has no control that could approve, decide, or move anything", () => {
    for (const path of ["/approve", "/decisions", "/open-questions", "/stage-proposals", "/transition", "/commitments"]) {
      expect(ROOM, `${path} must not be reachable from the During face`).not.toContain(path);
    }
    expect(ROOM).toContain("/room/ask");
    expect(ROOM).toContain("/room/roll");
    expect(ROOM).toMatch(/a partner approves this on the record/);
  });

  it("renders standalone behind the same gate, for a Meet Add-on side panel later", () => {
    expect(APP).toContain("export function RoomStandalone");
    expect(APP).toMatch(/#\\\/room\\\//);
    expect(APP).toContain("<RoomPanel meetingId={meetingId} standalone />");
    expect(APP).toContain('useApi<MeResponse>("/api/me")');
  });
});

describe("a transcript somebody else recorded is offered, and marked as theirs", () => {
  it("takes a Fireflies export by paste or by file", () => {
    expect(MEETINGS).toContain('data-testid="fireflies-text"');
    expect(MEETINGS).toContain('data-testid="fireflies-file"');
    expect(MEETINGS).toContain('data-testid="fireflies-submit"');
  });

  it("says on the record that the firm did not make that recording", () => {
    // Importing is not the same as having asked. The page has to say so where the import is shown.
    expect(MEETINGS).toMatch(/We did not make this recording/);
  });

  it("names the source in words rather than printing the stored value", () => {
    expect(MEETINGS).toContain("sourceInWords");
    expect(MEETINGS).toContain("Fireflies export");
  });
});

describe("the capture button is never live-looking and inert", () => {
  it("opens only when the two things the prompt cannot supply are true, and never while recording", () => {
    /*
     * The Start button no longer waits on `can_capture` — consent is what the prompt behind it
     * collects, so a button gated on consent could never be pressed to ask for it. It waits on
     * the two gates the prompt cannot open: a transcription service and the Managing Partner's
     * recording policy. And it is never offered while the recorder is already running.
     */
    const disabled = /disabled=\{([^}]*)\}/g;
    const guards = [...ROOM.matchAll(disabled)].map((m) => m[1]!);
    const startGuard = guards.find((g) => g.includes("transcription_available"));
    expect(startGuard, "the Start button must consult the server's transcription_available").toBeTruthy();
    expect(startGuard).toContain("recording_policy_active");
    expect(startGuard).toContain("recording");
    expect(startGuard).toContain("prompting");
  });

  it("starts the recorder only when the SERVER says a chunk posted now would be written down", () => {
    // A yes with the policy gate still shut records the consent and starts nothing.
    expect(ROOM).toContain('if (answer === "GRANTED" && res.data?.can_capture) void start();');
    expect(ROOM).toMatch(/but nothing is recording/);
  });

  it("prints the reason it cannot record rather than only greying out", () => {
    expect(ROOM).toContain('data-testid="capture-blockers"');
    expect(ROOM).toContain('data-testid="room-status"');
  });

  it("names a chunk that failed instead of leaving a hole in the transcript", () => {
    expect(ROOM).toMatch(/was not written down/);
  });

  it("sends the recorder's MIME type with every slice, so Nova-3 can read the container", () => {
    expect(ROOM).toContain("content_type: blob.type");
  });
});

describe("the committee section answers the four questions it was asked to", () => {
  it("shows packet state, the open questions, who owes each, the seats and the decision", () => {
    expect(MEETINGS).toContain('data-testid={`ic-packet-state-');
    expect(MEETINGS).toContain('data-testid={`ic-questions-');
    expect(MEETINGS).toContain("owedInWords");
    expect(MEETINGS).toContain('data-testid={`ic-seats-');
    expect(MEETINGS).toContain('data-testid={`ic-decision-');
  });

  it("carries the decision itself, because nothing else on the product does any more", () => {
    // The deal record hands the committee view to this page (IMPLEMENTATION_LEDGER.md), and
    // InvestmentPage — the only other route to submit and decide — is no longer rendered. A page
    // that shows a packet and offers no way to decide on it is a dead end.
    expect(MEETINGS).toContain('data-testid={`ic-submit-');
    expect(MEETINGS).toContain('data-testid={`ic-invest-');
    expect(MEETINGS).toContain('data-testid={`ic-pass-');
    expect(MEETINGS).toContain('data-testid={`ic-defer-');
  });

  it("will not let a pass be recorded without a sentence of reason", () => {
    expect(MEETINGS).toContain("disabled={rationale.trim().length < 12}");
  });

  it("prints no raw enum, column name or id at a partner", () => {
    // The stored values. A committee packet should never show somebody a column value.
    for (const raw of ["IC_READY", "IC_DECIDED", "DRAFT", "IN_REVIEW", "opportunity_id", "ic_packet"]) {
      expect(MEETINGS.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(
        new RegExp(`>\\s*\\{?["']?${raw}["']?\\}?\\s*<`),
      );
    }
  });
});

describe("ADR-019 says what was decided and what was deliberately not built", () => {
  it("exists and is written down", () => {
    expect(ADRS).toContain("### ADR-019");
  });

  it("states that a shared live room is designed and deferred, and why", () => {
    const adr = ADRS.slice(ADRS.indexOf("### ADR-019"));
    expect(adr).toMatch(/Durable Object/);
    expect(adr).toMatch(/NOT\s*\n?BUILT|not built/i);
    expect(adr).toMatch(/second failure surface/);
  });

  it("states that capture is a binding rather than a new vendor, and why a bot was refused", () => {
    const adr = ADRS.slice(ADRS.indexOf("### ADR-019"));
    expect(adr).toMatch(/Workers AI Whisper/);
    expect(adr).toMatch(/No new\s*\n?vendor|no new vendor/i);
    expect(adr).toMatch(/recording bot/i);
  });

  it("states that the Fireflies API route is designed and deferred, and why paste is enough", () => {
    const adr = ADRS.slice(ADRS.indexOf("### ADR-019"));
    expect(adr).toMatch(/Fireflies/);
    expect(adr).toMatch(/validate:network-boundary/);
    expect(adr).toMatch(/Importing is never consent/);
    expect(adr).toMatch(/never guesses who spoke/);
  });

  it("states that consent is prompted and logged every time, and names the two-party problem", () => {
    const adr = ADRS.slice(ADRS.indexOf("### ADR-019"));
    expect(adr).toMatch(/California/);
    expect(adr).toMatch(/every time/);
  });
});
