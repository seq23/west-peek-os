import { forcePhraseIn, preApprovalIn } from "../work/approvalReply";

/**
 * Reading a web-property change at the door (20 Sep 2026, Plan A).
 *
 * A partner emails os@joinwestpeek.com with a Google Drive folder and instructions: "update the
 * ventures site with this package", "new team page, assets in the folder". Porter marks the card
 * WEB_PROPERTY_CHANGE at the door, records the folder and the property, and the card is handed to
 * Porter himself (Systems & Intake Operator — `systems_data_integration` and
 * `source_of_truth_resolver` are already on his charter; no new seat).
 *
 * PURE AND DETERMINISTIC, like `blogHelp.ts` beside it, and for the same reason: the reading is
 * written on the card once and worked from for three attempts, so it must read the same on
 * Tuesday as on Monday. Only the CONTENT is read here, and only to choose a runner and record the
 * folder; authority came from the authenticated address and nothing in the text can widen it.
 *
 * TWO FACTS ARE NEEDED, and both are recorded separately:
 *
 *   · A DRIVE FOLDER LINK. Any `drive.google.com/…/folders/<id>` link is kept on the card
 *     (`request_json.drive_folder_url`) whatever else the email says — the brief's "intake learns
 *     Drive". A file link (`/file/d/<id>`) is kept too, marked as such; the lane needs a folder.
 *   · A PROPERTY. One of the firm's web properties named by host, or by the words a partner
 *     would use for it. The property names the repo (`WEB_PROPERTIES`); the email never does.
 *
 * Folder + property → WEB_PROPERTY_CHANGE. Folder alone → an ordinary assignment carrying the
 * link, so nothing is lost; it is simply not sped up.
 */

export interface WebProperty {
  /** The host a partner would name. */
  host: string;
  /** The checkout under ~/GitHub on her Mac. */
  repo: string;
  /** The site directory inside that repo, for the prompt. */
  site: string;
  /** Words that name it without the host. */
  words: readonly string[];
}

/**
 * The firm's public web properties and where each is built. Three sites, one repo, three Pages
 * projects — read from that repo's RUNBOOK.md on 20 Sep 2026. Adding a property is one row here
 * and a RUNBOOK.md in its repo; the PLAN phase blocks without the RUNBOOK.
 */
export const WEB_PROPERTIES: readonly WebProperty[] = [
  { host: "westpeek.ventures", repo: "join-west-peek-main", site: "sites/ventures", words: ["ventures site", "ventures website", "ventures page", "the fund site", "the fund website", "west peek ventures site"] },
  { host: "westpeekproductions.com", repo: "join-west-peek-main", site: "sites/productions", words: ["productions site", "productions website", "agency site", "agency website", "west peek productions site"] },
  { host: "joinwestpeek.com", repo: "join-west-peek-main", site: "sites/community", words: ["community site", "community website", "join west peek site", "the community page"] },
];

export interface WebPropertyAsk {
  drive_folder_id: string | null;
  drive_folder_url: string | null;
  /** A Drive FILE link when that is what was sent — recorded so the block can say "send the folder". */
  drive_file_url: string | null;
  property_host: string | null;
  target_repo: string | null;
  site: string | null;
  /** The request as written, so the runner works from the partner's own words. */
  ask: string;
  /** 21 Sep 2026: the pre-approval phrase in the partner's OWN request text, or null. Read at the door only. */
  pre_approval?: string | null;
  /** A force phrase in the same request ("approved to production", …), or null. */
  force?: string | null;
}

const FOLDER_LINK = /https?:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?(?:mobile\/)?folders\/|open\?id=)([A-Za-z0-9_-]{10,})[^\s>)"']*/i;
const FOLDER_LINK_ALL = /https?:\/\/drive\.google\.com\/(?:drive\/(?:u\/\d+\/)?(?:mobile\/)?folders\/|open\?id=)([A-Za-z0-9_-]{10,})[^\s>)"']*/gi;
const FILE_LINK = /https?:\/\/(?:drive|docs)\.google\.com\/(?:file\/d\/|document\/d\/|spreadsheets\/d\/|presentation\/d\/)([A-Za-z0-9_-]{10,})[^\s>)"']*/i;

/** Every Drive folder link in a text, first one first. Exported for the intake path that records them all. */
export function driveFolderLinks(text: string): Array<{ id: string; url: string }> {
  const out: Array<{ id: string; url: string }> = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(FOLDER_LINK_ALL)) {
    const id = m[1]!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url: m[0]!.replace(/[.,;:]+$/, "") });
  }
  return out;
}

/** Which property the text names, or null. Host first (exact), then the plain words. */
export function propertyIn(text: string): WebProperty | null {
  const lower = text.toLowerCase();
  for (const p of WEB_PROPERTIES) if (lower.includes(p.host)) return p;
  for (const p of WEB_PROPERTIES) for (const w of p.words) if (lower.includes(w)) return p;
  return null;
}

/**
 * Null when there is no Drive link at all. Otherwise what was found — the caller decides the
 * kind from `target_repo` being set.
 */
export function parseWebPropertyAsk(subject: string, body: string): WebPropertyAsk | null {
  const text = `${subject}\n${body}`.replace(/\r/g, "");
  // Only what the partner WROTE: a quoted original or a signature must not pre-approve anything.
  const written = writtenPart(text);
  const folder = FOLDER_LINK.exec(text);
  const file = FILE_LINK.exec(text);
  if (!folder && !file) return null;
  const property = propertyIn(text);
  return {
    drive_folder_id: folder?.[1] ?? null,
    drive_folder_url: folder ? folder[0]!.replace(/[.,;:]+$/, "") : null,
    drive_file_url: file ? file[0]!.replace(/[.,;:]+$/, "") : null,
    property_host: property?.host ?? null,
    target_repo: property?.repo ?? null,
    site: property?.site ?? null,
    ask: body.trim().slice(0, 6000) || subject.trim(),
    pre_approval: preApprovalIn(written),
    force: forcePhraseIn(written),
  };
}

/** The lines above any quoted original ("> …" or "On … wrote:"). */
function writtenPart(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex((l) => /^\s*>/.test(l) || /^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()));
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n");
}

/** Is this a change Porter runs on the Mac? A folder and a property, both. */
export function isWebPropertyChange(ask: WebPropertyAsk | null): ask is WebPropertyAsk & { drive_folder_id: string; target_repo: string } {
  return Boolean(ask && ask.drive_folder_id && ask.target_repo);
}

/** Read the stored `request_json` back. Null when it is not one of ours. */
export function readWebPropertyAsk(json: string | null | undefined): WebPropertyAsk | null {
  if (!json) return null;
  try {
    const p = JSON.parse(json) as Partial<WebPropertyAsk>;
    if (typeof p !== "object" || p === null) return null;
    return {
      drive_folder_id: p.drive_folder_id ?? null,
      drive_folder_url: p.drive_folder_url ?? null,
      drive_file_url: p.drive_file_url ?? null,
      property_host: p.property_host ?? null,
      target_repo: p.target_repo ?? null,
      site: p.site ?? null,
      ask: typeof p.ask === "string" ? p.ask : "",
      pre_approval: p.pre_approval ?? null,
      force: p.force ?? null,
    };
  } catch {
    return null;
  }
}
