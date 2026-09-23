import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { request } from "playwright-core";
import { oneConnectionPerRequestInstalled } from "../e2e/support/one-connection-per-request";

/**
 * The journeys' Node-side HTTP opens ONE TCP CONNECTION PER REQUEST.
 *
 * p7-meetings (23 Sep 2026) and p3-governed-work (22 Sep) died on "socket hang up": Playwright's
 * module-global keep-alive agent reused a socket that `workerd` closes at 5000ms idle. The fix is
 * e2e/support/one-connection-per-request.ts, loaded by playwright.config.ts. This counts what the
 * server actually sees, so it cannot be satisfied by a header or a comment — the `connection: close`
 * header that was supposed to prevent this is sent here too, and on its own it let every one of
 * these requests share a single socket.
 *
 * The server behaves the way `workerd` does: it keeps the socket open for a minute and answers
 * WITHOUT `Connection: close` whatever the client asked for (Node's own server would honour the
 * header and hide the defect). A client that pooled at all WOULD reuse here — one connection for
 * all six requests is exactly what the unguarded agent produces.
 */

let server: http.Server;
let base: string;
let connections = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    // What workerd does with a request that says `connection: close`: keep the socket anyway.
    res.shouldKeepAlive = true;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.keepAliveTimeout = 60_000;
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the e2e transport guard", () => {
  it("is installed by importing the module the Playwright config imports", () => {
    expect(oneConnectionPerRequestInstalled()).toBe(true);
  });

  it("gives every Playwright request its own connection, across tests and within one", async () => {
    const before = connections;
    const statuses: number[] = [];
    // Two contexts, like two tests: Playwright's pool is per PROCESS, not per fixture.
    for (let t = 0; t < 2; t += 1) {
      const ctx = await request.newContext({ baseURL: base, extraHTTPHeaders: { connection: "close" } });
      statuses.push((await ctx.get("/api/health")).status());
      statuses.push((await ctx.post("/api/approvals", { data: { n: t } })).status());
      statuses.push((await ctx.get("/api/health")).status());
      await ctx.dispose();
    }
    expect(connections - before, "six requests must open six connections — a reused socket is the p7 race").toBe(6);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200]);
  });
});
