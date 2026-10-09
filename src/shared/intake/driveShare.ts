/**
 * A GOOGLE DRIVE / DOCS / SHEETS / SLIDES SHARE NOTICE, READ (9 Oct 2026). Pure.
 *
 * When a partner shares a file with os@, Google sends the notice FROM drive-shares-*-noreply@google.com,
 * so the door used to see a stranger and open an "Unclear email" card. The notice is not unclear: Google
 * signs it (DKIM d=google.com, DMARC pass) and the signed headers include `Reply-To`, which Google sets
 * to the person who shared the file. So the sharer is read from Reply-To — only when Google's signature
 * passed and the From is Google's share sender — and confirmed against the Drive API by the caller
 * (`services/driveShares.ts`) before anything is attached in his name.
 */

export interface DriveShareNotice {
  fileId: string;
  url: string;
  title: string;
  /** document | spreadsheet | presentation | folder | file */
  kind: string;
  /** The sharer as Google's signed Reply-To names him; null when Google did not sign it or set none. */
  sharer: string | null;
  /** "Scooter Taylor" from `"Scooter Taylor (via Google Docs)"`. */
  sharerName: string | null;
}

const SHARE_SENDER = /^drive-shares-[a-z0-9-]*noreply@google\.com$/i;
const LINK = /https:\/\/(?:docs|drive)\.google\.com\/(?:(document|spreadsheets|presentation|file)\/d\/|drive\/folders\/|open\?id=)([A-Za-z0-9_-]{20,})[^\s"<>)]*/;

const addr = (h: string | null | undefined) => (/<([^>]+)>/.exec(h ?? "")?.[1] ?? (h ?? "")).trim().toLowerCase();

/** Did Google's own signature pass on this message? Read from the receiving server's verdict. */
export function googleSigned(authenticationResults: string | null | undefined): boolean {
  const a = String(authenticationResults ?? "").toLowerCase();
  return /dkim=pass[^;]*header\.d=google\.com/.test(a) && /dmarc=pass[^;]*header\.from=google\.com/.test(a);
}

export function driveShareNotice(input: { from: string | null; replyTo: string | null; authenticationResults: string | null; subject: string; body: string }): DriveShareNotice | null {
  if (!SHARE_SENDER.test(addr(input.from))) return null;
  const m = LINK.exec(input.body);
  if (!m) return null;
  const kind = m[1] === "document" ? "document" : m[1] === "spreadsheets" ? "spreadsheet" : m[1] === "presentation" ? "presentation" : m[1] === "file" ? "file" : "folder";
  const quoted = /"([^"]+)"/.exec(input.subject)?.[1] ?? null;
  // The body names the item on its own line under "I've shared an item with you:" — the subject is folded and may be cut.
  const lines = input.body.replace(/\r/g, "").split("\n").map((l) => l.trim());
  const at = lines.findIndex((l) => /shared (?:an item|a (?:document|spreadsheet|presentation|folder|file)) with you/i.test(l));
  const fromBody = at >= 0 ? (lines.slice(at + 1).find((l) => l && !/^https?:/.test(l)) ?? null) : null;
  const title = (fromBody ?? quoted ?? input.subject.replace(/^[^:]*shared with you:\s*/i, "")).replace(/^"|"$/g, "").trim();
  const sharerName = /^"?([^"<(]+?)\s*\(via Google/i.exec(input.from ?? "")?.[1]?.trim() ?? null;
  const signed = googleSigned(input.authenticationResults);
  const replyTo = addr(input.replyTo);
  return {
    fileId: m[2]!,
    url: m[0]!.split("?")[0]!.replace(/\/edit$/, "/edit"),
    title: title || "a shared file",
    kind,
    sharer: signed && /@/.test(replyTo) && !/google\.com$/.test(replyTo) ? replyTo : null,
    sharerName,
  };
}
