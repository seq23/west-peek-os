import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi, type RunAiInput } from "../src/worker/ai/runAi";
import { claimRun, reapSeatRuns, recordHeartbeat, reportRun, type Seat, type SeatRunRow } from "../src/worker/ai/subscriptionSeats";
import { attachmentCapability, attachmentRefusal, capabilitiesAllow, MAX_ATTACHMENT_BYTES, safeLabel } from "../src/worker/ai/seatAttachments";
import { handleSubscriptionSeatAttachment } from "../src/worker/services/subscriptionSeats";
import {
  attachmentNote,
  capabilitiesFromProof,
  claudeAttachArgs,
  codexAttachArgs,
  mergeProof,
  missingCapability,
  PROOF_MAX_AGE_MS,
  readProof,
  safeFileName,
  writeProof,
} from "../scripts/lib/seat-attachments.mjs";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../src/worker/auth";

/**
 * A SUBSCRIPTION SEAT MAY BE HANDED A PICTURE OR A DOCUMENT — BUT ONLY BY A CLAIMER THAT PROVED IT CAN READ ONE (0249, 1 Oct 2026).
 *
 * Why: the owner's rule is that when Claude Code is out of usage, Codex takes the work — any work. Work carrying a deck
 * was the exception, because the queue carries text and an adapter that dropped a file would answer confidently about
 * something it never saw. The transport is built here; routing to a seat for files only switches on where the Mac's own
 * probe proved the seat can read that kind, and the claimer declares exactly that from the proof file the probe writes.
 *
 * PROVEN HERE (local D1, a fake R2 bucket, a simulated claimer): who is offered a file and who is not; that the bytes
 * reach only the device holding the run; that the files are gone when the run ends; that oversize and wrong-type files
 * are refused before anything is stored; and that the Mac-side proof file turns into capabilities only when fresh and true.
 *
 * NOT PROVEN HERE, labelled in the ledger: that `codex exec -i` or `claude -p` actually read a file on the owner's Mac
 * (the probe does that), and anything about how large a real deck behaves against the queue's timings.
 */

let t: TestDb;
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const DECK = { mediaType: "application/pdf", dataBase64: btoa("%PDF-1.4 a small deck"), label: "Q3 deck.pdf" };
const PICTURE = { mediaType: "image/png", dataBase64: btoa("not really a png but bytes"), label: "screenshot.png" };

function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    put: async (key: string, body: ArrayBuffer | Uint8Array | string) => {
      store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body));
      return { key };
    },
    get: async (key: string) => {
      const b = store.get(key);
      return b ? { arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) } : null;
    },
    delete: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  };
}
let bucket = fakeBucket();
const env = (): Env => makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", WP_ANTHROPIC_API_KEY: "ant", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", WP_OS_DOCUMENTS: bucket as never } as Partial<Env>);

/** A seat that checked in, declaring exactly these capabilities. */
const awake = (seat: Seat, capabilities: string[]): Promise<void> => recordHeartbeat(env(), { seat, deviceId: "mac-test", hostname: "her-mac", capabilities });

const DOC_CALL = (documents = [DECK], images?: Array<typeof PICTURE>): RunAiInput => ({
  purpose: "read the deck",
  actor: MP_ACTOR,
  inputs: ["Summarise this deck."],
  sensitivity: "INTERNAL" as never,
  documents,
  ...(images ? { images } : {}),
  budgetContext: { expectedOutputTokens: 200, judgement: true, confidential: true },
  routing: { category: "OPERATIONS" as const, taskClass: "employee-work" },
});

function claimerThatReads(seats: Seat[], opts: { canRead?: boolean; answer?: string } = {}): { stop: () => Promise<void>; handled: SeatRunRow[]; seenBytes: string[] } {
  const handled: SeatRunRow[] = [];
  const seenBytes: string[] = [];
  let live = true;
  const loop = (async () => {
    while (live) {
      const run = await claimRun(env(), "mac-test", seats, new Date(), ["ANSWER"], false, opts.canRead ?? true);
      if (!run) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      handled.push(run);
      // Fetch the files exactly as the real claimer does: through the download route, as the holding device.
      for (const a of JSON.parse(run.attachments_json ?? "[]") as Array<{ n: number }>) {
        const res = await download(run.id, "mac-test", a.n);
        seenBytes.push(res.status === 200 ? new TextDecoder().decode(await res.arrayBuffer()) : `HTTP ${res.status}`);
      }
      await reportRun(env(), { runId: run.id, deviceId: "mac-test", outputText: opts.answer ?? `SEAT READ THE FILE (${run.seat})` });
    }
  })();
  return { handled, seenBytes, stop: async () => { live = false; await loop; } };
}

