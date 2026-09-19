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
 * reason. Phase D (design/DEALS_SECTION_DESIGN.md §3, 18 Sep 2026) re-pinned the page's shape:
 * one object, three faces, the committee gone to Dealflow, and the list sorted by the calendar.
 * Each pin that changed was rewritten stricter than the one it replaced, never looser.
 */

const MEETINGS = readFileSync(new URL("../src/client/pages/MeetingsPage.tsx", import.meta.url), "utf8");
const APP = readFileSync(new URL("../src/client/App.tsx", import.meta.url), "utf8");
const CLOSEOUT = readFileSync(new URL("../src/client/pages/CloseoutPanel.tsx", import.meta.url), "utf8");
// Phase C: the consent prompt and the recorder live on the During face. Same rules, one file over.
const ROOM = readFileSync(new URL("../src/client/pages/RoomPanel.tsx", import.meta.url), "utf8");
// Phase D: the Before and After faces, and the one seating card.
const FACES = readFileSync(new URL("../src/client/pages/MeetingFacesPanel.tsx", import.meta.url), "utf8");
const SEATING = readFileSync(new URL("../src/client/pages/LiveHelpPanel.tsx", import.meta.url), "utf8");
const MEET = readFileSync(new URL("../src/client/pages/MeetBand.tsx", import.meta.url), "utf8");
const ADRS = readFileSync(new URL("../ARCHITECTURAL_DECISIONS.md", import.meta.url), "utf8");

/** Source with block and line comments removed: the file is allowed to SAY why something went. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Heading ranks in the order the file writes them. */
function ranks(src: string): number[] {
  return [...code(src).matchAll(/<h([1-6])[ >]/g)].map((m) => Number(m[1]));
}

/** The text of each band head (h3 directly inside `.band-head`), in order. */
function bands(src: string): string[] {
  return [...code(src).matchAll(/className="band-head">\s*<h3>([^<]+)<\/h3>/g)].map((m) => m[1]!.trim());
}

describe("Meetings keeps the ranks the shared pattern expects", () => {
  it("emits an h2 only as a masthead answer, and never h1 or h5", () => {
    /*
     * The shell renders the page title as an h2; the pattern's masthead answer is a second h2
     * (the tag `.masthead h2` is written against, and Home's precedent). A band or a panel is an
     * h3, a thing inside one is an h4. Every h2 in these files must therefore sit inside a
     * `.masthead` — an h2 anywhere else is a rank the stylesheet does not reach.
     */
    for (const [name, src] of [["MeetingsPage", MEETINGS], ["MeetingFacesPanel", FACES], ["CloseoutPanel", CLOSEOUT], ["LiveHelpPanel", SEATING], ["RoomPanel", ROOM], ["MeetBand", MEET]] as const) {
      expect(ranks(src).filter((r) => r < 2 || r > 4), `${name} uses a rank outside h2–h4`).toEqual([]);
      const c = code(src);
      for (const m of c.matchAll(/<h2[ >]/g)) {
        const before = c.slice(Math.max(0, m.index! - 1200), m.index);
        expect(before, `${name}: an h2 that is not a masthead answer`).toMatch(/className="masthead"/);
      }
    }
  });

  it("does not restate the page title the shell already printed", () => {
    expect(bands(MEETINGS)).not.toContain("Meetings");
    expect(code(MEETINGS)).not.toMatch(/<h2[^>]*>Meetings<\/h2>/);
  });

  it("derives the answer line from the counts the rows carry, never from a second count", () => {
    const c = code(MEETINGS);
    const masthead = c.slice(c.indexOf("function mastheadFor("), c.indexOf("const FACES = ["));
    for (const field of ["stage_proposal_pending_count", "draft_waiting_count", "brief_ready"]) {
      expect(masthead, `the masthead does not read ${field}`).toContain(field);
    }
    expect(MEETINGS).toContain('data-testid="meetings-answer"');
    expect(MEETINGS).toContain('className="masthead-date"');
    expect(MEETINGS).toContain('className="masthead-second"');
  });
});

