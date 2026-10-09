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
  /** The host a partner would name. For a repo registered without a host, the repo's name until its config says otherwise. */
  host: string;
  /** The checkout under ~/GitHub on her Mac. */
  repo: string;
  /** The site directory inside that repo, for the prompt. */
  site: string;
  /** Words that name it without the host. */
  words: readonly string[];
  /** Other hosts that serve the same site (pitch.joinwestpeek.com and pitchlab.joinwestpeek.com). */
  aliases?: readonly string[];
  /**
   * The Cloudflare Pages subdomain this site's previews live under (23 Sep 2026), CONFIRMED from
   * `wrangler pages project list`. The Mac keeps only preview URLs under it: the community PR's bot
   * comment also carried the ventures and productions previews, and all six went into her email.
   */
  pagesHost?: string;
  /** 0253: owner/name on GitHub, for a clone when the checkout is missing. Seeded rows carry it too. */
  githubRepo?: string;
  /** 0253: 1 for a row the migration seeded — its host → repo binding is immutable from email. */
  seeded?: boolean;
  /** 0253: secret NAMES (never values) the duty may inject for this repo. */
  secretNames?: readonly string[];
  /** 0253: the partner's standing constraints for this repo, from its README/PRD; obeyed in every job without restating. */
  constraints?: readonly string[];
}

/** The folder a site occupies when it IS its repo (no sites/ folder): the whole repo is the scope. */
export const REPO_ROOT_SITE = ".";

/**
 * THE SEED of the firm's web properties and where each is built. The first three share one repo and
 * three Pages projects (read from that repo's RUNBOOK.md on 20 Sep 2026); every other property IS
 * its repo, so its scope is the repo root (`REPO_ROOT_SITE`). Hosts are read from each repo's own
 * deploy config, never guessed (23 Sep 2026).
 *
 * SINCE 0253 (owner, 6 Oct 2026: "'registered west peek repos only' is a problem … any new repo we
 * request is allowed") THE LIST IS OPEN: the Worker reads `web_property_registry` — seeded by
 * migration 0253 from exactly these rows, so nothing changes for them — and a partner's email that
 * names a GitHub repo adds a row (`services/webPropertyRegistry.ts`). Every function below takes the
 * registry it should read; this array is the default so pure callers and the client's dropdown
 * keep working, and `validate:open-repo-door` holds the migration's seed to it. The eight hosts here
 * stay immutable from email (a trigger on the table refuses a re-point); only NEW names are open.
 *
 * SEVERAL HOSTS SHARE A PARENT DOMAIN (dilution.joinwestpeek.com, venturedeals.joinwestpeek.com
 * and the community site joinwestpeek.com). `propertiesIn` matches the most specific host first
 * and consumes what it matched, so a subdomain never also names its parent.
 */
export const WEB_PROPERTIES: readonly WebProperty[] = [
  { host: "westpeek.ventures", repo: "join-west-peek-main", site: "sites/ventures", pagesHost: "west-peek-ventures.pages.dev", words: ["ventures site", "ventures website", "ventures page", "the fund site", "the fund website", "west peek ventures site"] },
  { host: "westpeekproductions.com", repo: "join-west-peek-main", site: "sites/productions", pagesHost: "west-peek-productions.pages.dev", words: ["productions site", "productions website", "agency site", "agency website", "west peek productions site"] },
  { host: "joinwestpeek.com", repo: "join-west-peek-main", site: "sites/community", pagesHost: "west-peek-community.pages.dev", words: ["community site", "community website", "join west peek site", "the community page"] },
  // Hosts below CONFIRMED 23 Sep 2026 from each repo's Cloudflare config (Pages custom domains,
  // the west-peek-live Worker's routes) and a live curl — never guessed.
  { host: "westpeek.live", repo: "westpeek-live", site: REPO_ROOT_SITE, words: ["westpeek live", "west peek live", "westpeek.live", "the live site", "the live website", "the events site", "the events platform", "the event platform"] },
  { host: "pitch.joinwestpeek.com", aliases: ["pitchlab.joinwestpeek.com"], repo: "west-peek-pitch-lab", site: REPO_ROOT_SITE, pagesHost: "west-peek-pitch-lab.pages.dev", words: ["pitch lab", "pitchlab", "the pitch site", "pitch lab site"] },
  { host: "network.joinwestpeek.com", repo: "west-peek-network-os", site: REPO_ROOT_SITE, words: ["network os", "the network app", "network os app"] },
  { host: "venturedeals.joinwestpeek.com", repo: "secondaries", site: REPO_ROOT_SITE, words: ["venture deals", "venturedeals", "secondaries site", "the secondaries page", "secondaries page", "secondaries website"] },
  { host: "dilution.joinwestpeek.com", repo: "founder-dilution-dashboard", site: REPO_ROOT_SITE, words: ["dilution dashboard", "dilution calculator", "the dilution site", "dilution site", "founder dilution"] },
];

