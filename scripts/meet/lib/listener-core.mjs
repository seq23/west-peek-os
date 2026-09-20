/**
 * listener-core.mjs — everything the live listener DECIDES, with nothing it touches.
 *
 * The listener on the owner's Mac (`scripts/meet/live-listener.mjs`) is a loop around one call:
 * `cycle()`. This module is that loop with every side effect injected — the Worker, Google, the
 * browser peer and the clock are handed in — so the whole state machine runs under `--self-test`
 * and under vitest against a fake Meet media server, and what passes there is what runs on the Mac.
 *
 * WHAT ONE CYCLE DOES
 *   1 · heartbeat → the Worker records the device and answers with the calendar meetings in their
 *       window (a firm-hosted Meet, gated on the Worker; a manual meeting is never offered).
 *   2 · for each due meeting with no open session here: read the space (`spaces.get`, the granted
 *       read-only scope). No `activeConference` → not started; nothing else happens.
 *   3 · a running conference → ask the Worker to OPEN a session. The Worker checks the gates and
 *       records consent; a 409 is a named state this loop only logs and backs off from.
 *   4 · mint the Media API token. `scope_missing` → report FAILED with that code (the meeting
 *       reads `meet_live_unavailable_scope`), back off, try again next window — so the room lights
 *       up the moment the grant lands without anybody restarting anything.
 *   5 · create the peer (headless Chromium), take its SDP offer, `connectActiveConference`, hand
 *       the answer back. `preview_missing` / `forbidden` → FAILED with the code and Google's own
 *       message. Joined → report LISTENING; every slice → the Worker's chunk route; the
 *       conference ending (session-control says so, or the space no longer has an active
 *       conference) → leave, report ENDED.
 *
 * WHAT IT NEVER DOES: choose a model, write a note, talk to any host but Google's and the Worker's,
 * or open a session on a meeting the Worker did not offer. Audio leaves this process in exactly
 * one direction — `POST …/chunk` on the Worker — and `validate:meet-live` reads this file to hold
 * that true.
 */

export const VERSION = "meet-live-1";
/** How often a failed join is retried for the same running conference (the grant may have landed). */
export const RETRY_FAILED_MS = 5 * 60_000;
/** How often the Media API scope is probed for the heartbeat's `media_scope`. */
export const SCOPE_PROBE_EVERY_MS = 5 * 60_000;
/** How often an open session's space is re-read to notice the conference ending without a signal. */
export const SPACE_RECHECK_MS = 60_000;

export const SCOPES = {
  meetRead: "https://www.googleapis.com/auth/meetings.space.readonly",
  meetMedia: "https://www.googleapis.com/auth/meetings.conference.media.readonly",
};

/**
 * @typedef {object} Deps
 * @property {(path: string, body?: unknown, method?: string) => Promise<{status: number, body: any}>} worker
 * @property {{ token(scopes: string[], subject: string|null): Promise<string>, getSpace(token: string, spaceName: string): Promise<any>, connectActiveConference(token: string, spaceName: string, offer: string): Promise<{answer: string}> }} google
 * @property {() => Promise<Peer>} createPeer
 * @property {() => number} now
 * @property {(line: string) => void} log
 * @property {string} deviceId
 * @property {string|null} subject   the impersonated mailbox the peer joins as; null for the service account itself
 */

/**
 * @typedef {object} Peer
 * @property {() => Promise<string>} createOffer
 * @property {(answer: string) => Promise<void>} setAnswer
 * @property {(cb: (slice: {audio_base64: string, content_type: string, seconds: number}) => void) => void} onSlice
 * @property {(cb: (status: {state: 'WAITING'|'JOINED'|'DISCONNECTED', reason?: string}) => void) => void} onStatus
 * @property {() => Promise<void>} leave
 */

