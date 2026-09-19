/**
 * A Google Meet transcript as turns (Phase Meet, tier 2).
 *
 * MEET ATTRIBUTES BY PARTICIPANT RESOURCE, NOT BY NAME. Each transcript entry carries a
 * `participant` resource name; the participants list maps that to a signed-in user, an anonymous
 * guest, or a phone caller, each with a display name. So attribution here is a JOIN, not a
 * parse — which is why it is more trustworthy than a Fireflies export, and why the one case that
 * cannot be joined is kept unattributed rather than guessed: an entry whose participant resource
 * is missing, or is not in the list, becomes a turn with `speaker: null`, exactly as
 * `parseFireflies` does for an unlabelled line. Close-out assigns commitments from these turns;
 * an invented attribution becomes a task assigned to somebody who never agreed to it.
 *
 * SAME OUTPUT SHAPE AS THE FIREFLIES PARSER, on purpose. `turnLine` renders both, so a note
 * derived from a Meet transcript reads identically to one derived from an export, and anything
 * downstream that learned one format has learned the other.
 */

import type { TranscriptTurn } from "./firefliesTranscript";
import { turnLine } from "./firefliesTranscript";

/** One `conferenceRecords.participants` item, reduced. */
export interface MeetParticipant {
  /** "conferenceRecords/{r}/participants/{p}". */
  name: string;
  displayName: string | null;
  kind: "SIGNED_IN" | "ANONYMOUS" | "PHONE" | "UNKNOWN";
  /** "users/{id}" for a signed-in user. Meet does not return the email address. */
  userResource: string | null;
  earliestStartTime: string | null;
  latestEndTime: string | null;
}

/** One `transcripts.entries` item, reduced. */
export interface MeetTranscriptEntry {
  name: string;
  /** "conferenceRecords/{r}/participants/{p}", or null when Meet did not attribute it. */
  participant: string | null;
  text: string;
  languageCode: string | null;
  startTime: string | null;
  endTime: string | null;
}

export function participantFromApi(p: Record<string, any>): MeetParticipant {
  const signed = p.signedinUser;
  const anon = p.anonymousUser;
  const phone = p.phoneUser;
  return {
    name: String(p.name ?? ""),
    displayName: signed?.displayName ?? anon?.displayName ?? phone?.displayName ?? null,
    kind: signed ? "SIGNED_IN" : anon ? "ANONYMOUS" : phone ? "PHONE" : "UNKNOWN",
    userResource: signed?.user ? String(signed.user) : null,
    earliestStartTime: p.earliestStartTime ?? null,
    latestEndTime: p.latestEndTime ?? null,
  };
}

export function entryFromApi(e: Record<string, any>): MeetTranscriptEntry {
  return {
    name: String(e.name ?? ""),
    participant: typeof e.participant === "string" && e.participant ? e.participant : null,
    text: String(e.text ?? "").trim(),
    languageCode: e.languageCode ?? null,
    startTime: e.startTime ?? null,
    endTime: e.endTime ?? null,
  };
}

/** "2026-09-18T15:04:05.123Z" → "15:04:05". The clock time, verbatim from the entry, never computed. */
function clockOf(iso: string | null): string | null {
  if (!iso) return null;
  const m = /T(\d{2}:\d{2}:\d{2})/.exec(iso);
  return m ? m[1]! : null;
}

export interface MeetTranscriptTurns {
  turns: TranscriptTurn[];
  unattributed: number;
  /** Participants who spoke, in first-speaking order — what the meeting card lists. */
  speakers: string[];
}

/**
 * Join entries to participants. Consecutive entries by the same participant are merged into one
 * turn, so a transcript of a hundred short segments reads as speech rather than as a ticker.
 * Entries are taken in the order Meet returns them (chronological).
 */
export function turnsFromMeet(entries: readonly MeetTranscriptEntry[], participants: readonly MeetParticipant[]): MeetTranscriptTurns {
  const nameOf = new Map<string, string | null>();
  for (const p of participants) nameOf.set(p.name, p.displayName);
  const turns: TranscriptTurn[] = [];
  const speakers: string[] = [];
  for (const e of entries) {
    if (!e.text) continue;
    // A participant Meet named but the list does not hold is still unattributed: a resource name
    // is not a person, and rendering "participants/8f3a" as a speaker would look like one.
    const known = e.participant ? nameOf.get(e.participant) : undefined;
    const speaker = known ?? null;
    const last = turns[turns.length - 1];
    if (last && speaker !== null && last.speaker === speaker) {
      last.text = `${last.text} ${e.text}`.trim();
      continue;
    }
    turns.push({ speaker, at: clockOf(e.startTime), text: e.text });
    if (speaker && !speakers.includes(speaker)) speakers.push(speaker);
  }
  return { turns, unattributed: turns.filter((t) => t.speaker === null).length, speakers };
}

/** The text the governed import receives: one block per turn, unattributed turns saying so. */
export function meetTranscriptText(turns: readonly TranscriptTurn[]): string {
  return turns.map(turnLine).join("\n\n");
}

/** "conferenceRecords/abc/…" → "conferenceRecords/abc". */
export function conferenceRecordOf(resource: string): string | null {
  const m = /^(conferenceRecords\/[^/]+)/.exec(resource);
  return m ? m[1]! : null;
}