/** The seeded rows by name, for readers that mean "what the migration wrote" rather than "what is registered today". */
export const SEEDED_WEB_PROPERTIES = WEB_PROPERTIES;

/** Every registered host, for a sentence that lists them ("Which site? …"). One list, never retyped. */
export function hostsSentence(registry: readonly WebProperty[] = WEB_PROPERTIES): string {
  const hosts = registry.map((p) => p.host);
  return hosts.length > 1 ? `${hosts.slice(0, -1).join(", ")} or ${hosts[hosts.length - 1]}` : hosts.join("");
}

/** The employee an authenticated partner opened the email to ("Hey Porter", "Porter,", "Hi Porter —"), or null. */
export function addresseeIn(written: string): string | null {
  const first = (written ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const m = /^(?:hey|hi|hello|yo|dear|morning|afternoon)?[\s,!]*([A-Z][a-z]+)\b[\s,!:—–-]*/i.exec(first);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  return EMPLOYEE_FIRST_NAMES.has(name) ? name.charAt(0).toUpperCase() + name.slice(1) : null;
}

const EMPLOYEE_FIRST_NAMES = new Set(["porter", "wren", "walker", "wyatt", "parker", "preston", "winter", "pax"]);

/** "the site", "the website", "our site", "the page", "the homepage" — a property named without its host. */
const THE_SITE = /\b(?:the|our|your|my) (?:site|website|web site|homepage|home page|page|landing page)\b/i;

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
  /** 21 Sep 2026: the employee the email was addressed to, when it opened with a name. */
  addressee?: string | null;
  /** 21 Sep 2026: "the site" with no host named — the property is unresolved; the door infers it or asks. */
  property_unresolved?: boolean;
  /** 23 Sep 2026: the preview request in the partner's OWN request text ("preview first", …), or null. */
  preview_first?: string | null;
  /** 23 Sep 2026: sites in SEVERAL repos — one part per repo, one PR each, landed together. Absent for one repo. */
  parts?: WebPropertyPart[];
  /** 0253: repos this email registered at the door (owner/name), so the RECEIVED email can say so. */
  registered?: string[];
  /** 0253 (addendum 3): the deadline in the partner's own words, read at the door. */
  due?: { due_at: string; due_words: string; priority: "URGENT" | "HIGH" } | null;
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
export function propertyIn(text: string, registry: readonly WebProperty[] = WEB_PROPERTIES): WebProperty | null {
  const named = propertiesIn(text, registry);
  if (!named.length) return null;
  // ONE JOB FOR SEVERAL SITES IN ONE REPO (23 Sep 2026, her words: "why can't it open one large
  // job working on both sites?"). The three sites share join-west-peek-main, so "the community
  // site and the agency site" is one plan, one preview and one PR over both folders. `host` and
  // `site` carry every one, comma-joined, in registry order; sitesOf() reads them back.
  const repos = new Set(named.map((p) => p.repo));
  if (repos.size > 1) return null; // several repos is several parts: parseWebPropertyAsk → partsFor
  if (named.length === 1) return named[0]!;
  return {
    host: named.map((p) => p.host).join(", "),
    repo: named[0]!.repo,
    site: named.map((p) => p.site).join(", "),
    words: [],
  };
}

/** The site folders a job may change, from the row's `property_host` (one host or several, comma-joined). */
/** The Pages subdomains the named host(s) preview under ("a, b" for several), [] when none is registered. */
export function pagesHostsOf(propertyHost: string | null | undefined, registry: readonly WebProperty[] = WEB_PROPERTIES): string[] {
  const hosts = String(propertyHost ?? "").split(/,\s*/).map((h) => h.trim().toLowerCase()).filter(Boolean);
  return [...new Set(registry.filter((p) => hosts.includes(p.host) || (p.aliases ?? []).some((a) => hosts.includes(a))).map((p) => p.pagesHost).filter((x): x is string => Boolean(x)))];
}

export function sitesOf(propertyHost: string | null | undefined, registry: readonly WebProperty[] = WEB_PROPERTIES): string[] {
  if (!propertyHost) return [];
  return propertyHost
    .split(",")
    .map((h) => registry.find((p) => p.host === h.trim())?.site)
    .filter((s): s is string => Boolean(s));
}

/**
 * THE SITE SHE ASKED ABOUT, NOT THE FIRST ADDRESS IN THE EMAIL (23 Sep 2026).
 *
 * #144 took the first host string anywhere in the email, checking ventures first, so
 * "sequoia@westpeek.ventures" in a signature or a "reply to" line sent a community-site redesign
 * to the ventures site. The three sites share one repo; the site is the folder that gets changed,
 * so reading it wrong changes the wrong site. Now, in order:
 *   1. what she ASKED FOR: "the community site", "the agency site", "the ventures site" —
 *      the words naming a site as the thing to change;
 *   2. only if no site is named that way, a site ADDRESS she wrote (joinwestpeek.com) — never
 *      one inside an email address, which names a mailbox;
 *   3. otherwise nothing: the door infers from her last site card or asks.
 * Returns every property at the winning level; several in one repo are one job (propertyIn).
 */
export function propertiesIn(text: string, registry: readonly WebProperty[] = WEB_PROPERTIES): WebProperty[] {
  const lower = text.toLowerCase().replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, " ");
  const asked = matchMostSpecificFirst(lower, (p) => p.words, false, registry);
  if (asked.length) return asked;
  return matchMostSpecificFirst(lower, (p) => [p.host, ...(p.aliases ?? [])], true, registry);
}

