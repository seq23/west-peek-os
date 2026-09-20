/**
 * meet-media-page.js — the WebRTC peer, in the one runtime Google's reference client supports.
 *
 * Injected into a headless Chromium page by `live-listener.mjs`. It holds the peer connection the
 * Meet Media API needs (three receive-only audio transceivers, the `session-control` and
 * `media-stats` channels the API requires, `media-entries` and `participants` so who is in the
 * call is known) and turns what arrives into slices the listener posts to the Worker.
 *
 * WHAT IT SENDS AND WHERE. Nothing. This page makes no network request of its own: the SDP offer
 * goes OUT through `window.__wpos.createOffer()` to Node, the answer comes IN through
 * `setAnswer()`, and each audio slice goes out through `window.__wposSlice()` — a function Node
 * exposed. Node is the only thing that talks to Google or the Worker, so the network boundary is
 * checked in one place and the service-account key never enters a browser.
 *
 * EACH SLICE IS A COMPLETE RECORDING, exactly as the During face's recorder does it: the
 * MediaRecorder is stopped and restarted every slice rather than timesliced, because a timesliced
 * stream's later fragments are not independently decodable and the Worker transcribes each slice
 * on its own.
 *
 * THE MIX. The three virtual audio streams (the loudest speakers, as Meet assigns them) are mixed
 * into one track through an AudioContext, so one recorder hears the room. Speaker turns come from
 * Nova-3's diarisation on the Worker, by index, never by name — the same rule as Phase C: an
 * attribution this page could guess from CSRCs is one the record must not invent.
 *
 * FIXTURE MODE (`playFixture`) decodes a WAV and feeds it through the same mixer and recorder, so
 * the pipe from this page to the Worker is proved without a Meet — used by the e2e journey and
 * by `--fixture` on the listener.
 */
