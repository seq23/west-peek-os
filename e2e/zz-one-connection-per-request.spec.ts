import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

/**
 * INSIDE A REAL JOURNEY WORKER, the `request` fixture opens one TCP connection per request.
 *
 * `tests/e2e-one-connection-per-request.test.ts` proves the module works; this proves the config
 * that loads it is what the journeys actually run under — the worker process is where p7's
 * "socket hang up" happened (23 Sep 2026), and a guard installed only in the runner would pass that
 * test and change nothing here. The server keeps every socket open and never answers
 * `Connection: close`, which is what `workerd` does; a pooled socket would be reused.
 *
 * DELIBERATELY NOT IMPORTED HERE: `support/one-connection-per-request.ts` installs itself on import,
 * so importing it from this spec would make the spec pass with the config's import deleted. Its
 * marker is read off Node's prototype instead.
 */
const INSTALLED = Symbol.for("wpos.e2e.oneConnectionPerRequest");
test("the journeys' request fixture never reuses a socket", async ({ request }) => {
  expect((http.Agent.prototype as unknown as Record<symbol, unknown>)[INSTALLED], "playwright.config.ts must load the transport guard in every worker").toBe(true);

  let connections = 0;
  const server = http.createServer((req, res) => {
    res.shouldKeepAlive = true;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  server.keepAliveTimeout = 60_000;
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const statuses: number[] = [];
    statuses.push((await request.get(`${base}/one`)).status());
    statuses.push((await request.post(`${base}/two`, { data: { n: 2 } })).status());
    statuses.push((await request.get(`${base}/three`)).status());
    expect(connections, "three requests, three connections — a reused socket is the p7 race").toBe(3);
    expect(statuses).toEqual([200, 200, 200]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