/**
 * MOST SPECIFIC FIRST, AND WHAT MATCHED IS CONSUMED (23 Sep 2026). "dilution.joinwestpeek.com"
 * contains "joinwestpeek.com", and "the dilution site" must never also be read as the community
 * site. Every phrase of every property is tried longest first; a match blanks its span so a
 * shorter phrase inside it cannot match again. A host must stand alone (not be the tail of a
 * longer host she wrote). Returned in registry order, so a job over several sites reads the same
 * whichever order the email named them in.
 */
function matchMostSpecificFirst(lower: string, phrasesOf: (p: WebProperty) => readonly string[], asHost = false, registry: readonly WebProperty[] = WEB_PROPERTIES): WebProperty[] {
  const phrases = registry.flatMap((p) => phrasesOf(p).map((phrase) => ({ p, phrase: phrase.toLowerCase() }))).sort((a, b) => b.phrase.length - a.phrase.length);
  let rest = lower;
  const hit = new Set<WebProperty>();
  for (const { p, phrase } of phrases) {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = asHost ? new RegExp(`(?<![a-z0-9.-])${esc}(?![a-z0-9-]|\\.[a-z0-9])`, "g") : new RegExp(esc, "g");
    if (re.test(rest)) {
      hit.add(p);
      rest = rest.replace(re, (m) => " ".repeat(m.length));
    }
  }
  return registry.filter((p) => hit.has(p));
}

/** One repo's share of a job over several repos: its sites, and its slice of the request. */
export interface WebPropertyPart {
  repo: string;
  /** The hosts of this repo the job names, comma-joined, registry order (sitesOf reads them back). */
  property_host: string;
  /** The site folders, comma-joined, for the prompt. */
  site: string;
  /** This repo's slice of the request when the email separates them; the whole request otherwise. */
  ask: string;
}

/**
 * ONE JOB OVER SEVERAL REPOS (23 Sep 2026, her words: "there is a world where we ask you to fix
 * something on the community site and westpeek live in the same email"). The named properties are
 * grouped by repo, in registry order; each repo is one PART — one worktree, one PR, one preview —
 * and the job lands all of them or none. Fewer than two repos is not several: [].
 */
export function partsFor(named: readonly WebProperty[], request: string, registry: readonly WebProperty[] = WEB_PROPERTIES): WebPropertyPart[] {
  const repos = [...new Set(named.map((p) => p.repo))];
  if (repos.length < 2) return [];
  const slices = slicesByRepo(request, repos, registry);
  return repos.map((repo) => {
    const mine = named.filter((p) => p.repo === repo);
    return { repo, property_host: mine.map((p) => p.host).join(", "), site: mine.map((p) => p.site).join(", "), ask: slices.get(repo) ?? request };
  });
}

