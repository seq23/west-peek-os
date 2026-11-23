/**
 * TWO BIG EMAILS AT ONCE NEVER RUN PORTER OUT OF MEMORY (22 Nov 2026; the cross-request cache went in #584, the same
 * fix as Boss OS #517).
 *
 * A Worker isolate has 128 MB and concurrent requests share it. The readers run here in a child Node (the same V8)
 * with --max-old-space-size=128, through every reader the door uses, counting heap AND ArrayBuffers (a parsed file is
 * an ArrayBuffer, outside the heap limit). Sizes are the email as it arrives; Email Routing delivers at most 25 MB.
 *
 * What one 22 MB email costs, measured: its text (22 MB) and its decoded voice note (16 MB) for the whole request,
 * plus one base64 copy (22 MB) while the transcriber reads it. Two used to stack: 115 MB at once without the turn,
 * before which every reader's list held its own base64 copy of every file too (77 MB held by one request).
 * The target is under 96 MB for two at once; measured 60 (22 MB each) and 68 (25 MB each).
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BIG_MAIL_BYTES, oneBigMailAtATime } from "../src/worker/effects/mail";

const child = fileURLToPath(new URL("./fixtures/mailMemoryChild.mjs", import.meta.url));
const run = (...args: string[]) =>
  execFileSync(process.execPath, ["--max-old-space-size=128", "--expose-gc", child, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
const TWO_AT_ONCE_MB = 96;

describe("the mail readers inside a Worker's 128 MB", () => {
  for (const mb of [12, 22, 25]) {
    it(`a ${mb} MB email is read by every reader, holding only its text and its decoded file`, () => {
      const out = run(String(mb));
      const [, , held] = /^ok (\d+) (\d+)$/.exec(out) ?? [];
      expect(held, out).toBeDefined();
      // Its text (mb) plus its decoded file (about 0.73 × mb): 38 MB at 22. A base64 copy per reader list was 77.
      expect(Number(held), `MB one request holds once every reader has run (${out})`).toBeLessThan(mb * 1.73 + 10);
    });
  }

  for (const mb of [22, 25]) {
    it(`two ${mb} MB emails at the same moment stay under ${TWO_AT_ONCE_MB} MB, and each reads only its own words and file`, () => {
      // The child throws (non-zero exit) when either request reads the other's words or voice note.
      const out = run(String(mb), "two");
      const peak = Number(/^ok (\d+)$/.exec(out)?.[1]);
      expect(peak, out).toBeGreaterThan(0);
      expect(peak, "MB at the worst moment of two big emails at once").toBeLessThan(TWO_AT_ONCE_MB);
    });
  }

  it("a finished request leaves nothing of itself behind for the next one (no module-level cache)", () => {
    const out = run("22", "retained");
    const held = Number(/^retained (\d+)$/.exec(out)?.[1]);
    expect(held, out).toBeGreaterThan(0);
    // ~9 MB with nothing kept (the modules themselves); a kept 22 MB parse holds 30+ (its file bytes).
    expect(held, "MB still held after the request ended and three gc()").toBeLessThan(15);
  });
});

describe("one big email at a time in an isolate", () => {
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("a big email waits for the big one before it; small mail never waits", async () => {
    const log: string[] = [];
    let open!: () => void;
    const first = oneBigMailAtATime(BIG_MAIL_BYTES, async () => {
      log.push("big 1 starts");
      await new Promise<void>((r) => (open = r));
      log.push("big 1 ends");
    });
    const second = oneBigMailAtATime(BIG_MAIL_BYTES * 5, async () => void log.push("big 2 starts"));
    await oneBigMailAtATime(BIG_MAIL_BYTES - 1, async () => void log.push("small reads at once"));
    await later(20);
    expect(log).toEqual(["big 1 starts", "small reads at once"]);
    open();
    await Promise.all([first, second]);
    expect(log).toEqual(["big 1 starts", "small reads at once", "big 1 ends", "big 2 starts"]);
  });

  it("a big email behind one that hangs is still read once the wait runs out, and one that throws frees the turn", async () => {
    const hung = oneBigMailAtATime(BIG_MAIL_BYTES, () => new Promise<void>(() => undefined), 50);
    const started = Date.now();
    await expect(oneBigMailAtATime(BIG_MAIL_BYTES, async () => "read", 50)).resolves.toBe("read");
    expect(Date.now() - started, "it waited for the hung one, but only as long as the bound").toBeLessThan(2_000);
    void hung;
    const thrown = oneBigMailAtATime(BIG_MAIL_BYTES * 2, async () => {
      throw new Error("the door threw");
    });
    await expect(thrown).rejects.toThrow("the door threw");
  });

  it("the next email after one that threw is read without waiting", async () => {
    await expect(oneBigMailAtATime(BIG_MAIL_BYTES * 2, async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    const started = Date.now();
    await expect(oneBigMailAtATime(BIG_MAIL_BYTES * 2, async () => "read", 5_000)).resolves.toBe("read");
    expect(Date.now() - started, "a door that threw never holds the turn").toBeLessThan(1_000);
  });
});