export function createListener(/** @type {Deps} */ deps) {
  /** meeting_id → { sessionId, conferenceRecord, spaceName, peer, sequence, lastSpaceCheck, ended } */
  const active = new Map();
  /** meeting_id → { conferenceRecord, at } of the last failed or refused attempt. */
  const backoff = new Map();
  let scopeProbe = { at: 0, media_scope: "UNKNOWN", detail: null };

  async function probeMediaScope() {
    if (deps.now() - scopeProbe.at < SCOPE_PROBE_EVERY_MS) return scopeProbe;
    try {
      await deps.google.token([SCOPES.meetMedia], deps.subject);
      scopeProbe = { at: deps.now(), media_scope: "GRANTED", detail: "the Media API scope mints" };
    } catch (err) {
      scopeProbe = { at: deps.now(), media_scope: err?.code === "scope_missing" ? "SCOPE_MISSING" : "REFUSED", detail: String(err?.message ?? err).slice(0, 400) };
    }
    return scopeProbe;
  }

  async function report(sessionId, state, detail, googleErrorCode) {
    const body = { state, detail: detail ? String(detail).slice(0, 1000) : undefined };
    if (googleErrorCode) body.google_error_code = googleErrorCode;
    return deps.worker(`/api/meet/live/sessions/${sessionId}/report`, body);
  }

  async function endSession(meetingId, reason) {
    const s = active.get(meetingId);
    if (!s || s.ended) return;
    s.ended = true;
    // The last slice is written down before the end is reported.
    if (s.pending) await s.pending;
    try { await s.peer.leave(); } catch { /* the peer is gone either way */ }
    await report(s.sessionId, "ENDED", reason);
    active.delete(meetingId);
    deps.log(`ended ${meetingId}: ${reason}`);
  }

  async function tryJoin(due, spaceName, conferenceRecord) {
    const open = await deps.worker("/api/meet/live/sessions", {
      meeting_id: due.meeting_id, conference_record: conferenceRecord, listener_device: deps.deviceId, join_identity: deps.subject ?? "service-account",
    });
    if (open.status !== 200 && open.status !== 201) {
      backoff.set(due.meeting_id, { conferenceRecord, at: deps.now() });
      deps.log(`not joining ${due.meeting_id}: ${open.body?.error ?? open.status} — ${open.body?.detail ?? ""}${open.body?.meet_live_state ? ` [${open.body.meet_live_state}]` : ""}`);
      return;
    }
    const sessionId = open.body.session.id;
    if (open.body.session.state === "ENDED") return;

    let mediaToken;
    try {
      mediaToken = await deps.google.token([SCOPES.meetRead, SCOPES.meetMedia], deps.subject);
    } catch (err) {
      backoff.set(due.meeting_id, { conferenceRecord, at: deps.now() });
      await report(sessionId, "FAILED", err?.message ?? String(err), err?.code ?? "token");
      deps.log(`cannot join ${due.meeting_id}: ${err?.code ?? "token"} — ${err?.message ?? err}`);
      return;
    }

    const peer = await deps.createPeer();
    const entry = { sessionId, conferenceRecord, spaceName, peer, sequence: 0, lastSpaceCheck: deps.now(), ended: false };
    let answer;
    try {
      const offer = await peer.createOffer();
      answer = (await deps.google.connectActiveConference(mediaToken, spaceName, offer)).answer;
    } catch (err) {
      try { await peer.leave(); } catch { /* nothing to leave */ }
      backoff.set(due.meeting_id, { conferenceRecord, at: deps.now() });
      await report(sessionId, "FAILED", err?.message ?? String(err), err?.code ?? "connect");
      deps.log(`Google refused the join for ${due.meeting_id}: ${err?.code ?? "connect"} — ${err?.message ?? err}`);
      return;
    }
    active.set(due.meeting_id, entry);
    // Slices are posted ONE AT A TIME, in sequence: the record's order is the call's order, and a
    // slow transcription never lets a later minute land before an earlier one.
    let chain = Promise.resolve();
    peer.onSlice((slice) => {
      if (entry.ended) return;
      const seq = entry.sequence++;
      chain = chain.then(async () => {
        const res = await deps.worker(`/api/meet/live/sessions/${sessionId}/chunk`, { ...slice, sequence: seq });
        if (res.status !== 201) deps.log(`slice ${seq} of ${due.meeting_id} not written down: ${res.body?.error ?? res.status} — ${res.body?.detail ?? ""}`);
        else if (res.body?.turns_written) deps.log(`slice ${seq} of ${due.meeting_id}: ${res.body.turns_written} turn(s) [${res.body.engine}]${res.body.draft_rolled ? " · draft rolled" : ""}`);
      }).catch((err) => deps.log(`slice ${seq} of ${due.meeting_id} failed: ${err?.message ?? err}`));
      entry.pending = chain;
    });
    peer.onStatus(async (status) => {
      if (status.state === "JOINED") await report(sessionId, "LISTENING", "Joined the call; Meet announced the participant.");
      else if (status.state === "DISCONNECTED") await endSession(due.meeting_id, `disconnected: ${status.reason ?? "unknown"}`);
    });
    await peer.setAnswer(answer);
    deps.log(`joined ${due.meeting_id} (${conferenceRecord}) as ${deps.subject ?? "the service account"}`);
  }

  async function cycle() {
    const probe = await probeMediaScope();
    const hb = await deps.worker("/api/meet/live/heartbeat", { device_id: deps.deviceId, version: VERSION, media_scope: probe.media_scope, detail: probe.detail ?? undefined });
    if (hb.status !== 200) {
      deps.log(`heartbeat refused: ${hb.status} ${hb.body?.error ?? ""} — ${hb.body?.detail ?? ""}`);
      return { due: 0, active: active.size };
    }
    const due = hb.body.due ?? [];
    let readToken = null;
    const token = async () => (readToken ??= await deps.google.token([SCOPES.meetRead], deps.subject));

    for (const m of due) {
      // THE OWNER'S RULE: an LP or Broker meeting is never joined live (Pre-GA terms). The Worker
      // says so on the row and marks it here; this loop does not even read its space.
      if (m.live_allowed === false) continue;
      const spaceName = `spaces/${m.meeting_code}`;
      const open = active.get(m.meeting_id);
      if (open) {
        if (deps.now() - open.lastSpaceCheck >= SPACE_RECHECK_MS) {
          open.lastSpaceCheck = deps.now();
          let space = null;
          try { space = await deps.google.getSpace(await token(), spaceName); } catch (err) { deps.log(`space re-read failed for ${m.meeting_id}: ${err?.message ?? err}`); }
          if (space && space.activeConference?.conferenceRecord !== open.conferenceRecord) await endSession(m.meeting_id, "the space no longer has this active conference");
        }
        continue;
      }
      let space;
      try {
        space = await deps.google.getSpace(await token(), spaceName);
      } catch (err) {
        deps.log(`space read failed for ${m.meeting_id}: ${err?.code ?? ""} ${err?.message ?? err}`);
        continue;
      }
      const rec = space?.activeConference?.conferenceRecord;
      if (!rec) continue; // not started — the Worker already says so on the meeting row
      const prior = backoff.get(m.meeting_id);
      if (prior && prior.conferenceRecord === rec && deps.now() - prior.at < RETRY_FAILED_MS) continue;
      if (m.session && m.session.conference_record === rec && m.session.state === "ENDED") continue;
      await tryJoin(m, space.name ?? spaceName, rec);
    }

    // A session whose meeting fell out of the window still ends when its conference does.
    for (const [meetingId, s] of active) {
      if (due.some((m) => m.meeting_id === meetingId)) continue;
      let space = null;
      try { space = await deps.google.getSpace(await token(), s.spaceName); } catch { /* checked again next cycle */ }
      if (space && space.activeConference?.conferenceRecord !== s.conferenceRecord) await endSession(meetingId, "the space no longer has this active conference");
    }
    return { due: due.length, active: active.size, media_scope: probe.media_scope };
  }

  async function shutdown(reason = "listener stopping") {
    for (const meetingId of [...active.keys()]) await endSession(meetingId, reason);
  }

  return { cycle, shutdown, active };
}