/** The parts of a job from its stored hosts (a re-read, or "the site" inferred from a multi-repo card). */
export function partsFromHosts(propertyHost: string | null | undefined, request: string, registry: readonly WebProperty[] = WEB_PROPERTIES): WebPropertyPart[] {
  const hosts = (propertyHost ?? "").split(",").map((h) => h.trim());
  return partsFor(registry.filter((p) => hosts.includes(p.host)), request, registry);
}

/**
 * EACH REPO'S SLICE, WHEN THE EMAIL SEPARATES THEM. The request is split into sentences; a sentence
 * that names properties of exactly one repo belongs to that repo; a sentence naming none or several
 * is shared context and goes to every repo. The email "separates them" only when EVERY repo has at
 * least one sentence of its own — then each slice is the shared sentences plus its own, in the
 * order written. Otherwise every repo gets the whole request (its SITES line still scopes it).
 * Pure and deterministic, like everything else read at the door.
 */
export function slicesByRepo(request: string, repos: readonly string[], registry: readonly WebProperty[] = WEB_PROPERTIES): Map<string, string> {
  const sentences = request.replace(/\r/g, "").split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 0);
  const owner = sentences.map((sentence) => {
    const inIt = [...new Set(propertiesIn(sentence, registry).map((p) => p.repo))];
    return inIt.length === 1 && repos.includes(inIt[0]!) ? inIt[0]! : null;
  });
  const out = new Map<string, string>();
  if (!repos.every((r) => owner.includes(r))) {
    for (const r of repos) out.set(r, request);
    return out;
  }
  for (const r of repos) out.set(r, sentences.filter((_, i) => owner[i] === null || owner[i] === r).join("\n"));
  return out;
}

/**
 * "Preview first" in the request itself (23 Sep 2026). The preview gate existed, but only a REPLY
 * of "preview" to the plan email set it — the opening email could not ask for it, so a partner who
 * always wants to see the site first had to say so twice.
 */
const PREVIEW_FIRST = /\b(preview (?:it )?first|(?:send|show|email) me a preview|preview link|preview before|see a preview|see it before it (?:goes live|lands|ships))\b/i;
export function previewFirstIn(text: string): string | null {
  return PREVIEW_FIRST.exec(text)?.[0] ?? null;
}

/**
 * Null when neither a property nor a Drive link is named. Otherwise what was found — the caller
 * decides the kind from `target_repo` being set. EVERYTHING is read from what the partner WROTE:
 * a Drive folder in a quoted earlier thread or a signature is not this request's package (21 Sep
 * 2026: the Community package folder rode in on a quote and Porter pulled 200 files for a photo).
 */
export function parseWebPropertyAsk(subject: string, body: string, registry: readonly WebProperty[] = WEB_PROPERTIES): WebPropertyAsk | null {
  const text = `${subject}\n${body}`.replace(/\r/g, "");
  const written = writtenPart(text);
  const folder = FOLDER_LINK.exec(written);
  const file = FILE_LINK.exec(written);
  const ask = body.trim().slice(0, 6000) || subject.trim();
  /*
   * SITES IN DIFFERENT REPOS ARE ONE JOB WITH ONE PART PER REPO (23 Sep 2026). Until today they
   * were unresolved — one job was one repo. Now the card carries every host and every repo, and
   * `parts` says which sites and which slice of the request each repo's PR is for.
   */
  const named = propertiesIn(written, registry);
  const parts = partsFor(named, ask, registry);
  const property: WebProperty | null = parts.length
    ? { host: parts.map((p) => p.property_host).join(", "), repo: parts.map((p) => p.repo).join(" + "), site: parts.map((p) => p.site).join(", "), words: [] }
    : propertyIn(written, registry);
  // The greeting is the BODY's first line; the subject sits above it in `text`.
  const addressee = addresseeIn(writtenPart(body.replace(/\r/g, "")));
  // "Hey Porter — a spot on the site": addressed to Porter, a property named without its host.
  const unresolved = !property && addressee === "Porter" && THE_SITE.test(written);
  if (!folder && !file && !property && !unresolved) return null;
  return {
    drive_folder_id: folder?.[1] ?? null,
    drive_folder_url: folder ? folder[0]!.replace(/[.,;:]+$/, "") : null,
    drive_file_url: file ? file[0]!.replace(/[.,;:]+$/, "") : null,
    property_host: property?.host ?? null,
    target_repo: property?.repo ?? null,
    site: property?.site ?? null,
    ...(parts.length ? { parts } : {}),
    ask,
    pre_approval: preApprovalIn(written),
    force: forcePhraseIn(written),
    addressee,
    property_unresolved: unresolved,
    preview_first: previewFirstIn(written),
  };
}