async function download(runId: string, deviceId: string, n: number, email = SUBSCRIPTION_CLAIMER_EMAIL): Promise<Response> {
  return handleSubscriptionSeatAttachment({
    env: env(),
    request: new Request(`https://os.test/api/subscription-seats/attachment?run_id=${runId}&device_id=${deviceId}&n=${n}`),
    identity: { email, roles: [], firmUserId: "fu_claimer", firmScopes: ["west-peek"] },
  } as never);
}

const rows = async () => ((await t.db.prepare("SELECT * FROM subscription_seat_run ORDER BY created_at").all()).results ?? []) as unknown as SeatRunRow[];

beforeAll(async () => {
  t = await createTestDb();
  // FRONTIER privacy, so a private call is routed to real lanes (the default test policy is LOCKDOWN, which answers locally).
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by)
       VALUES ('bp_seatfiles', 'west-peek', 'NORMAL', 'FRONTIER', 500, 500, 1, 0, 'MODERATE', 0, 'fu_sequoia_taylor')`,
    )
    .run();
});
afterAll(async () => {
  await disposeTestDb(t);
});
beforeEach(async () => {
  bucket = fakeBucket();
  await t.db.prepare("DELETE FROM subscription_seat_device").run();
  await t.db.prepare("DELETE FROM subscription_seat_run").run();
  await t.db.prepare("DELETE FROM provider_lane_health").run();
});

describe("the pure rules", () => {
  it("a capability is declared per seat and kind, and an unreadable declaration means no", () => {
    expect(attachmentCapability("codex", "image")).toBe("read_image:codex");
    expect(capabilitiesAllow(JSON.stringify(["web_search", "read_document:codex"]), "codex", "document")).toBe(true);
    expect(capabilitiesAllow(JSON.stringify(["read_document:codex"]), "claude_code", "document"), "another seat's proof is not this seat's").toBe(false);
    expect(capabilitiesAllow("not json", "codex", "image")).toBe(false);
    expect(capabilitiesAllow(null, "codex", "image")).toBe(false);
  });

  it("a file name cannot climb out of a directory or look like a flag", () => {
    expect(safeLabel("../../etc/passwd", 0, "application/pdf")).toBe("1-passwd.pdf");
    expect(safeLabel("--dangerous.png", 1, "image/png")).toBe("2-dangerous.png");
    expect(safeFileName("../../../.ssh/id_rsa", 0)).toBe("id_rsa");
    expect(safeFileName("-rf", 0)).toBe("rf");
    expect(safeFileName("", 2)).toBe("file-3");
  });

  it("size, count and type are bounded before anything is stored", () => {
    const big = "A".repeat(Math.ceil(((MAX_ATTACHMENT_BYTES + 10) * 4) / 3));
    expect(attachmentRefusal([{ kind: "document", mediaType: "application/pdf", dataBase64: big }])).toMatch(/over 8 MB/);
    expect(attachmentRefusal([{ kind: "document", mediaType: "application/vnd.ms-powerpoint", dataBase64: "QQ==" }])).toMatch(/document type/);
    expect(attachmentRefusal([{ kind: "image", mediaType: "image/tiff", dataBase64: "QQ==" }])).toMatch(/image type/);
    expect(attachmentRefusal(Array.from({ length: 6 }, () => ({ kind: "image" as const, mediaType: "image/png", dataBase64: "QQ==" })))).toMatch(/more than 5/);
    expect(attachmentRefusal([{ kind: "document", mediaType: "application/pdf", dataBase64: DECK.dataBase64 }])).toBeNull();
  });
});

describe("the Mac side: a seat declares only what its own probe proved", () => {
  const now = Date.parse("2026-10-02T12:00:00Z");

  it("a fresh proof becomes capabilities, per seat and kind", () => {
    const proof = { at: "2026-10-02T11:00:00Z", seats: { codex: { image: true, pdf: false }, claude_code: { image: true, pdf: true } } };
    expect(capabilitiesFromProof(proof, now).sort()).toEqual(["read_document:claude_code", "read_image:claude_code", "read_image:codex"]);
  });

  it("no proof, an unreadable proof, a stale proof and a proof from the future declare nothing", () => {
    expect(capabilitiesFromProof(null, now)).toEqual([]);
    expect(capabilitiesFromProof({ seats: { codex: { image: true } } } as never, now)).toEqual([]);
    expect(capabilitiesFromProof({ at: new Date(now - PROOF_MAX_AGE_MS - 1000).toISOString(), seats: { codex: { image: true } } }, now)).toEqual([]);
    expect(capabilitiesFromProof({ at: new Date(now + 3_600_000).toISOString(), seats: { codex: { image: true } } }, now)).toEqual([]);
  });

  it("a probe run is folded in: PROVEN sets, FAILED withdraws, UNTESTED changes nothing", () => {
    const first = mergeProof(null, [{ seat: "codex", kind: "image", status: "PROVEN" }, { seat: "codex", kind: "pdf", status: "PROVEN" }], now);
    expect(first.seats.codex).toEqual({ image: true, pdf: true });
    const second = mergeProof(first, [{ seat: "codex", kind: "image", status: "UNTESTED" }, { seat: "codex", kind: "pdf", status: "FAILED" }], now);
    expect(second.seats.codex, "a plan out of usage says nothing; a failed re-read withdraws").toEqual({ image: true, pdf: false });
  });

  it("the proof file round-trips on disk and is private", () => {
    const home = mkdtempSync(path.join(tmpdir(), "wp-proof-"));
    try {
      expect(readProof(home)).toBeNull();
      writeProof(mergeProof(null, [{ seat: "claude_code", kind: "pdf", status: "PROVEN" }]), home);
      expect(capabilitiesFromProof(readProof(home))).toEqual(["read_document:claude_code"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("a run's files are refused unless the claimer holds EVERY capability they need", () => {
    const held = ["web_search", "read_image:codex"];
    expect(missingCapability("codex", [{ kind: "image" }], held)).toBeNull();
    expect(missingCapability("codex", [{ kind: "image" }, { kind: "document" }], held)).toBe("read_document:codex");
    expect(missingCapability("claude_code", [{ kind: "image" }], held)).toBe("read_image:claude_code");
  });

  it("Codex gets pictures with -i and documents by path; Claude reads everything by path with Read; the note says which", () => {
    const files = [{ kind: "image" as const, path: "/t/1-a.png", name: "1-a.png" }, { kind: "document" as const, path: "/t/2-b.pdf", name: "2-b.pdf" }];
    expect(codexAttachArgs(files, "P")).toEqual(["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-i", "/t/1-a.png", "P"]);
    expect(claudeAttachArgs("P")).toEqual(["-p", "P", "--allowedTools", "Read"]);
    expect(attachmentNote("codex", files)).toMatch(/attached image "1-a.png"/);
    expect(attachmentNote("codex", files)).toMatch(/\.\/2-b\.pdf in the current directory/);
    expect(attachmentNote("claude_code", files)).toMatch(/\.\/1-a\.png in the current directory/);
    expect(attachmentNote("codex", files)).toMatch(/say so plainly if one cannot be read/);
  });
});

describe("the router: a file goes to a seat only if that seat's claimer proved it can read the kind", () => {
  it("a seat that PROVED document reading serves a document call at $0; the bytes reach the holder; the files are deleted after", async () => {
    await awake("codex", [attachmentCapability("codex", "document")]);
    const c = claimerThatReads(["codex"]);
    const { run } = await runAi(env(), DOC_CALL());
    await c.stop();
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("SEAT READ THE FILE (codex)");
    expect(run.model).toBe("codex-local");
    expect(c.seenBytes).toEqual(["%PDF-1.4 a small deck"]);
    const [row] = await rows();
    expect(row!.status).toBe("REPORTED");
    expect(JSON.parse(row!.attachments_json!)[0]).toMatchObject({ n: 0, kind: "document", media_type: "application/pdf" });
    expect(row!.attachments_cleared_at, "the files were removed when the run ended").not.toBeNull();
    expect(bucket.store.size, "nothing is left in R2").toBe(0);
  }, 60_000);

  it("a seat that did NOT prove it is never parked the file — the call never touches the queue", async () => {
    await awake("codex", ["web_search"]);
    const c = claimerThatReads(["codex"]);
    const { run } = await runAi(env(), DOC_CALL(), { fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "VENDOR" } }], usage: {} }), { status: 200 })) as unknown as typeof fetch });
    await c.stop();
    expect(await rows(), "nothing was parked").toEqual([]);
    expect(bucket.store.size).toBe(0);
    expect(run.output_text ?? "").not.toContain("SEAT READ THE FILE");
  }, 60_000);

  it("proof for pictures is not proof for documents: a call carrying both needs both", async () => {
    await awake("codex", [attachmentCapability("codex", "image")]);
    const c = claimerThatReads(["codex"]);
    await runAi(env(), DOC_CALL([DECK], [PICTURE]), { fetchImpl: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
    await c.stop();
    expect(await rows()).toEqual([]);
  }, 60_000);

  it("an oversize file is refused before anything is stored", async () => {
    await awake("codex", [attachmentCapability("codex", "document")]);
    const c = claimerThatReads(["codex"]);
    const big = { ...DECK, dataBase64: "A".repeat(Math.ceil(((MAX_ATTACHMENT_BYTES + 100) * 4) / 3)) };
    const { run } = await runAi(env(), DOC_CALL([big]), { fetchImpl: (async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
    await c.stop();
    expect(run.status).not.toBe("COMPLETED");
    expect(bucket.store.size).toBe(0);
    expect(await rows()).toEqual([]);
  }, 60_000);
});

describe("the adapter is its own wall — it refuses a file for a seat that did not prove it, whoever called it", () => {
  const complete = async (seat: Seat, req: Record<string, unknown>) => {
    const { createSubscriptionSeatAdapter } = await import("../src/worker/ai/providers/subscriptionSeat");
    return createSubscriptionSeatAdapter({ env: env(), seat, modelAccess: "PRIVATE_MODEL_ONLY", waitMs: 50, pollMs: 5 }).complete({ purpose: "p", inputs: ["x"], model: null, ...req } as never);
  };

  it("no proof for documents: provider_cannot_read_documents, nothing stored, nothing parked", async () => {
    await awake("codex", [attachmentCapability("codex", "image")]);
    await expect(complete("codex", { documents: [DECK] })).rejects.toThrow(/provider_cannot_read_documents:codex/);
    expect(bucket.store.size).toBe(0);
    expect(await rows()).toEqual([]);
  });

  it("no proof for pictures: provider_cannot_see_images", async () => {
    await awake("codex", [attachmentCapability("codex", "document")]);
    await expect(complete("codex", { images: [PICTURE] })).rejects.toThrow(/provider_cannot_see_images:codex/);
    expect(await rows()).toEqual([]);
  });

  it("proof, but a wrong type: refused by the bounds before it is stored", async () => {
    await awake("codex", [attachmentCapability("codex", "document")]);
    await expect(complete("codex", { documents: [{ ...DECK, mediaType: "application/vnd.ms-powerpoint" }] })).rejects.toThrow(/document type/);
    expect(bucket.store.size).toBe(0);
  });

  it("proof, but nowhere to store the file: a capability refusal, not a silent drop", async () => {
    await awake("codex", [attachmentCapability("codex", "document")]);
    const { createSubscriptionSeatAdapter } = await import("../src/worker/ai/providers/subscriptionSeat");
    const noStore = makeTestEnv(t.db, {} as Partial<Env>);
    await expect(createSubscriptionSeatAdapter({ env: noStore, seat: "codex", modelAccess: "PRIVATE_MODEL_ONLY", waitMs: 50, pollMs: 5 }).complete({ purpose: "p", inputs: ["x"], model: null, documents: [DECK] } as never)).rejects.toThrow(/provider_cannot_read_documents:codex.*no document store/);
  });
});

describe("the queue and the download route", () => {
  async function parkWithFile(): Promise<string> {
    await awake("codex", [attachmentCapability("codex", "document")]);
    const { putSeatAttachments } = await import("../src/worker/ai/seatAttachments");
    const { parkRun } = await import("../src/worker/ai/subscriptionSeats");
    const id = `ccr_${crypto.randomUUID()}`;
    const attachments = await putSeatAttachments(env(), id, [{ kind: "document", mediaType: DECK.mediaType, dataBase64: DECK.dataBase64, label: DECK.label }]);
    await parkRun(env(), { id, attachments, seat: "codex", purpose: "p", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    return id;
  }

  it("a claimer that never said it can read files is never handed the run", async () => {
    await parkWithFile();
    expect(await claimRun(env(), "mac-test", ["codex"], new Date(), ["ANSWER"], false, false)).toBeNull();
    expect((await claimRun(env(), "mac-test", ["codex"], new Date(), ["ANSWER"], false, true))?.attachments_json).toBeTruthy();
  });

  it("only the HOLDING device is given the bytes; another device, an unclaimed run and a missing file number get 404", async () => {
    const id = await parkWithFile();
    expect((await download(id, "mac-test", 0)).status, "not claimed yet").toBe(404);
    await claimRun(env(), "mac-test", ["codex"], new Date(), ["ANSWER"], false, true);
    expect((await download(id, "other-mac", 0)).status, "not the holder").toBe(404);
    expect((await download(id, "mac-test", 3)).status, "no such file").toBe(404);
    const ok = await download(id, "mac-test", 0);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(new TextDecoder().decode(await ok.arrayBuffer())).toBe("%PDF-1.4 a small deck");
    expect((await download(id, "mac-test", 0, "someone@example.com")).status, "a stranger is refused outright").toBe(403);
  });

  it("an ended run's files are not downloadable and are deleted by the sweep even if the report path never ran", async () => {
    const id = await parkWithFile();
    expect(bucket.store.size).toBe(1);
    await t.db.prepare("UPDATE subscription_seat_run SET status = 'ABANDONED' WHERE id = ?1").bind(id).run(); // ended without going through abandonRun
    await reapSeatRuns(env());
    expect(bucket.store.size).toBe(0);
    expect((await rows())[0]!.attachments_cleared_at).not.toBeNull();
    expect((await download(id, "mac-test", 0)).status).toBe(404);
  });
});