// ── Self-test: the whole machine against fakes ──────────────────────────────

export async function selfTest() {
  const log = [];
  const calls = [];
  let now = 1_000_000;
  const conference = { record: null };
  const google = {
    granted: new Set([SCOPES.meetRead]),
    previewMissing: false,
    async token(scopes, subject) {
      calls.push(["token", scopes.join(" "), subject]);
      if (subject && scopes.some((s) => !this.granted.has(s))) throw Object.assign(new Error(`the delegation grant does not cover ${scopes.join(" ")}`), { code: "scope_missing" });
      return "tok";
    },
    async getSpace(_t, name) {
      calls.push(["getSpace", name]);
      return { name, meetingCode: name.slice(7), ...(conference.record ? { activeConference: { conferenceRecord: conference.record } } : {}) };
    },
    async connectActiveConference(_t, name, offer) {
      calls.push(["connect", name, offer]);
      if (this.previewMissing) throw Object.assign(new Error('Google answers "Method not found" on v2beta'), { code: "preview_missing" });
      return { answer: "v=0 answer" };
    },
  };
  const worker = { sessions: new Map(), policyOff: false, reports: [], chunks: [] };
  const workerCall = async (path, body) => {
    calls.push(["worker", path, body]);
    if (path === "/api/meet/live/heartbeat") return { status: 200, body: { due: [
      { meeting_id: "mtg_1", meeting_code: "abc-defg-hij", live_allowed: true, session: worker.sessions.get("mtg_1") ?? null },
      { meeting_id: "mtg_lp", meeting_code: "lpp-lppp-lpp", live_allowed: false, meet_live_state: "meet_live_off_lp_policy", session: null },
    ] } };
    if (path === "/api/meet/live/sessions") {
      if (worker.policyOff) return { status: 409, body: { error: "recording_policy_off", meet_live_state: "meet_live_unavailable_policy", detail: "off" } };
      const s = { id: "mls_1", state: "JOINING", conference_record: body.conference_record };
      worker.sessions.set(body.meeting_id, s);
      return { status: 201, body: { session: s } };
    }
    if (path.endsWith("/report")) { worker.reports.push(body); const s = worker.sessions.get("mtg_1"); if (s) s.state = body.state === "FAILED" ? "FAILED" : body.state; return { status: 200, body: {} }; }
    if (path.endsWith("/chunk")) { worker.chunks.push(body); return { status: 201, body: { turns_written: 1, engine: "NOVA3" } }; }
    return { status: 404, body: {} };
  };
  const peers = [];
  const createPeer = async () => {
    const p = { left: false, slice: null, status: null, async createOffer() { return "v=0 offer"; }, async setAnswer(a) { this.answer = a; setTimeout(() => this.status?.({ state: "JOINED" }), 0); }, onSlice(cb) { this.slice = cb; }, onStatus(cb) { this.status = cb; }, async leave() { this.left = true; } };
    peers.push(p);
    return p;
  };
  const listener = createListener({ worker: workerCall, google, createPeer, now: () => now, log: (l) => log.push(l), deviceId: "mac-test", subject: "sequoia@westpeek.ventures" });
  const assert = (cond, msg) => { if (!cond) throw new Error(`listener self-test: ${msg}\n${log.join("\n")}`); };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  // 1 · not started: heartbeat, one space read, no session, no media token.
  await listener.cycle();
  assert(!calls.some((c) => c[0] === "worker" && c[1] === "/api/meet/live/sessions"), "a conference that has not started must not open a session");
  assert(!calls.some((c) => c[0] === "token" && c[1].includes(SCOPES.meetMedia) && c[1].includes(SCOPES.meetRead)), "no join token before a conference runs");

  // 2 · started, scope missing: session opened on the Worker (the gates ran), join FAILED scope_missing, no peer created.
  conference.record = "conferenceRecords/c1";
  await listener.cycle();
  assert(worker.reports.length === 1 && worker.reports[0].state === "FAILED" && worker.reports[0].google_error_code === "scope_missing", `scope missing must be reported as FAILED/scope_missing, got ${JSON.stringify(worker.reports)}`);
  assert(peers.length === 0, "no peer is created without the media scope");
  // and it is NOT retried within the backoff window
  const before = worker.reports.length;
  await listener.cycle();
  assert(worker.reports.length === before, "a failed join is not retried inside the backoff window");
  // but is retried once the window passes — the grant may have landed
  now += RETRY_FAILED_MS + 1;
  await listener.cycle();
  assert(worker.reports.length === before + 1, "a failed join is retried after the backoff window");

  // 3 · grant lands, preview missing: connect refused with the code; peer left.
  google.granted.add(SCOPES.meetMedia);
  google.previewMissing = true;
  now += RETRY_FAILED_MS + 1;
  await listener.cycle();
  const last = worker.reports[worker.reports.length - 1];
  assert(last.state === "FAILED" && last.google_error_code === "preview_missing", `preview missing must be reported by code, got ${JSON.stringify(last)}`);
  assert(peers.length === 1 && peers[0].left, "a refused connect leaves the peer it created");

  // 4 · everything granted: join → LISTENING → slices → conference ends → ENDED, peer left.
  google.previewMissing = false;
  now += RETRY_FAILED_MS + 1;
  await listener.cycle();
  await tick();
  assert(peers.length === 2 && peers[1].answer === "v=0 answer", "the SDP answer reaches the peer");
  assert(worker.reports[worker.reports.length - 1].state === "LISTENING", "JOINED becomes a LISTENING report");
  assert(listener.active.size === 1, "one active session");
  peers[1].slice({ audio_base64: "QUJD", content_type: "audio/webm", seconds: 60 });
  peers[1].slice({ audio_base64: "REVG", content_type: "audio/webm", seconds: 60 });
  await tick();
  assert(worker.chunks.length === 2 && worker.chunks[0].sequence === 0 && worker.chunks[1].sequence === 1, "slices are posted in sequence to the Worker's chunk route");
  assert(worker.chunks.every((c) => c.audio_base64 && c.seconds === 60), "each slice carries its audio and its seconds");
  conference.record = null;
  now += SPACE_RECHECK_MS + 1;
  await listener.cycle();
  assert(peers[1].left, "the conference ending leaves the peer");
  assert(worker.reports[worker.reports.length - 1].state === "ENDED", "the conference ending is reported ENDED");
  assert(listener.active.size === 0, "no active session after the end");
  peers[1].slice({ audio_base64: "R0hJ", content_type: "audio/webm", seconds: 60 });
  await tick();
  assert(worker.chunks.length === 2, "a slice after the end is dropped, never posted");

  // 5 · the Worker refuses (policy off): no token minted for media, no peer, the refusal logged with its state.
  worker.policyOff = true;
  worker.sessions.clear();
  conference.record = "conferenceRecords/c2";
  const tokensBefore = calls.filter((c) => c[0] === "token" && c[1].includes(SCOPES.meetMedia)).length;
  await listener.cycle();
  assert(calls.filter((c) => c[0] === "token" && c[1].includes(SCOPES.meetMedia)).length === tokensBefore, "a Worker refusal means no media token is minted");
  assert(peers.length === 2, "a Worker refusal creates no peer");
  assert(log.some((l) => /meet_live_unavailable_policy/.test(l)), "the refusal is logged with the meeting state");

  // 6 · the LP meeting: offered with live_allowed=false every cycle, never read, never joined.
  assert(!calls.some((c) => c[0] === "getSpace" && /lpp-lppp-lpp/.test(c[1])), "an LP meeting's space is never read");
  assert(!calls.some((c) => c[0] === "worker" && c[1] === "/api/meet/live/sessions" && c[2]?.meeting_id === "mtg_lp"), "an LP meeting never gets a session request");

  // 7 · every host this loop spoke to is Google's or the Worker's — asserted on the call log.
  assert(calls.every((c) => c[0] === "worker" || c[0] === "token" || c[0] === "getSpace" || c[0] === "connect"), "no other kind of call exists");

  return { calls: calls.length, reports: worker.reports.length, chunks: worker.chunks.length };
}
