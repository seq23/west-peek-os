import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { CAPTURE_SOURCES, ingestTranscript, splitSegments } from "../src/worker/services/captureAdapter";

/**
 * Meeting Capture Adapter (P39, V1 #28).
 *
 * The behaviour worth protecting: consent is decided by the EXISTING import path, and a refusal
 * must write no notes at all. A capture that half-succeeds — refused, but with the transcript
 * already in the notes table — would defeat the consent gate entirely while looking governed.
 */

let t: TestDb;
let env: Env;
const MP: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const MEETING = "mtg_capture_probe";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await env.WP_OS_DB.prepare(
    `INSERT INTO meeting (id, title, meeting_type, status, privacy_label, firm_scope, created_by)
     VALUES (?1,'Capture probe','FOUNDER','SCHEDULED','CONFIDENTIAL','west-peek','fu_scooter_taylor')`,
  ).bind(MEETING).run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the four sources §33 names", () => {
  it("is exactly provider, native, manual, upload", () => {
    expect([...CAPTURE_SOURCES].sort()).toEqual(["MANUAL", "NATIVE", "PROVIDER", "UPLOAD"]);
  });
});

describe("segmenting", () => {
  it("splits on blank lines when they are present", () => {
    expect(splitSegments("A said this.\n\nB said that.")).toEqual(["A said this.", "B said that."]);
  });

  it("falls back to one segment per line", () => {
    expect(splitSegments("line one\nline two")).toEqual(["line one", "line two"]);
  });

  it("returns nothing for empty or whitespace input", () => {
    expect(splitSegments("")).toEqual([]);
    expect(splitSegments("   \n  \n ")).toEqual([]);
  });

  it("does not try to guess speaker turns", () => {
    // Deliberately dumb. A parser guessing at an unseen format can merge two people's words into
    // one attributed line, and that line later gets quoted as evidence.
    expect(splitSegments("Alice: hi\nBob: hello")).toEqual(["Alice: hi", "Bob: hello"]);
  });
});

describe("consent gate", () => {
  it("refuses when the recording policy was never activated, and writes NO notes", async () => {
    const { importTranscript } = await import("../src/worker/services/meetings");
    await expect(
      ingestTranscript(env, MP, MEETING, { source: "MANUAL", text: "Something was said." }, importTranscript as never),
    ).rejects.toMatchObject({ code: "recording_policy_not_activated" });

    const notes = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) n FROM meeting_note WHERE meeting_id = ?1",
    ).bind(MEETING).first<{ n: number }>();
    // The whole point: a refused capture leaves nothing behind.
    expect(notes!.n).toBe(0);
  });

  it("records the refusal so it is auditable", async () => {
    const rows = await env.WP_OS_DB.prepare(
      "SELECT status, refusal_reason FROM transcript_import WHERE meeting_id = ?1",
    ).bind(MEETING).all<{ status: string; refusal_reason: string }>();
    expect(rows.results?.some((r) => r.status === "REFUSED")).toBe(true);
  });

  it("404s an unknown meeting", async () => {
    const { importTranscript } = await import("../src/worker/services/meetings");
    await expect(
      ingestTranscript(env, MP, "mtg_nope", { source: "MANUAL", text: "x" }, importTranscript as never),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("a permitted capture", () => {
  it("turns the transcript into notes that inherit the meeting's privacy label", async () => {
    // Bypass the policy/consent path with a stub: those gates have their own coverage above, and
    // this test is about what happens to the TEXT once permission exists.
    const stub = async () => {
      const id = `tri_${crypto.randomUUID()}`;
      await env.WP_OS_DB.prepare(
        `INSERT INTO transcript_import (id, meeting_id, source, status, imported_by, firm_scope)
         VALUES (?1, ?2, 'MANUAL', 'IMPORTED', 'fu_scooter_taylor', 'west-peek')`,
      ).bind(id, MEETING).run();
      return { id };
    };

    const out = await ingestTranscript(
      env, MP, MEETING,
      { source: "MANUAL", text: "We agreed to send the deck.\n\nThey will introduce us to a design partner." },
      stub as never,
    );
    expect(out.segments).toBe(2);
    expect(out.notes_created).toBe(2);

    const notes = await env.WP_OS_DB.prepare(
      "SELECT note_type, privacy_label, transcript_import_id FROM meeting_note WHERE meeting_id = ?1",
    ).bind(MEETING).all<{ note_type: string; privacy_label: string; transcript_import_id: string }>();
    expect(notes.results).toHaveLength(2);
    for (const n of notes.results!) {
      expect(n.note_type).toBe("TRANSCRIPT_DERIVED");
      // A transcript is never less sensitive than the meeting it came from.
      expect(n.privacy_label).toBe("CONFIDENTIAL");
      // Provenance: this is what lets a close-out commitment quote its source line.
      expect(n.transcript_import_id).toBe(out.transcript_import_id);
    }
  });
});
