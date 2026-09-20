import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { JOIN_ON_MEET_LINE } from "@shared/meetings/howTheRoomHears";
import {
  ADDON_NOT_INSTALLED_LINE,
  JOIN_MODES,
  JOIN_MODE_KEY,
  JOIN_MODE_WORDS,
  LAPTOP_MIC_NOTE,
  LAPTOP_MIC_YIELDS_LINE,
  liveMeetPathAvailable,
  meetAddonInstalled,
  roomHash,
  type JoinMode,
} from "@shared/meetings/meetJoin";

/**
 * THE DOORS ONTO A CALL — one room per meeting, several doors, all landing in that same room.
 *
 * Owner, 19 Sep 2026: "I don't understand what Open the room does anymore — I thought I had to go
 * there to get to the interface where I ask AI agents to do things on demand." And: "Join on Meet
 * should give the option to do it inside the Meet tab or external like now; if inside, it loads a
 * new layout, and we can return when it's over." And: until Google's live path lands, "the way to
 * get the room live on a Meet call is the laptop-mic switch while the call plays through the
 * speakers" — a first-class path, not a hack she has to know.
 *
 * So, beneath the one primary ("Go to this meeting"), for a meeting with a call:
 *
 *   JOIN ON MEET, two ways, remembered per viewer (localStorage — a preference, not a fact):
 *     Inside the call — the Meet opens with this room as its side panel (the Tier 3 add-on). Until
 *                       the add-on is installed for the org the line says so and it falls back to:
 *     Beside the call — the Meet opens in a new tab and the room, narrow, opens in this one
 *                       (`#/room/<id>`). ONE press: she never presses Open the room after it.
 *   USE MY LAPTOP MIC FOR THIS MEET CALL — opens the Meet AND arms the room's recording switch
 *     through the same consent path (the prompt appears; nothing records until "They said yes"),
 *     with the note that says how to sit: speakers, not headphones; mic unmuted in Meet. When the
 *     live Meet path is available for a meeting it yields to it (`liveMeetPathAvailable`, the
 *     sibling's hook) and says so.
 *
 * Every press that opens the call also tells the row it started (`POST /api/meetings/:id/started`),
 * so "in progress" is derived from the event and never from a button (0214).
 *
 * `standalone`: rendered inside the narrow room itself, where "beside" means "you are already
 * here" — the Meet opens in a new tab and the laptop mic arms in place through `onArmMic`.
 */

export interface CallDoorsMeeting {
  id: string;
  meet_link: string | null;
  /** `meeting.meet_live_state` (tier 4) when the caller has it: joining/listening makes the laptop mic yield. */
  meet_live_state?: string | null;
}

function rememberedMode(): JoinMode {
  try {
    const raw = window.localStorage.getItem(JOIN_MODE_KEY);
    return (JOIN_MODES as readonly string[]).includes(raw ?? "") ? (raw as JoinMode) : "beside";
  } catch {
    return "beside";
  }
}

function remember(mode: JoinMode): void {
  try {
    window.localStorage.setItem(JOIN_MODE_KEY, mode);
  } catch {
    // A private window keeps nothing; the choice still applies to this press.
  }
}