(() => {
  const NUMBER_OF_AUDIO_STREAMS = 3;
  const state = { pc: null, ctx: null, dest: null, recorder: null, stopped: false, sliceMs: 60_000, channels: {}, participants: new Map() };

  const emitStatus = (s) => { if (typeof window.__wposStatus === "function") window.__wposStatus(s); };
  const emitSlice = (s) => { if (typeof window.__wposSlice === "function") window.__wposSlice(s); };
  const emitLog = (l) => { if (typeof window.__wposLog === "function") window.__wposLog(String(l)); };

  function ensureMixer() {
    if (state.ctx) return;
    state.ctx = new AudioContext({ sampleRate: 48_000 });
    state.dest = state.ctx.createMediaStreamDestination();
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onerror = () => reject(new Error("slice unreadable"));
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
      r.readAsDataURL(blob);
    });
  }

  function startRecording() {
    ensureMixer();
    if (state.recorder) return;
    const stream = state.dest.stream;
    let startedAt = 0;
    const runOne = () => {
      if (state.stopped) return;
      const rec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      const parts = [];
      startedAt = performance.now();
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) parts.push(e.data); };
      rec.onstop = async () => {
        const seconds = Math.round((performance.now() - startedAt) / 100) / 10;
        const blob = new Blob(parts, { type: rec.mimeType || "audio/webm" });
        if (blob.size > 0) {
          try { emitSlice({ audio_base64: await blobToBase64(blob), content_type: rec.mimeType || "audio/webm", seconds }); } catch (err) { emitLog(`slice dropped: ${err.message}`); }
        }
        if (!state.stopped) runOne();
      };
      state.recorder = rec;
      rec.start();
      setTimeout(() => { if (rec.state !== "inactive") rec.stop(); }, state.sliceMs);
    };
    runOne();
  }

  function stopRecording() {
    state.stopped = true;
    if (state.recorder && state.recorder.state !== "inactive") state.recorder.stop();
  }

  function attachTrack(track) {
    ensureMixer();
    // A remote track only produces audio once it is "consumed" — an Audio element with no output
    // is the documented way to make Chromium decode it.
    const ms = new MediaStream([track]);
    const el = new Audio();
    el.srcObject = ms;
    el.muted = true;
    el.play().catch(() => {});
    const src = state.ctx.createMediaStreamSource(ms);
    src.connect(state.dest);
    if (state.ctx.state === "suspended") state.ctx.resume().catch(() => {});
  }

  function channel(name, onMessage) {
    const ch = state.pc.createDataChannel(name, { ordered: true });
    ch.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { emitLog(`${name}: unreadable message`); } };
    ch.onopen = () => emitLog(`${name}: open`);
    state.channels[name] = ch;
    return ch;
  }

  window.__wpos = {
    configure({ sliceMs }) { if (sliceMs) state.sliceMs = sliceMs; },

    /** The SDP offer for a receive-only audio session with the channels the API requires. */
    async createOffer() {
      state.pc = new RTCPeerConnection({ bundlePolicy: "max-bundle", iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      state.pc.ontrack = (e) => { if (e.track && e.track.kind === "audio") { attachTrack(e.track); startRecording(); } };
      state.pc.oniceconnectionstatechange = () => {
        const s = state.pc.iceConnectionState;
        emitLog(`ice: ${s}`);
        if (s === "failed" || s === "closed") emitStatus({ state: "DISCONNECTED", reason: `ice ${s}` });
      };
      for (let i = 0; i < NUMBER_OF_AUDIO_STREAMS; i += 1) state.pc.addTransceiver("audio", { direction: "recvonly" });
      channel("session-control", (json) => {
        const status = json?.resources?.[0]?.sessionStatus;
        if (!status) return;
        if (status.connectionState === "STATE_WAITING") emitStatus({ state: "WAITING" });
        else if (status.connectionState === "STATE_JOINED") emitStatus({ state: "JOINED" });
        else if (status.connectionState === "STATE_DISCONNECTED") emitStatus({ state: "DISCONNECTED", reason: status.disconnectReason ?? "unknown" });
      });
      channel("media-stats", () => {});
      channel("media-entries", () => {});
      channel("participants", (json) => {
        for (const r of json?.resources ?? []) {
          const p = r.participant;
          if (p?.participantId !== undefined) state.participants.set(p.participantId, p.signedInUser?.displayName ?? p.anonymousUser?.displayName ?? p.phoneUser?.displayName ?? "?");
        }
        for (const d of json?.deletedResources ?? []) state.participants.delete(d.id);
        emitLog(`participants: ${state.participants.size}`);
      });
      const offer = await state.pc.createOffer();
      await state.pc.setLocalDescription(offer);
      return state.pc.localDescription.sdp;
    },

    async setAnswer(sdp) {
      await state.pc.setRemoteDescription({ type: "answer", sdp });
    },

    /** Leave politely (the session-control `leave` request), then close. */
    async leave() {
      stopRecording();
      try {
        const ch = state.channels["session-control"];
        if (ch && ch.readyState === "open") ch.send(JSON.stringify({ request: { requestId: 1, leave: {} } }));
      } catch { /* closing anyway */ }
      await new Promise((r) => setTimeout(r, 200));
      try { state.pc?.close(); } catch { /* closed */ }
      try { await state.ctx?.close(); } catch { /* closed */ }
    },

    participants() { return [...state.participants.values()]; },

    /** Fixture mode: a WAV through the same mixer and recorder. Resolves when it has played out. */
    async playFixture(base64Wav) {
      ensureMixer();
      const bin = atob(base64Wav);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const buffer = await state.ctx.decodeAudioData(bytes.buffer);
      const src = state.ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(state.dest);
      startRecording();
      emitStatus({ state: "JOINED" });
      await state.ctx.resume();
      src.start();
      await new Promise((r) => { src.onended = r; });
      return buffer.duration;
    },

    async stop() { stopRecording(); await new Promise((r) => setTimeout(r, 300)); },
  };
})();
