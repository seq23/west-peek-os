/**
 * HER MAILBOX, FAKED FOR READS (13 Nov 2026; services/tlcBrandThread.ts). A brand answer is sent only once its
 * conversation is found in her mailbox, so a test that sends one needs a mailbox to ask. This one holds every
 * message it is asked about by Message-ID (`rfc822msgid:<id>`), each in its own conversation `thread-of-<id>` (letters, digits and _ only, as Gmail's ids are),
 * plus whatever a test adds for other searches. With `sentMail`, her Sent mail also holds the first email of every
 * fixture brand (a follow-up is a reply on that email's conversation): any `in:sent to:<address>` search and any
 * read by Gmail id finds one. Returns undefined for a URL that is not a Gmail read.
 */
export interface FakeMessage { id: string; threadId: string; messageId: string; references?: string[]; subject?: string }

const plain = (v: string) => v.replace(/[^a-zA-Z0-9]/g, "_");

export function gmailReadStub(opts: { search?: (query: string) => FakeMessage | null | undefined; byId?: (id: string) => FakeMessage | null | undefined; missing?: (messageId: string) => boolean; sentMail?: boolean } = {}) {
  const held = new Map<string, FakeMessage>();
  const queries: string[] = [];
  const respond = (url: string): Response | undefined => {
    const u = new URL(url);
    if (u.hostname !== "gmail.googleapis.com" || !u.pathname.startsWith("/gmail/v1/users/me/messages") || u.pathname.endsWith("/send")) return undefined;
    const q = u.searchParams.get("q");
    if (q !== null) {
      queries.push(q);
      const mid = /^rfc822msgid:(.+)$/.exec(q)?.[1];
      const to = /^in:sent to:(.+)$/.exec(q)?.[1];
      const found = opts.search?.(q)
        ?? (mid && !opts.missing?.(mid) ? { id: `g-${mid}`, threadId: `thread-of-${plain(mid)}`, messageId: mid, subject: "Re: fixture" } : null)
        ?? (to && opts.sentMail ? { id: `sent-${plain(to)}`, threadId: `thread-to-${plain(to)}`, messageId: `first-${plain(to)}@mail.gmail.example`, subject: "The first email" } : null);
      if (found) held.set(found.id, found);
      return Response.json(found ? { messages: [{ id: found.id }] } : {});
    }
    const id = decodeURIComponent(u.pathname.split("/").pop()!);
    const m = held.get(id) ?? opts.byId?.(id) ?? (opts.sentMail ? { id, threadId: `thread-of-${plain(id)}`, messageId: `${plain(id)}@mail.gmail.example`, subject: "The first email" } : null);
    if (!m) return new Response("{}", { status: 404 });
    return Response.json({ id: m.id, threadId: m.threadId, payload: { headers: [{ name: "Message-ID", value: `<${m.messageId}>` }, { name: "References", value: (m.references ?? []).map((r) => `<${r}>`).join(" ") }, { name: "Subject", value: m.subject ?? "" }] } });
  };
  return Object.assign(respond, { queries });
}