export function CallDoors({ meeting, standalone = false, onArmMic, compact = false }: { meeting: CallDoorsMeeting; standalone?: boolean; onArmMic?: () => void; compact?: boolean }): JSX.Element | null {
  const [mode, setMode] = useState<JoinMode>("beside");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setMode(rememberedMode()), []);
  if (!meeting.meet_link) return null;
  const link = meeting.meet_link;
  const yields = liveMeetPathAvailable(meeting);

  async function started(via: "join_on_meet" | "laptop_mic"): Promise<void> {
    // The row learns it started. A refusal here is not a reason to hold the door.
    await api(`/api/meetings/${meeting.id}/started`, { method: "POST", body: { via } }).catch(() => undefined);
  }

  function openMeet(): void {
    window.open(link, "_blank", "noopener,noreferrer");
  }

  function goToRoom(withMic: boolean): void {
    if (standalone) {
      if (withMic) onArmMic?.();
      return;
    }
    window.location.hash = withMic ? `${roomHash(meeting.id)}?mic=1` : roomHash(meeting.id);
  }

  async function join(): Promise<void> {
    setBusy("join");
    setNote(null);
    let effective = mode;
    if (mode === "inside" && !meetAddonInstalled()) {
      setNote(ADDON_NOT_INSTALLED_LINE);
      effective = "beside";
    }
    openMeet();
    await started("join_on_meet");
    setBusy(null);
    if (effective === "beside") goToRoom(false);
    // "inside": the add-on opens the room in Meet's own panel; this tab has nothing more to do.
  }

  async function laptopMic(): Promise<void> {
    setBusy("mic");
    setNote(null);
    openMeet();
    await started("laptop_mic");
    setBusy(null);
    goToRoom(true);
  }

  function choose(next: JoinMode): void {
    setMode(next);
    remember(next);
    setNote(null);
  }

  return (
    <div className={compact ? "call-doors call-doors-compact" : "call-doors"} data-testid={`call-doors-${meeting.id}`}>
      <div className="call-doors-row">
        <button
          type="button"
          className="btn-strong"
          data-testid={`join-${meeting.id}`}
          aria-label={`Join on Meet, ${JOIN_MODE_WORDS[mode].label.toLowerCase()} — opens Google Meet in a new tab; nothing joins for you`}
          aria-describedby={`join-line-${meeting.id}`}
          title={JOIN_ON_MEET_LINE}
          aria-busy={busy === "join"}
          disabled={busy !== null}
          onClick={() => void join()}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6" /></svg>
          Join on Meet
        </button>
        <fieldset className="join-mode" data-testid={`join-mode-${meeting.id}`}>
          <legend className="sr-only">How to join</legend>
          {JOIN_MODES.map((m) => (
            <label key={m} className={mode === m ? "join-mode-on" : undefined} title={JOIN_MODE_WORDS[m].does}>
              <input type="radio" name={`join-mode-${meeting.id}`} value={m} checked={mode === m} data-testid={`join-mode-${m}-${meeting.id}`} onChange={() => choose(m)} />
              {JOIN_MODE_WORDS[m].label}
            </label>
          ))}
        </fieldset>
      </div>
      <span className="field-help" id={`join-line-${meeting.id}`} data-testid={`join-line-${meeting.id}`}>
        {JOIN_MODE_WORDS[mode].label} · {JOIN_MODE_WORDS[mode].does} {compact ? "" : JOIN_ON_MEET_LINE}
      </span>
      {yields ? (
        <span className="field-help" data-testid={`laptop-mic-yields-${meeting.id}`}>{LAPTOP_MIC_YIELDS_LINE}</span>
      ) : (
        <div className="call-doors-row">
          <button
            type="button"
            data-testid={`laptop-mic-${meeting.id}`}
            aria-describedby={`laptop-mic-note-${meeting.id}`}
            title={LAPTOP_MIC_NOTE}
            aria-busy={busy === "mic"}
            disabled={busy !== null}
            onClick={() => void laptopMic()}
          >
            Use my laptop mic for this Meet call
          </button>
          <span className="field-help" id={`laptop-mic-note-${meeting.id}`} data-testid={`laptop-mic-note-${meeting.id}`}>{LAPTOP_MIC_NOTE}</span>
        </div>
      )}
      {note && <p className="notice small" data-testid={`call-doors-note-${meeting.id}`} role="status">{note}</p>}
    </div>
  );
}

/** The hint under the one primary door: one room, several doors. */
export const ONE_ROOM_LINE = "One room for this meeting — the brief, the live draft, ask the room, your employees, and what came out of it. Join the call from here or open it on its own.";
