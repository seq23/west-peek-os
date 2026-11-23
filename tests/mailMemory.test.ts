/**
 * TWO BIG EMAILS AT ONCE NEVER RUN PORTER OUT OF MEMORY (22 Nov 2026, the same fix as Boss OS #517).
 *
 * A Worker isolate has 128 MB and concurrent requests share it. `effects/mail.ts` used to keep the last parsed message
 * (up to 25 MB of file bytes) in module memory across requests, so a second big email arrived into an isolate already
 * holding the first. The readers run here in a child Node (the same V8) capped at 128 MB, through every reader the door
 * uses, holding the one parse until the last reader is done.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("./fixtures/mailMemoryChild.mjs", import.meta.url));
const run = (...args: string[]) =>
  execFileSync(process.execPath, ["--max-old-space-size=128", "--expose-gc", child, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();

describe("the mail readers inside a Worker's 128 MB", () => {
  for (const mb of [12, 22]) {
    it(`a ${mb} MB voice note is read by every reader within the heap a Worker has`, () => {
      expect(run(String(mb))).toMatch(/^ok \d+$/);
    });
  }

  it("two 22 MB messages read at the same moment both fit, and each request reads only its own words and file", () => {
    // The child throws (non-zero exit) when either request reads the other's words or voice note.
    expect(run("22", "two")).toMatch(/^ok \d+$/);
  });

  it("a finished request leaves nothing of itself behind for the next one (no module-level cache)", () => {
    const out = run("22", "retained");
    const held = Number(/^retained (\d+)$/.exec(out)?.[1]);
    expect(held, out).toBeGreaterThan(0);
    // ~9 MB with nothing kept (the modules themselves); a kept 22 MB parse holds 30+ (its file bytes).
    expect(held, "MB still held after the request ended and three gc()").toBeLessThan(15);
  });
});
