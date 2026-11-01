import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Meetings: the recording and approval rules the screen must keep.
 *
 * Cleanup 1 Nov 2026 ("tests prove behaviour, never wording"): the layout, heading-rank, copy and
 * ADR-text pins that used to live here were removed. What stays is behaviour a partner relies on —
 * consent is asked before anything is recorded, the microphone is held only while pressed, nothing
 * on the room can approve or move anything, the recorder starts only when the server will keep a
 * chunk, and the firm default activates only with an approved receipt.
 */

const MEETINGS = readFileSync(new URL("../src/client/pages/MeetingsPage.tsx", import.meta.url), "utf8");
const ROOM = readFileSync(new URL("../src/client/pages/RoomPanel.tsx", import.meta.url), "utf8");
const MEET = readFileSync(new URL("../src/client/pages/MeetBand.tsx", import.meta.url), "utf8");

/** Source with block and line comments removed: the file is allowed to SAY why something went. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("consent is asked for before anything is recorded, every time", () => {
  it("the During face is the room, and the recorder is one switch on one line", () => {
    expect(MEETINGS).toContain("<RoomPanel");
    expect(MEETINGS).not.toContain("function CapturePanel");
    expect(ROOM).toContain("function RecordingLine");
    expect(ROOM).toContain('className="rec-line"');
    expect(ROOM).toContain('role="switch"');
    expect(ROOM).toContain("aria-checked={recording}");
    expect(ROOM).toContain('className="live-dot"');
  });

  it("carries the words to say out loud, not just a checkbox", () => {
    expect(ROOM).toContain('data-testid="consent-script"');
    expect(ROOM).toContain('className="consent-script"');
  });

  it("names both answers, so a refusal is recordable rather than a thing you skip", () => {
    expect(ROOM).toContain('data-testid="consent-yes"');
    expect(ROOM).toContain('data-testid="consent-no"');
  });

  it("the switch opens the prompt when off and stops when on, and is never shown as already answered", () => {
    // ONE line, ONE switch (§3). Off, pressing it opens the prompt; the prompt is what collects
    // consent; on, pressing it stops. Nothing pre-ticks it from a previous session.
    expect(ROOM).toContain("onClick={recording ? stop : () => setPrompting(true)}");
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
    expect(ROOM).toContain('className="ptt"');
    expect(ROOM).toContain("aria-pressed={holding}");
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
    // The page's one primary is the stage move on After; the room carries none.
    expect(ROOM).not.toContain("btn-primary");
  });

});

describe("the capture switch is never live-looking and inert", () => {

  it("starts the recorder only when the SERVER says a chunk posted now would be written down", () => {
    // A yes with the policy gate still shut records the consent and starts nothing.
    expect(ROOM).toContain('if (answer === "GRANTED" && res.data?.can_capture) void start();');
    expect(ROOM).toMatch(/but nothing is recording/);
  });

});

describe("the firm default has a door on the page, and the reserved act stays the receipt's", () => {
  it("raises the card through the approvals path, activates only with the approved receipt, and turns off without one", () => {
    const c = code(MEET);
    expect(c).toContain('role="switch"');
    expect(c).toContain("aria-checked={on}");
    expect(c).toContain('"/api/approvals"');
    expect(c).toContain('action_key: FIRM_DEFAULT_ACTION');
    expect(c).toContain('export const FIRM_DEFAULT_ACTION = "meet.recording_policy.firm_default"');
    expect(c).toContain('object_type: "meet_recording_policy"');
    expect(c).toContain("object_id: s.recording_policy.firm_scope");
    expect(c).toContain("submit: true");
    expect(c).toContain('body: { action: "activate", approval_receipt_id: approved');
    expect(c).toContain('body: { action: "deactivate"');
    // Nothing here writes the policy row itself, and the switch never activates without a receipt.
    expect(c).not.toMatch(/approval_receipt_id: (undefined|null|"")/);
    expect(c).toContain("const act = on ? deactivate : approved ? activate : raise;");
    // Waiting on a partner: the switch is disabled with the reason in words, and the way to Approvals is beside it.
    expect(c).toContain("(!on && pending !== null)");
    expect(c).toContain('onNavigate("approvals")');
    expect(c).toContain('data-testid="meet-default-error"');
  });

  it("reads where the card stands from the status route, which names both the pending and the approved card", () => {
    const status = readFileSync(new URL("../src/worker/services/meetIngest.ts", import.meta.url), "utf8");
    const fn = status.slice(status.indexOf("export async function handleMeetStatus("), status.indexOf("export async function handleMeetInbox("));
    expect(fn).toContain("action_key = 'meet.recording_policy.firm_default'");
    expect(fn).toContain("object_type = 'meet_recording_policy'");
    expect(fn).toContain("approved_card_id");
    expect(fn).toContain("pending_card_id");
    // An executed card has been consumed; it is not offered as a receipt again.
    expect(fn).not.toMatch(/'executed'/);
  });
});
