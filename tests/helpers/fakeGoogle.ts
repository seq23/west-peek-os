import { generateKeyPairSync } from "node:crypto";

/**
 * A stand-in for Google, for the Meet integration tests.
 *
 * Answers the token endpoint, Calendar v3 events, the iCal feed, Meet REST v2 and Pub/Sub with
 * whatever the test loaded into it, and records every request so a test can assert what was
 * asked. The service-account JSON it hands out carries a REAL RSA key generated per process, so
 * the Worker's JWT signing path runs for real; only the network is faked.
 */

export interface FakeConference {
  name: string; // conferenceRecords/x
  space: string; // spaces/y
  meetingCode: string;
  startTime: string;
  endTime: string | null;
  participants: Array<{ name: string; displayName: string; kind: "SIGNED_IN" | "ANONYMOUS" | "PHONE" }>;
  transcript: null | { name: string; state: "STARTED" | "ENDED" | "FILE_GENERATED"; document: string | null; entries: Array<{ participant: string | null; text: string; startTime: string }> };
  recording: null | { state: "FILE_GENERATED" | "ENDED"; file: string | null };
}

export interface FakeGoogle {
  serviceAccountJson: string;
  calendarItems: Array<Record<string, unknown>>;
  ics: string | null;
  conferences: FakeConference[];
  pubsubMessages: Array<{ ackId: string; messageId: string; attributes: Record<string, string>; data: Record<string, unknown> }>;
  subscriptions: Array<Record<string, unknown>>;
  /** Scopes the fake delegation grant covers. A token request outside it is refused like Google does. */
  grantedScopes: Set<string>;
  /** Make the Calendar API fail (to prove the iCal door). */
  calendarApiDown: boolean;
  requests: Array<{ method: string; url: string }>;
  acked: string[];
  fetch: typeof fetch;
}