describe("Meetings reads the order a partner asks in", () => {
  it("is three bands, flat, in the decided order — and the committee is not one of them", () => {
    expect(bands(MEETINGS)).toEqual(["Coming up", "On the record", "Start a meeting now"]);
    // The fourth band is the Meet door, in its own file.
    expect(code(MEETINGS)).toContain("<MeetBand onNavigate={onNavigate} />");
    expect(bands(MEET)).toEqual(["Google Meet"]);
    expect(code(MEETINGS)).not.toContain("Where a deal stands with the committee");
  });

  it("sorts what is coming up by the calendar, soonest first, and what happened newest first", () => {
    // §1.1 #4: the list route orders by created_at; the page must not print that order.
    const c = code(MEETINGS);
    expect(c).toMatch(/status === "SCHEDULED"\)\.sort\(\(a, b\) => timeOf\(a\.scheduled_at, Infinity\) - timeOf\(b\.scheduled_at, Infinity\)\)/);
    expect(c).toMatch(/status !== "SCHEDULED"\)\.sort\(\(a, b\) => timeOf\(b\.occurred_at \?\? b\.scheduled_at, -Infinity\) - timeOf\(a\.occurred_at \?\? a\.scheduled_at, -Infinity\)\)/);
    // A row with no time goes LAST in both bands — the fallbacks are the ends of the number line.
    expect(c).toContain("function timeOf(value: string | null, fallback: number): number");
  });

  it("sends the reader to Dealflow for the committee, and carries none of it here", () => {
    // Phase D: one object per page. The committee's packets, questions, dissent and decision
    // buttons moved to Dealflow with their tests; this page keeps a pointer and nothing else.
    const c = code(MEETINGS);
    expect(c).toContain('data-testid="committee-pointer"');
    const pointer = c.slice(c.indexOf('data-testid="committee-pointer"'), c.indexOf('data-testid="committee-pointer"') + 600);
    expect(pointer).toContain('onNavigate("dealflow")');
    for (const gone of ["/api/ic/", "ic-deal-", "ic-submit-", "ic-invest-", "ic-pass-", "ic-defer-", "ic-dissent", "ic-flow", "IC_FLOW"]) {
      expect(c, `${gone} is still on Meetings`).not.toContain(gone);
    }
  });

  it("opens one record at a time, in place of the list, with a way back", () => {
    // The record is not a panel under three bands any more; it IS the page while it is open.
    const c = code(MEETINGS);
    expect(c).toMatch(/if \(open && openRow\) \{\s*return \(/);
    expect(c).toContain('data-testid="record-back"');
    // The name is a door, not a toggle: opening the record that is open keeps it open.
    expect(c).not.toMatch(/setOpen\(m\.id === open \? null : m\.id\)/);
  });

  it("renders the three faces on the record as a real tab strip, one face mounted at a time", () => {
    const c = code(MEETINGS);
    expect(c).toContain('className="faces" role="tablist"');
    expect(c).toContain('role="tab"');
    expect(c).toContain("aria-selected={face === f.key}");
    expect(c).toContain("tabIndex={face === f.key ? 0 : -1}");
    expect(c).toContain('e.key === "ArrowRight"');
    expect(c).toContain('e.key === "ArrowLeft"');
    expect(c).toContain('role="tabpanel"');
    expect(c).toContain('{face === "before" && (');
    expect(c).toContain('{face === "during" && (');
    expect(c).toContain('{face === "after" && (');
    expect(c).toContain("<BeforePanel");
    expect(c).toContain("<RoomPanel");
    expect(c).toContain("<AfterPanel");
  });

  it("puts the brief's one model-written line at rank 0 on Before, with who wrote it above it", () => {
    const f = code(FACES);
    const before = f.slice(f.indexOf("export function BeforePanel("), f.indexOf("interface AfterDraft"));
    expect(before).toContain('data-testid="brief-masthead"');
    expect(before).toMatch(/<h2 data-testid="brief-why">/);
    expect(before).toContain("b.why ??");
    expect(before).toContain("prepared by ${b.prepared_by}");
    // A line that could not be written is a NAMED absence at rank 0, never a blank.
    expect(before).toContain("No line could be written");
  });

  it("says on every list row what the meeting is walking into, or what it produced — from server counts", () => {
    expect(MEETINGS).toContain("readinessInWords(m)");
    expect(MEETINGS).toContain("outputsInWords(m)");
    for (const field of ["brief_ready", "carried_open_questions", "we_owe_them", "they_owe_us", "decision_count", "commitment_overdue_count", "open_question_count", "stage_proposal_pending_count", "draft_waiting_count"]) {
      expect(MEETINGS, `${field} is not read off the row`).toContain(`m.${field}`);
    }
    // The line is `.readiness` with a dot between parts, and a stage move waiting is the one orange.
    expect(MEETINGS).toContain('className="readiness"');
    expect(MEETINGS).toContain('className="dot"');
    expect(MEETINGS).toMatch(/stage move.*waiting on you`, tone: "pill"/);
  });

  it("keeps the flag on a calendar meeting whose type was guessed", () => {
    expect(MEETINGS).toContain('m.type_inference === "UNKNOWN_CHECK_IT"');
    expect(MEETINGS).toContain("type inferred, check it");
  });

  it("gives every band and every face an empty state, so nothing-yet never reads as broken", () => {
    for (const [name, src, hooks] of [
      ["MeetingsPage", MEETINGS, ["no-upcoming", "no-meetings", "no-archived-meetings", "no-notes", "no-transcripts"]],
      ["MeetingFacesPanel", FACES, ["brief-none", "no-decisions", "no-open-questions", "no-after-commitments", "no-stage-proposals", "no-artifacts", "no-draft"]],
      ["RoomPanel", ROOM, ["room-summary-empty", "room-artifacts-empty", "room-seated-nobody"]],
      ["LiveHelpPanel", SEATING, ["seating-nobody-employed", "live-help-nobody"]],
    ] as const) {
      for (const hook of hooks) expect(src, `${name}: ${hook} is missing`).toContain(`data-testid="${hook}"`);
    }
  });

  it("draws no rule of its own between sections", () => {
    // The stylesheet draws it from the band head. A hand-placed <hr> would be a second line.
    for (const src of [MEETINGS, FACES, ROOM, SEATING, CLOSEOUT]) expect(src).not.toContain("<hr");
  });
});

describe("Live Help and Close-out are faces of the meeting, not panels under it", () => {
  it("mounts ONE seating card, on Before and During, and no second list of the same seats", () => {
    const c = code(MEETINGS);
    expect((c.match(/<LiveHelpPanel\b/g) ?? []).length).toBe(1);
    expect(c).toMatch(/const seating = <LiveHelpPanel/);
    expect(c).toContain("seating={seating}");
    // The During aside carries it too.
    const during = c.slice(c.indexOf('{face === "during" && ('), c.indexOf('{face === "after" && ('));
    expect(during).toContain("{seating}");
    // The old second list is gone from this file, and the one card keeps its rules.
    expect(c).not.toMatch(/function SeatingPanel\b/);
    expect(SEATING).toContain("s.warning");
    expect(SEATING).toContain("seat-warning-");
    expect(SEATING).not.toContain("Internal-only employees are not offered");
    expect(SEATING).toContain("seatableFor(");
    expect(SEATING).toContain('data-testid="live-help-revoke-all"');
    expect(SEATING).toContain('data-testid="live-help-restore"');
  });

  it("mounts the close-out inside the After face, and nowhere else", () => {
    const c = code(MEETINGS);
    expect((c.match(/<CloseoutPanel\b/g) ?? []).length).toBe(1);
    expect(c).toMatch(/closeout=\{<CloseoutPanel meetingId=\{meetingId\} \/>\}/);
    expect(code(FACES)).toContain("{closeout}");
    expect(CLOSEOUT).toContain('data-testid="closeout-run"');
  });

  it("keeps what was written down on the During face, under the room", () => {
    const c = code(MEETINGS);
    const during = c.slice(c.indexOf('{face === "during" && ('), c.indexOf('{face === "after" && ('));
    expect(during).toContain("<RoomPanel");
    expect(during).toContain("<WrittenRecord");
    for (const hook of ["meeting-recording", "meeting-consent", "consent-grant", "consent-revoke", "transcript-import", "note-form", "note-list", "fireflies-import", "transcript-list"]) {
      expect(MEETINGS, `${hook} left the record`).toContain(`data-testid="${hook}"`);
    }
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
    // Phase D: nor a Live Help or Close-out mount of its own.
    expect(APP).not.toContain("<LiveHelpPanel");
    expect(APP).not.toContain("<CloseoutPanel");
  });

  it("mounts the surface exactly once", () => {
    expect((APP.match(/<MeetingsSurface\b/g) ?? []).length).toBe(1);
  });

  it("keeps the record inside the page that owns it", () => {
    expect(MEETINGS).toContain('data-testid="meeting-detail"');
  });
});

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

  it("renders standalone behind the same gate, for a Meet Add-on side panel later", () => {
    expect(APP).toContain("export function RoomStandalone");
    expect(APP).toMatch(/#\\\/room\\\//);
    expect(APP).toContain("<RoomPanel meetingId={meetingId} standalone />");
    expect(APP).toContain('useApi<MeResponse>("/api/me")');
    // Standalone is one column with the seats as chips (artboard D); in the app the aside is the page's.
    expect(ROOM).toContain("standalone || !aside ? (");
    expect(ROOM).toContain("<SeatedRow");
    expect(ROOM).toContain('className="chips"');
  });
});

describe("the stage move from a meeting is a click, not a card (owner, Q2, 18 Sep 2026)", () => {
  it("Move it is the After face's one primary and goes straight to the proposal's decide route", () => {
    const after = code(FACES).slice(code(FACES).indexOf("export function AfterPanel("));
    expect(after).toContain('className="btn-primary"');
    expect(after).toMatch(/data-testid=\{`stage-accept-\$\{p\.id\}`\}[^>]*onClick=\{\(\) => void post\(`\/api\/meeting-stage-proposals\/\$\{p\.id\}\/decide`, \{ decision: "ACCEPT" \}/);
    expect(after).toContain('className="card watch-banner"');
    // It raises no approval card of its own.
    expect(after).not.toContain("/api/approvals");
    // Exactly one primary on the whole surface.
    expect((code(FACES).match(/btn-primary/g) ?? []).length).toBe(1);
    expect(code(MEETINGS)).not.toContain("btn-primary");
  });

  it("approving the draft is the one human card, and the copy says so", () => {
    const after = code(FACES).slice(code(FACES).indexOf("export function AfterPanel("));
    expect(after).toContain('data-testid="draft-approve"');
    expect(after).toContain("/api/meeting-after-drafts/${a.latest_draft!.id}/approve");
    expect(after).toContain("Approving is one human card. The stage move above is not.");
  });

  it("puts the draft's own sentence at rank 0 on After", () => {
    const after = code(FACES).slice(code(FACES).indexOf("export function AfterPanel("));
    expect(after).toMatch(/<h2 data-testid="after-answer">/);
    expect(after).toContain("sentenceOf(draft.decisions.length, draft.commitments.length, draft.open_questions.length");
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

describe("the capture switch is never live-looking and inert", () => {
  it("opens only when the two things the prompt cannot supply are true, and stops when on", () => {
    /*
     * The switch does not wait on `can_capture` — consent is what the prompt behind it collects,
     * so a switch gated on consent could never be pressed to ask for it. Off, it waits on the two
     * gates the prompt cannot open: a transcription service and the Managing Partner's recording
     * policy. On, it is enabled so it can stop.
     */
    const disabled = /disabled=\{([^}]*)\}/g;
    const guards = [...ROOM.matchAll(disabled)].map((m) => m[1]!);
    const startGuard = guards.find((g) => g.includes("transcription_available"));
    expect(startGuard, "the switch must consult the server's transcription_available").toBeTruthy();
    expect(startGuard).toContain("recording_policy_active");
    expect(startGuard).toContain("prompting");
    expect(startGuard).toMatch(/^!recording && \(/);
  });

  it("starts the recorder only when the SERVER says a chunk posted now would be written down", () => {
    // A yes with the policy gate still shut records the consent and starts nothing.
    expect(ROOM).toContain('if (answer === "GRANTED" && res.data?.can_capture) void start();');
    expect(ROOM).toMatch(/but nothing is recording/);
  });

  it("prints the reason it cannot record rather than only greying out", () => {
    expect(ROOM).toContain('data-testid="capture-blockers"');
    expect(ROOM).toContain('data-testid="room-status"');
    expect(ROOM).toContain('role="status" aria-live="polite"');
  });

  it("names a chunk that failed instead of leaving a hole in the transcript, and the switch goes red", () => {
    expect(ROOM).toMatch(/was not written down/);
    expect(ROOM).toContain('data-state={failed ? "error"');
  });

  it("sends the recorder's MIME type with every slice, so Nova-3 can read the container", () => {
    expect(ROOM).toContain("content_type: blob.type");
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

describe("joining a Meet call is one press that says where it goes", () => {
  it("names Meet in the accessible name and opens with no opener", () => {
    expect(MEETINGS).toContain('aria-label="Join on Meet — opens Google Meet in a new tab"');
    expect(MEETINGS).toContain('"_blank", "noopener,noreferrer"');
    expect(MEETINGS).toContain("m.meet_link && <JoinOnMeet");
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