/** The lines above any quoted original ("> …" or "On … wrote:"). */
function writtenPart(text: string): string {
  const lines = text.split("\n");
  const cut = lines.findIndex((l) => /^\s*>/.test(l) || /^On .+wrote:\s*$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim()));
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n");
}

/**
 * Is this a change Porter runs on the Mac? A PROPERTY NAMED, that is all (21 Sep 2026). The
 * request is the specification; a Drive folder, an attachment or a link are assets it may or may
 * not reference. "Change the tagline to X" is a whole request.
 */
export function isWebPropertyChange(ask: WebPropertyAsk | null): ask is WebPropertyAsk {
  return Boolean(ask && (ask.target_repo || ask.property_unresolved));
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
      addressee: p.addressee ?? null,
      property_unresolved: p.property_unresolved === true,
      ...(Array.isArray(p.parts) && p.parts.length > 1 ? { parts: p.parts } : {}),
      ...(Array.isArray(p.registered) && p.registered.length ? { registered: p.registered.map(String) } : {}),
      ...(p.due && typeof p.due === "object" && typeof p.due.due_at === "string" ? { due: { due_at: p.due.due_at, due_words: String(p.due.due_words ?? ""), priority: p.due.priority === "URGENT" ? "URGENT" : "HIGH" } } : {}),
    };
  } catch {
    return null;
  }
}

// ── An open registry (0253, 6 Oct 2026) ─────────────────────────────────────────────────────────

/**
 * GitHub owners whose bare `owner/name` is read as a repo without a github.com link. Any
 * `https://github.com/<owner>/<name>` link is read whatever the owner. One list, read by the door;
 * a registered row's own owner joins it, so a repo registered once can be named by `owner/name` after.
 */
export const KNOWN_GITHUB_OWNERS: readonly string[] = ["seq23"];

export interface GitHubRepoMention {
  owner: string;
  name: string;
  /** owner/name, lower-case. */
  github_repo: string;
}

