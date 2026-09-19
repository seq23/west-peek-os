/**
 * JOINING A MEET CALL — two ways, remembered per viewer; and the laptop microphone as a first-class
 * path onto the call until Google's live path lands.
 *
 * OWNER, 19 Sep 2026, verbatim: "Join on Meet should give the option to do it inside the Meet tab
 * or external like now; if inside, it loads a new layout, and we can return when it's over." And,
 * the same day: until Google's preview enrolment lands, "the way to get the room live on a Meet
 * call is the laptop-mic switch while the call plays through the speakers" — build it as a
 * first-class path, not a hack she has to know.
 *
 * TWO WAYS TO JOIN:
 *   INSIDE — the Meet opens with this room as its side panel (the Tier 3 add-on, docs/GOOGLE_MEET.md).
 *            Until the add-on is installed for the org the choice says so and falls back to BESIDE.
 *   BESIDE — the Meet opens in a new tab and the standalone room (`#/room/<id>`) opens in this one:
 *            the narrow layout, no shell, a way back when it is over.
 *
 * THE HOOKS THE SIBLING WIRES (feat/meet-media-live), named here so nothing has to be guessed:
 *   `meetAddonInstalled()`   — true once the add-on is installed for westpeek.ventures; INSIDE then
 *                              opens the Meet and lets the add-on open `#/room/<id>` in its panel.
 *   `liveMeetPathAvailable`  — true for a meeting the Media API path can join; the laptop-mic
 *                              control then yields to it and says so.
 *   `CALL_ENDED_SIGNAL`      — the column the room reads to know the call is over:
 *                              `meeting.call_ended_at` (#131's), served as `facts.call_ended_at`;
 *                              until that column lands, Google's end time on the inbox row stands in.
 */

export const JOIN_MODES = ["inside", "beside"] as const;
export type JoinMode = (typeof JOIN_MODES)[number];

/** Per-viewer memory of the last way she joined. localStorage: a preference, not a fact about the meeting. */
export const JOIN_MODE_KEY = "wp-meet-join-mode";

export const JOIN_MODE_WORDS: Readonly<Record<JoinMode, { label: string; does: string }>> = {
  inside: { label: "Inside the call", does: "opens the Meet with this room as its side panel." },
  beside: { label: "Beside the call", does: "opens the Meet in a new tab and this room, narrow, in this one." },
};

/** The Tier 3 add-on: not installed for the org yet. The sibling flips this when it is. */
export function meetAddonInstalled(): boolean {
  return false;
}

export const ADDON_NOT_INSTALLED_LINE = "The Meet side panel is not installed for the firm yet, so this opens the call beside the room instead.";

/** The Media API live path: not available for any meeting yet. The sibling makes this real per meeting. */
export function liveMeetPathAvailable(_meeting: { id: string; meet_link: string | null }): boolean {
  return false;
}

/**
 * The end-of-call signal, agreed with #131: `meeting.call_ended_at` (ISO, null until the call ends;
 * first writer wins between the live listener's ENDED report and the ended-call ingest from
 * Google's end time), served as `facts.call_ended_at` by `GET /api/meetings/:id/hearing`. On a head
 * without that column, Google's end time on the inbox row (`facts.meet.conference_ended_at`) stands
 * in — `callIsOver` in howTheRoomHears.ts reads both.
 */
export const CALL_ENDED_SIGNAL = "meeting.call_ended_at" as const;

/** The laptop-mic path onto a Meet call, in the owner's words and the note beside the control. */
export const LAPTOP_MIC_LABEL = "Use my laptop mic for this Meet call";
export const LAPTOP_MIC_NOTE = "The room hears you directly and them through your speakers — use speakers, not headphones, and keep this mic unmuted in Meet.";
export const LAPTOP_MIC_OWNER_WORDS = "the way to get the room live on a Meet call is the laptop-mic switch while the call plays through the speakers";
export const LAPTOP_MIC_YIELDS_LINE = "The room can join this call itself now, so the laptop microphone is not needed.";

/** The way back when it is over. */
export const RETURN_LABEL = "Open what came out of it";
export const RETURN_LINE = "Back to the full record in the app — After, with the draft as it stands.";

/** The main app's address for one meeting's face. `#/meetings?open=<id>&face=after`. */
export function meetingFaceHash(meetingId: string, face: "before" | "during" | "after"): string {
  return `#/meetings?open=${encodeURIComponent(meetingId)}&face=${face}`;
}

export function roomHash(meetingId: string): string {
  return `#/room/${encodeURIComponent(meetingId)}`;
}

/** Read `open` and `face` off the Meetings address, if they are there. */
export function meetingFaceFromHash(hash: string): { open: string; face: "before" | "during" | "after" } | null {
  const q = hash.indexOf("?");
  if (q === -1) return null;
  const params = new URLSearchParams(hash.slice(q + 1));
  const open = params.get("open");
  const face = params.get("face");
  if (!open) return null;
  return { open, face: face === "during" || face === "after" ? face : "before" };
}
