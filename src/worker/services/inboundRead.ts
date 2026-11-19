/**
 * THE ONE MODEL READ OF AN INBOUND EMAIL (owner, 17 Nov 2026; shared/intake/inboundRead.ts says why). The readers are
 * the partner first read's (partnerUnderstood.ts FIRST_READERS), in an order set by WHO SENT IT (owner, 17 Nov 2026):
 *   - a partner (Sequoia, Scooter): the partner ladder unchanged, Claude then Codex, then Workers AI;
 *   - a COMMITTED Fund I LP (a committed LP's name in the sender, subject or words, by the committed-LP records the
 *     router reads), or the records cannot be read: Claude then Codex ONLY, never a free or training route (fail closed);
 *   - anyone else (brands, help desks, AI assistants, RSVPs, forms; LP prospects included): free Gemini FIRST ("it's
 *     just a first read"), then Claude or Codex, then Workers AI. Gemini reads with committed LPs' names and deal terms
 *     masked (partnerUnderstood.ts `maskedGeminiRead`, owner ruling 19 Nov 2026), and skips the email when it cannot mask.
 * A reader that is not there is passed over; one whose answer does not parse is passed over too. No reader: null, and
 * the caller decides from its word lists and says so (NAMED STOP INBOUND_NO_MODEL_READER).
 */
import type { Env } from "../env";
import { FIRST_READERS, type Reader } from "./partnerUnderstood";
import { partnerByEmail } from "../../shared/registry/partners";
import { addressIn } from "../../shared/intake/partnerAuthority";
import { committedLps, committedLpNamedIn } from "../ai/committedLps";
import { inboundReadPrompt, parseInboundRead, type InboundRead } from "../../shared/intake/inboundRead";

const byName = (names: readonly string[]): Reader[] => names.map((n) => FIRST_READERS.find((r) => r.name === n)!).filter(Boolean);
export type InboundSenderClass = "PARTNER" | "COMMITTED_LP" | "ANYONE";

/** Who sent it, for the reader order. A committed LP is never a free route; unreadable records count as one. */
export async function inboundLadder(env: Env, input: { from: string; subject: string; words: string; firmScope: string }): Promise<{ sender: InboundSenderClass; readers: Reader[] }> {
  const address = (addressIn(input.from) ?? input.from).trim().toLowerCase();
  if (partnerByEmail(address)) return { sender: "PARTNER", readers: [...FIRST_READERS] };
  const lps = await committedLps(env, input.firmScope);
  if (!lps.readable || committedLpNamedIn([input.from, input.subject, input.words], lps.names)) return { sender: "COMMITTED_LP", readers: byName(["SEAT"]) };
  return { sender: "ANYONE", readers: byName(["GEMINI", "SEAT", "WORKERS_AI"]) };
}

export async function readInbound(
  env: Env,
  input: { context: string; from: string; subject: string; words: string; firmScope: string; employeeId: string | null },
  stub?: readonly Reader[],
): Promise<{ read: InboundRead | null; tried: string[]; sender: InboundSenderClass }> {
  const ladder = await inboundLadder(env, input);
  // A committed LP's email reaches her seat alone, whatever readers a caller hands in.
  const readers = (stub ?? ladder.readers).filter((r) => ladder.sender !== "COMMITTED_LP" || r.name === "SEAT");
  const sender = ladder.sender;
  const tried: string[] = [];
  if (!input.words.trim()) return { read: null, tried: ["no words to read"], sender };
  const prompt = inboundReadPrompt(input);
  for (const r of readers) {
    const out = await r.read(env, { prompt, firmScope: input.firmScope, employeeId: input.employeeId, purpose: "the read of an inbound email: who sent it, what they ask, what we owe" });
    if (!out.ok) {
      tried.push(`${r.name}: ${out.out ? "out" : "failed"} (${out.detail.slice(0, 100)})`);
      // A firm in LOCAL or LOCKDOWN privacy has no model reader at all: the next one would only say so again.
      // (Only for a private reader: Gemini's refusal says nothing about Claude's.)
      if (r.name !== "GEMINI" && out.out && /no model reader in this privacy mode/.test(out.detail)) break;
      continue;
    }
    const read = parseInboundRead(out.text, out.reader ?? r.name);
    tried.push(`${r.name}: ${read ? "read it" : "answer did not parse"}`);
    if (read) return { read, tried, sender };
  }
  return { read: null, tried, sender };
}