const GITHUB_URL = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?(?=[\/\s>)"'?#,;:]|$)/gi;
const BARE_REPO = /(?<![\w\/.@-])([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?![\w\/-])/g;

/** Every GitHub repo the text names: a github.com link (any owner), or `owner/name` for a known owner. */
export function githubReposIn(text: string, knownOwners: readonly string[] = KNOWN_GITHUB_OWNERS): GitHubRepoMention[] {
  const out = new Map<string, GitHubRepoMention>();
  const add = (owner: string, name: string) => {
    const cleaned = name.replace(/\.git$/i, "").replace(/[.,;:]+$/, "");
    if (!cleaned || /^\.+$/.test(cleaned)) return;
    const key = `${owner}/${cleaned}`.toLowerCase();
    if (!out.has(key)) out.set(key, { owner: owner.toLowerCase(), name: cleaned, github_repo: key });
  };
  for (const m of text.matchAll(GITHUB_URL)) add(m[1]!, m[2]!);
  const owners = new Set(knownOwners.map((o) => o.toLowerCase()));
  for (const m of text.matchAll(BARE_REPO)) if (owners.has(m[1]!.toLowerCase())) add(m[1]!, m[2]!);
  return [...out.values()];
}

/**
 * A HOST THE EMAIL NAMES FOR A NEW REPO: a plain `https://host/…` link that is not GitHub, Google or
 * one of the registered hosts. Only read beside a new repo — a link alone never registers anything,
 * because a site with no repo is nothing Porter can build.
 */
export function unregisteredHostsIn(text: string, registry: readonly WebProperty[]): string[] {
  const known = new Set(registry.flatMap((p) => [p.host, ...(p.aliases ?? [])]).map((h) => h.toLowerCase()));
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?=[\/\s>)"'?#,;:]|$)/gi)) {
    const host = m[1]!.toLowerCase().replace(/^www\./, "");
    if (/(^|\.)(github\.com|google\.com|googleapis\.com|pages\.dev|workers\.dev|cloudflare\.com|resend\.com)$/.test(host)) continue;
    if (known.has(host) || out.includes(host)) continue;
    out.push(host);
  }
  return out;
}

/**
 * EVERY SITE HOST THE WRITTEN PART NAMES THAT IS NOT REGISTERED — linked OR bare (9 Oct 2026). Read by
 * the follow-up matcher (`openSiteCardFor`): "New site build: voting.topbarz.xyz/entry" names a site,
 * just not one of ours, and an email that names a site is never "the site" of an open card for a
 * different one. Unlike `unregisteredHostsIn` (links only, read beside a new repo), a bare host
 * counts here, because Scooter writes hosts bare. Email addresses, file names (logo.png) and the
 * GitHub/Google/Cloudflare hosts every request carries are not sites. Pure.
 */
const NOT_A_SITE_TLD = /\.(?:png|jpe?g|gif|svg|webp|heic|pdf|docx?|xlsx?|pptx?|csv|txt|md|json|zip|mp[34]|mov|wav|html?|css|js|ts|eml)$/i;
export function namedSiteHostsIn(subject: string, body: string, registry: readonly WebProperty[] = WEB_PROPERTIES): string[] {
  const known = new Set(registry.flatMap((p) => [p.host, ...(p.aliases ?? [])]).map((h) => h.toLowerCase().replace(/^www\./, "")));
  const text = writtenPart(`${subject}\n${body}`.replace(/\r/g, ""));
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![\w@.-])((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?![\w-])/gi)) {
    const host = m[1]!.toLowerCase().replace(/^www\./, "");
    if (NOT_A_SITE_TLD.test(host)) continue;
    if (/(^|\.)(github\.com|google\.com|googleapis\.com|pages\.dev|workers\.dev|cloudflare\.com|resend\.com|gmail\.com)$/.test(host)) continue;
    if (known.has(host) || [...known].some((k) => host.endsWith(`.${k}`)) || out.includes(host)) continue;
    out.push(host);
  }
  return out;
}

export interface WebPropertyRegistration {
  repo: string;
  github_repo: string;
  /** The host the email gave beside the repo, or null — the duty fills it from the repo's own config. */
  host: string | null;
}

/**
 * WHAT A PARTNER'S EMAIL REGISTERS (0253): every GitHub repo it names that is not registered yet, each
 * with the first unregistered host the email names (one new repo, one new host → paired; several of
 * either → hosts are left for the repo's config to declare, never guessed). Pure; the Worker writes
 * the rows (`services/webPropertyRegistry.ts`). Only the WRITTEN part of the email counts — a repo
 * link in a quoted thread registers nothing.
 */
export function registrationsIn(written: string, registry: readonly WebProperty[]): WebPropertyRegistration[] {
  const text = writtenPart(written.replace(/\r/g, ""));
  const owners = [...new Set([...KNOWN_GITHUB_OWNERS, ...registry.map((p) => p.githubRepo?.split("/")[0]).filter((o): o is string => Boolean(o))])];
  const known = new Set(registry.flatMap((p) => [p.repo.toLowerCase(), (p.githubRepo ?? "").toLowerCase()]).filter(Boolean));
  const fresh = githubReposIn(text, owners).filter((r) => !known.has(r.github_repo) && !known.has(r.name.toLowerCase()));
  if (!fresh.length) return [];
  const hosts = unregisteredHostsIn(text, registry);
  return fresh.map((r) => ({ repo: r.name, github_repo: r.github_repo, host: fresh.length === 1 && hosts.length === 1 ? hosts[0]! : null }));
}

/** The registry row a registration becomes: the repo is its own property until its config names a host. */
export function propertyFromRegistration(r: WebPropertyRegistration): WebProperty {
  const name = r.repo.toLowerCase();
  return {
    host: r.host ?? name,
    repo: r.repo,
    site: REPO_ROOT_SITE,
    githubRepo: r.github_repo,
    seeded: false,
    words: [...new Set([name, r.github_repo, `the ${name} repo`, `${name} repo`, ...(r.host ? [`the ${r.host} site`] : [])])],
  };
}