export function makeFakeGoogle(): FakeGoogle {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const g: FakeGoogle = {
    serviceAccountJson: JSON.stringify({ type: "service_account", client_email: "fake-bot@example.iam.gserviceaccount.com", private_key: pem, client_id: "1" }),
    calendarItems: [],
    ics: null,
    conferences: [],
    pubsubMessages: [],
    subscriptions: [],
    grantedScopes: new Set([
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/meetings.space.readonly",
      "https://www.googleapis.com/auth/meetings.space.created",
      "https://www.googleapis.com/auth/pubsub",
    ]),
    calendarApiDown: false,
    requests: [],
    acked: [],
    fetch: null as unknown as typeof fetch,
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  g.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    g.requests.push({ method, url });
    const u = new URL(url);

    if (u.hostname === "oauth2.googleapis.com" && u.pathname === "/token") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      const assertion = form.get("assertion") ?? "";
      const claims = JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString("utf8")) as { scope: string; sub?: string };
      const scopes = claims.scope.split(" ");
      // Impersonation requires every scope to be in the delegation grant; the SA's own identity does not.
      if (claims.sub && scopes.some((s) => !g.grantedScopes.has(s))) {
        return json({ error: "unauthorized_client", error_description: "Client is unauthorized to retrieve access tokens using this method, or client not authorized for any of the scopes requested." }, 401);
      }
      return json({ access_token: `tok_${claims.sub ?? "sa"}_${scopes.length}`, expires_in: 3600, token_type: "Bearer" });
    }
    if (u.hostname === "www.googleapis.com" && u.pathname === "/calendar/v3/calendars/primary/events") {
      if (g.calendarApiDown) return json({ error: { code: 503, message: "down" } }, 503);
      return json({ items: g.calendarItems });
    }
    if (u.hostname === "calendar.google.com") {
      return g.ics ? new Response(g.ics, { status: 200, headers: { "content-type": "text/calendar" } }) : new Response("nope", { status: 404 });
    }
    if (u.hostname === "meet.googleapis.com") {
      const p = u.pathname.replace(/^\/v2\//, "");
      if (p === "conferenceRecords") {
        const filter = u.searchParams.get("filter") ?? "";
        const code = /space\.meeting_code = "([^"]+)"/.exec(filter)?.[1];
        const list = g.conferences.filter((c) => !code || c.meetingCode === code);
        return json({ conferenceRecords: list.map((c) => ({ name: c.name, space: c.space, startTime: c.startTime, endTime: c.endTime ?? undefined })) });
      }
      const m = /^(conferenceRecords\/[^/]+)(?:\/(participants|transcripts|recordings))?(?:\/([^/]+)\/entries)?$/.exec(p);
      if (m) {
        const c = g.conferences.find((x) => x.name === m[1]);
        if (!c) return json({ error: { code: 404, status: "NOT_FOUND", message: "no such conference" } }, 404);
        if (!m[2]) return json({ name: c.name, space: c.space, startTime: c.startTime, endTime: c.endTime ?? undefined });
        if (m[2] === "participants") {
          return json({ participants: c.participants.map((x) => ({ name: x.name, ...(x.kind === "SIGNED_IN" ? { signedinUser: { user: `users/${x.name.split("/").pop()}`, displayName: x.displayName } } : x.kind === "PHONE" ? { phoneUser: { displayName: x.displayName } } : { anonymousUser: { displayName: x.displayName } }) })) });
        }
        if (m[2] === "recordings") return json({ recordings: c.recording ? [{ name: `${c.name}/recordings/r1`, state: c.recording.state, driveDestination: c.recording.file ? { file: c.recording.file, exportUri: `https://drive.google.com/file/d/${c.recording.file}` } : undefined }] : [] });
        if (m[2] === "transcripts" && m[3]) {
          if (!c.transcript) return json({ transcriptEntries: [] });
          return json({ transcriptEntries: c.transcript.entries.map((e, i) => ({ name: `${c.transcript!.name}/entries/e${i}`, participant: e.participant ?? undefined, text: e.text, languageCode: "en-US", startTime: e.startTime, endTime: e.startTime })) });
        }
        if (m[2] === "transcripts") return json({ transcripts: c.transcript ? [{ name: c.transcript.name, state: c.transcript.state, docsDestination: c.transcript.document ? { document: c.transcript.document, exportUri: `https://docs.google.com/document/d/${c.transcript.document}` } : undefined }] : [] });
      }
      const sp = /^spaces\/(.+)$/.exec(p);
      if (sp) {
        const c = g.conferences.find((x) => x.space === `spaces/${sp[1]}` || x.meetingCode === sp[1]);
        return c ? json({ name: c.space, meetingCode: c.meetingCode, meetingUri: `https://meet.google.com/${c.meetingCode}` }) : json({ error: { code: 403, status: "PERMISSION_DENIED", message: "Permission denied on resource Space (or it might not exist)" } }, 403);
      }
    }
    if (u.hostname === "workspaceevents.googleapis.com") {
      if (method === "GET") return json({ subscriptions: g.subscriptions });
      if (method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        const sub = { name: `subscriptions/sub_${g.subscriptions.length + 1}`, ...body, state: "ACTIVE", expireTime: new Date(Date.now() + 24 * 3_600_000).toISOString() };
        g.subscriptions.push(sub);
        return json({ name: "operations/op1", done: true, response: sub });
      }
      if (method === "PATCH") {
        const name = u.pathname.replace(/^\/v1\//, "");
        const sub = g.subscriptions.find((s) => s.name === name);
        if (sub) sub.expireTime = new Date(Date.now() + 24 * 3_600_000).toISOString();
        return json({ name: "operations/op2", done: true, response: sub ?? { name } });
      }
    }
    if (u.hostname === "pubsub.googleapis.com") {
      if (u.pathname.endsWith(":pull")) {
        const msgs = g.pubsubMessages.splice(0, 50);
        return json({ receivedMessages: msgs.map((m) => ({ ackId: m.ackId, message: { messageId: m.messageId, attributes: m.attributes, data: Buffer.from(JSON.stringify(m.data)).toString("base64"), publishTime: new Date().toISOString() } })) });
      }
      if (u.pathname.endsWith(":acknowledge")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { ackIds?: string[] };
        g.acked.push(...(body.ackIds ?? []));
        return json({});
      }
    }
    return json({ error: { code: 404, message: `fake google has no route for ${method} ${url}` } }, 404);
  }) as typeof fetch;
  return g;
}

/** A Calendar API item with a Meet link. */
export function calendarItem(over: { id: string; summary?: string; start: string; end?: string; code?: string | null; attendees?: Array<{ email: string; displayName?: string; self?: boolean }>; organizer?: string; status?: string }): Record<string, unknown> {
  const code = over.code === undefined ? "abc-defg-hjk" : over.code;
  return {
    id: over.id,
    summary: over.summary ?? "A call",
    status: over.status ?? "confirmed",
    start: { dateTime: over.start },
    end: { dateTime: over.end ?? new Date(Date.parse(over.start) + 30 * 60_000).toISOString() },
    organizer: { email: over.organizer ?? "sequoia@westpeek.ventures" },
    attendees: over.attendees ?? [{ email: "sequoia@westpeek.ventures", self: true }],
    htmlLink: `https://www.google.com/calendar/event?eid=${over.id}`,
    ...(code
      ? { hangoutLink: `https://meet.google.com/${code}`, conferenceData: { conferenceId: code, conferenceSolution: { key: { type: "hangoutsMeet" } }, entryPoints: [{ entryPointType: "video", uri: `https://meet.google.com/${code}` }] } }
      : {}),
  };
}
