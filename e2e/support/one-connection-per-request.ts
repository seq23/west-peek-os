import http from "node:http";

/**
 * ONE CONNECTION PER REQUEST, FOR REAL — the journeys' Node-side HTTP never reuses a socket.
 *
 * WHAT FAILED. `p7-meetings.spec.ts:67` (main, 23 Sep 2026, run 35875246305, second pass, 192
 * green) and `p3-governed-work.spec.ts:81` (22 Sep, run 35778902000) both died on
 * `apiRequestContext.post: socket hang up` — and the dev server logged NOTHING for either request,
 * not a status line and not a ProxyWorker error. The request never reached it.
 *
 * WHY. Playwright sends every `request.*` call through ONE module-level `http.Agent` with
 * `keepAlive: true`, shared by every test in the worker process (a new `request` fixture per test
 * does not give a new pool). `workerd` closes an idle client socket after exactly 5000ms. A request
 * that picks a pooled socket at ~5s idle writes into a socket the server is closing, and dies as
 * "socket hang up" / ECONNRESET. Which request lands on that edge is timing — any spec, either pass.
 *
 * WHY THE `connection: close` HEADER DID NOT FIX IT. It was added on 19 Sep for this same failure
 * (p14) and was inert: Node's agent decides reuse from `shouldKeepAlive`, which a request header does
 * not clear, and `workerd` answers without `Connection: close` — so the socket is pooled and reused
 * anyway. Measured against `wrangler dev` 4.131.2: request header `connection: close`, response has
 * no Connection header, `reusedSocket === true` on the next request, server close at 5000ms idle.
 * Reproduced with Playwright's own `request` across two contexts at 4985–5012ms: 2 lost in 30 and
 * 2 in 40 as "socket hang up"/ECONNRESET. With this module installed: 0 transport failures in 80.
 *
 * THE FIX. `Agent#keepSocketAlive` is Node's documented hook for "may this socket be pooled"; it
 * answers no, so every socket is closed after its one response and there is no idle socket for the
 * server's clock to race. This runs only in the Playwright processes (imported by
 * playwright.config.ts, which every worker loads) and never in the Worker under test. A localhost
 * connection costs well under a millisecond.
 *
 * NOT COVERED, AND WHY. `wrangler dev` has a second hop with the same 5s race inside it: its
 * ProxyWorker (the port the suite talks to) forwards over pooled connections to the UserWorker.
 * Wrangler retries GET/HEAD there itself; a POST that hits it comes back 500 "Network connection
 * lost" and the server logs "Error inside ProxyWorker … (failed after 1 attempt)" — so, unlike the
 * failure above, it names itself. Measured on main: 3 recovered GETs in 10 CI runs, no POST lost.
 * Closing it means serving the journeys without `wrangler dev`; not done for a race that rare.
 *
 * GUARDED BY `tests/e2e-one-connection-per-request.test.ts` (counts the TCP connections Playwright's
 * `request` actually opens), `e2e/zz-one-connection-per-request.spec.ts` (the same count inside a
 * real journey worker), and `validate:green-means-something` (the config must import this file).
 */

const INSTALLED = Symbol.for("wpos.e2e.oneConnectionPerRequest");

type Marked = { [INSTALLED]?: true };

export function installOneConnectionPerRequest(): void {
  const proto = http.Agent.prototype as http.Agent & Marked;
  if (proto[INSTALLED]) return;
  proto.keepSocketAlive = function keepSocketAlive(): boolean {
    return false;
  };
  proto[INSTALLED] = true;
}

export function oneConnectionPerRequestInstalled(): boolean {
  return (http.Agent.prototype as http.Agent & Marked)[INSTALLED] === true;
}

installOneConnectionPerRequest();
