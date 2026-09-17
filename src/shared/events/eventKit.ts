import { personaPrompt } from "../registry/aiEmployeePersonas";
import { AI_EMPLOYEE_ROSTER } from "../registry/aiEmployees";
import type { Stream } from "./monthlyPlan";

/**
 * THE DRAFT PROPOSED EVENT KIT — one per monthly proposal, both streams (17 Sep 2026).
 *
 * ─── What this is ──────────────────────────────────────────────────────────────────────────────
 *
 * Parker already sends a packet: the topic, three angles on it, one chosen, the run of show, the
 * money. What the packet does NOT do is show a partner the event. The kit does — it is the thing
 * Scooter got by hand for September (`docs/EVENT_KIT_EXAMPLE_SEPTEMBER.md`), and it is the
 * difference between an email that offers a menu and an email that is something to react to.
 *
 * ONE KIT, FOR THE ANGLE HE WOULD RUN. Not three. A kit per angle would be a menu with more pages;
 * this is the case for his own recommendation, and the two angles he did not choose stay one line
 * each in the packet where they belong.
 *
 * ─── The four things that are NOT the model's to decide ────────────────────────────────────────
 *
 * Each of these was a defect in the September kit, and each is closed STRUCTURALLY here rather
 * than asked for in a prompt — the rule this repo keeps relearning is that a prompt is a request.
 *
 *   1 · THE PLATFORM. September's kit read "StreamYard / YouTube Live / LinkedIn Live / Instagram
 *       Live". The owner: "THIS IS OUR PREFERRED WAY TO DO VIRTUAL EVENTS." So the platform is a
 *       constant, `verifyEventKit` strips the other four BY NAME wherever they appear, and there is
 *       no field a model could put a second platform in.
 *
 *   2 · THE DATE AND TIME. September's kit shipped "[Insert Date] at 6:00 PM ET". A bracket is a
 *       to-do disguised as a document. The date is therefore COMPUTED — `proposedSlotFor` — from
 *       the month and the stream, is a real weekday, and is marked PROPOSED everywhere it appears.
 *       A model never writes it, so it can never fail to.
 *
 *   3 · WHAT IS GENUINELY UNKNOWN IS MARKED OPEN, NEVER INVENTED. The firm's standing rule. Two
 *       things are unknowable at proposal time — who the co-host or guest is when nobody has said,
 *       and the real join link, which does not exist until the event is scheduled. `openItemsFor`
 *       derives both from the record rather than trusting a model not to fill them, and the join
 *       link has NO field at all: it cannot be invented into a shape that does not exist.
 *
 *   4 · THE ON SCREEN COLUMN. The part of a broadcast nothing else in this system thinks about —
 *       who is in frame, and in what layout, minute by minute. Every run-of-show row carries one
 *       shape from a CLOSED vocabulary; a row that comes back without a recognisable one is flagged
 *       and defaulted rather than rendered as a blank cell in a table a producer has to run from.
 */

// ── The fixed "where" ────────────────────────────────────────────────────────

/** The one platform. The owner: "THIS IS OUR PREFERRED WAY TO DO VIRTUAL EVENTS." */
export const EVENT_KIT_PLATFORM = "West Peek Live";
export const EVENT_KIT_PLATFORM_URL = "https://westpeek.live";

/**
 * The four the September kit listed, struck by name.
 *
 * A generic "do not name another platform" instruction would be a request. This is a list, it is
 * applied after generation, and the test proves each one of these four is removed — so the check
 * cannot pass by examining an empty list.
 */
export const RETIRED_PLATFORMS = ["StreamYard", "YouTube Live", "LinkedIn Live", "Instagram Live"] as const;

/** Kept from the September kit: the greenroom is fifteen minutes before the broadcast. */
export const GREENROOM_MINUTES_BEFORE = 15;

// ── The five sections ────────────────────────────────────────────────────────

export type EventKitSectionKey = "header" | "event_description" | "run_of_show" | "discussion_guide" | "social_posts";

export interface EventKitSectionDef {
  key: EventKitSectionKey;
  /** The heading as it is rendered, and as the specification's table names it. */
  label: string;
}

/**
 * THE CLOSED LIST, in the order the September kit wrote them and the order a kit renders in.
 *
 * `docs/EVENT_KIT_SPECIFICATION.md` carries the same five in a table, and
 * `tests/eventKitSpecification.test.ts` reads that table and compares it with this constant. A
 * section added to one without the other fails the build, in both directions.
 */
export const EVENT_KIT_SECTIONS: readonly EventKitSectionDef[] = [
  { key: "header", label: "Header" },
  { key: "event_description", label: "Official event description" },
  { key: "run_of_show", label: "Run of show" },
  { key: "discussion_guide", label: "Discussion guide" },
  { key: "social_posts", label: "Social posts" },
] as const;

export const EVENT_KIT_SECTION_KEYS: readonly EventKitSectionKey[] = EVENT_KIT_SECTIONS.map((s) => s.key);

// ── On Screen ────────────────────────────────────────────────────────────────

/**
 * WHO IS IN FRAME, AND IN WHAT LAYOUT. The closed vocabulary, taken from the September run of show:
 * a backstage greenroom, the host alone, two-up for the interview, a screen share for the demo,
 * three-up for the wrap.
 */
export const ON_SCREEN_SHAPES = ["BACKSTAGE", "SOLO", "2-UP", "SCREEN SHARE", "3-UP"] as const;
export type OnScreenShape = (typeof ON_SCREEN_SHAPES)[number];

export function onScreenShapeOf(v: unknown): OnScreenShape | null {
  const s = typeof v === "string" ? v.trim().toUpperCase().replace(/\s+VIEW$/, "").replace(/\s+/g, " ") : "";
  const hit = (ON_SCREEN_SHAPES as readonly string[]).find((k) => k === s);
  return (hit as OnScreenShape | undefined) ?? null;
}

export interface OnScreen {
  shape: OnScreenShape;
  /** Who is in frame, in words — "Host + Scooter Taylor", "the co-host, once named". */
  who: string;
}

// ── The proposed slot ────────────────────────────────────────────────────────

export interface ProposedSlot {
  /** YYYY-MM-DD. A real date in the month, always a real weekday. */
  date: string;
  weekday: string;
  /** "6:00 PM ET" — the broadcast time. */
  startEt: string;
  /** The broadcast time minus `GREENROOM_MINUTES_BEFORE`. */
  greenroomEt: string;
  /** "PROPOSED — Thursday 12 November 2026, 6:00 PM ET". Carries the word every time it is shown. */
  label: string;
  /** Always true, and rendered. Nothing here is booked. */
  proposed: true;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/**
 * THE HOUSE SLOT PER STREAM, so the date is a decision the firm made once rather than a model's
 * invention each month. A Workshop is the second Thursday; a Room is one evening, the third
 * Wednesday. Both at the hour the September kit broadcast at.
 */
export const STREAM_SLOT: Readonly<Record<Stream, { nth: number; weekday: number; startEt: string; minutesFromMidnight: number }>> = {
  WORKSHOP: { nth: 2, weekday: 4, startEt: "6:00 PM ET", minutesFromMidnight: 18 * 60 },
  ROOM: { nth: 3, weekday: 3, startEt: "6:30 PM ET", minutesFromMidnight: 18 * 60 + 30 },
};

function clockEt(minutesFromMidnight: number): string {
  const m = ((minutesFromMidnight % 1440) + 1440) % 1440;
  const h24 = Math.floor(m / 60);
  const mm = m % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(mm).padStart(2, "0")} ${h24 < 12 ? "AM" : "PM"} ET`;
}

/**
 * A REAL DATE, COMPUTED — never "[Insert Date]".
 *
 * The nth given weekday of the month, at the stream's house hour, with the greenroom fifteen
 * minutes earlier. Deterministic, so the same month proposes the same evening however many times
 * the chain is rebuilt, and so a test can state the answer.
 */
export function proposedSlotFor(month: string, stream: Stream): ProposedSlot {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  const slot = STREAM_SLOT[stream];
  const firstDow = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  const firstHit = 1 + ((slot.weekday - firstDow + 7) % 7);
  let day = firstHit + (slot.nth - 1) * 7;
  const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  // A short month that has no nth occurrence falls back to the last one it does have, rather than
  // proposing a date that is not in the month.
  while (day > daysInMonth) day -= 7;
  const d = new Date(Date.UTC(year, mon - 1, day));
  const date = `${year}-${String(mon).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const weekday = WEEKDAYS[d.getUTCDay()]!;
  const startEt = clockEt(slot.minutesFromMidnight);
  return {
    date,
    weekday,
    startEt,
    greenroomEt: clockEt(slot.minutesFromMidnight - GREENROOM_MINUTES_BEFORE),
    label: `PROPOSED — ${weekday} ${day} ${MONTHS[mon - 1]} ${year}, ${startEt}`,
    proposed: true,
  };
}

// ── What is open ─────────────────────────────────────────────────────────────

export const OPEN_ITEM_KINDS = ["CO_HOST", "GUEST", "JOIN_LINK"] as const;
export type OpenItemKind = (typeof OPEN_ITEM_KINDS)[number];

export interface OpenItem {
  kind: OpenItemKind;
  /** What is not known, in the words the kit prints where the answer would go. */
  label: string;
  /** Why it is not known yet, so nobody reads it as an oversight. */
  why: string;
}

/**
 * OPEN, NOT INVENTED — and derived from the record rather than trusted to a model.
 *
 * The join link is ALWAYS open on a proposal: the event is not scheduled, so no link exists. A
 * co-host is open when the packet names none. A guest is open when the chosen angle wanted one and
 * the packet could not stand one up with evidence.
 */
export function openItemsFor(input: { coHostName: string | null; guestWanted: boolean; guestName: string | null }): OpenItem[] {
  const open: OpenItem[] = [];
  if (!input.coHostName) {
    open.push({ kind: "CO_HOST", label: "OPEN — co-host not yet decided", why: "nobody has been asked; a Workshop usually has one and a Room often does" });
  }
  if (input.guestWanted && !input.guestName) {
    open.push({ kind: "GUEST", label: "OPEN — guest not yet decided", why: "no guest has been approached, and I will not name one as though they had agreed" });
  }
  open.push({
    kind: "JOIN_LINK",
    label: `OPEN — join link issued when it is scheduled (${EVENT_KIT_PLATFORM})`,
    why: "there is no link until the event exists on West Peek Live; a placeholder link is a broken link",
  });
  return open;
}

// ── The kit ──────────────────────────────────────────────────────────────────

export interface EventKitPart {
  /** "Part 1: Founder Q&A with Scooter Taylor". */
  label: string;
  minutes: number;
  detail: string;
}

export interface EventKitHeader {
  eventTitle: string;
  /** "Live Broadcast (Interview + Hands-On Workshop)". */
  format: string;
  totalMinutes: number;
  platform: typeof EVENT_KIT_PLATFORM;
  slot: ProposedSlot;
}

export interface EventKitDescription {
  title: string;
  /** Written from the slot, never by the model: "PROPOSED — … (greenroom check-in 5:45 PM ET)". */
  broadcastTime: string;
  hook: string;
  parts: EventKitPart[];
  whoItsFor: string;
  /** "Join from a desktop so you can try it alongside…" */
  audienceTip: string;
}

export interface EventKitRow {
  timeEt: string;
  segment: string;
  description: string;
  onScreen: OnScreen;
}

export interface EventKitQuestion {
  n: number;
  /** What the question is for — "Foundational strategy", "Bridge to the workshop". */
  theme: string;
  question: string;
}

export interface EventKitDiscussionGuide {
  /** What the host says to open, as a script. */
  openingScript: string;
  questions: EventKitQuestion[];
}

export interface EventKitPost {
  /** Post A announces; Post B is written for a speaker to post in their own voice. */
  kind: "ANNOUNCE" | "SPEAKER";
  /** Who posts it. Post B says whose voice it is in. */
  voice: string;
  body: string;
  hashtags: string[];
}

export type EventKitFlagCode =
  | "retired_platform_removed"
  | "placeholder_removed"
  | "on_screen_defaulted"
  | "greenroom_inserted"
  | "invented_person_removed"
  | "no_questions"
  | "no_social_posts"
  | "duration_off";

export interface EventKitFlag {
  code: EventKitFlagCode;
  detail: string;
}

/** What is stored in `evt_room_packet.event_kit_json`, rendered as the deliverable and linked in the mail. */
export interface EventKit {
  stream: Stream;
  month: string;
  topic: string;
  /** The chosen angle's name — the kit is the case for THIS one. */
  angleTitle: string;
  /** One line: why this angle and not the other two. It is the line the email carries. */
  whyThisAngle: string;
  header: EventKitHeader;
  description: EventKitDescription;
  runOfShow: EventKitRow[];
  discussionGuide: EventKitDiscussionGuide;
  socialPosts: EventKitPost[];
  open: OpenItem[];
  flags: EventKitFlag[];
}

// ── The prompt ───────────────────────────────────────────────────────────────

/** What the chain hands the kit stage — everything the packet already settled. */
export interface EventKitSource {
  stream: Stream;
  month: string;
  topic: string;
  angleTitle: string;
  whyThisAngle: string;
  promise: string;
  whoItsFor: string;
  hostName: string;
  coHostName: string | null;
  guestWanted: boolean;
  guestName: string | null;
  runOfShow: ReadonlyArray<{ time: string; minutes: number; what: string; who: string }>;
  totalMinutes: number;
}

function parkerIdentity(): string {
  return personaPrompt("Parker", AI_EMPLOYEE_ROSTER.find((e) => e.name === "Parker")?.role ?? "AI employee");
}

/** The marker the chain's own test doubles dispatch on, and the sentence the stage is named for. */
export const EVENT_KIT_PROMPT_MARKER = "WRITE THE DRAFT PROPOSED EVENT KIT";

export function buildEventKitPrompt(src: EventKitSource, slot: ProposedSlot, open: readonly OpenItem[]): string {
  return [
    parkerIdentity(),
    "",
    `${EVENT_KIT_PROMPT_MARKER} for the ${src.month} ${src.stream === "WORKSHOP" ? "Workshop" : "Room"}.`,
    "",
    "A kit is what a partner reads instead of a menu: ONE angle — the one I would run — written up",
    "so completely that the only thing left to do is say yes. It is a draft and it says so.",
    "",
    `THE ANGLE: "${src.angleTitle}", on the topic "${src.topic}". Why it won: ${src.whyThisAngle || "—"}`,
    `THE PROMISE: ${src.promise}`,
    `WHO IT IS FOR: ${src.whoItsFor}`,
    `HOSTS: ${src.hostName} hosts.${src.coHostName ? ` Co-host: ${src.coHostName}.` : ""}`,
    "",
    `THE PLATFORM IS FIXED: ${EVENT_KIT_PLATFORM} (${EVENT_KIT_PLATFORM_URL}). It is the firm's preferred way to`,
    `run a virtual event. NEVER name ${RETIRED_PLATFORMS.join(", ")} or any other platform — they are removed`,
    "if you do, and the kit reads as though it were written for somebody else's product.",
    "",
    `THE DATE AND TIME ARE FIXED AND ALREADY DECIDED: ${slot.label}. Greenroom check-in ${slot.greenroomEt}.`,
    "Use that date and that time everywhere, exactly, and say PROPOSED beside it. There are NO square-",
    "bracket placeholders anywhere in a kit — no [Insert Date], no [LINK], no [TBD]. A bracket is a",
    "to-do disguised as a document, and one shipped to a partner in September looking finished.",
    "",
    open.length
      ? [
          "WHAT YOU DO NOT KNOW, YOU MARK OPEN — you never fill it with something plausible:",
          ...open.map((o) => `- ${o.label} (${o.why})`),
          "Write those words where the answer would go. Do not name a person who has not agreed.",
        ].join("\n")
      : "",
    "",
    "THE PACKET'S RUN OF SHOW, which yours must match minute for minute:",
    ...src.runOfShow.map((l) => `- ${l.time} (${l.minutes} min) — ${l.what}${l.who ? ` — ${l.who}` : ""}`),
    `Total: ${src.totalMinutes} minutes.`,
    "",
    "THE FIVE SECTIONS:",
    "1. HEADER — event title, format, total duration. (The platform and the date are supplied above.)",
    "2. OFFICIAL EVENT DESCRIPTION — the title as it is published, the hook (one or two sentences that",
    "   make somebody stop), 'what we'll cover' broken into PARTS each with its own minutes, who it is",
    "   for, and one audience tip (what to bring, or how to join so they can follow along).",
    "3. RUN OF SHOW — one row per segment: the time, the segment name, the description and notes, and",
    `   ON SCREEN. On screen is who is in frame and in what layout, from exactly: ${ON_SCREEN_SHAPES.join(", ")}.`,
    `   The first row is the greenroom, ${GREENROOM_MINUTES_BEFORE} minutes before, BACKSTAGE.`,
    "4. DISCUSSION GUIDE — the host's opening script in the host's own voice, and 3–5 core questions",
    "   for the guest or co-host, each with the theme it is there to open.",
    "5. SOCIAL POSTS — Post A announces the event. Post B is written in a SPEAKER'S OWN VOICE, first",
    "   person, for them to paste and post. Both end with hashtags.",
    "",
    "Return ONLY JSON:",
    JSON.stringify({
      event_title: "…",
      format: "Live broadcast (interview + hands-on workshop)",
      description: {
        title: "…", hook: "…",
        parts: [{ label: "Part 1: …", minutes: 10, detail: "…" }],
        who_its_for: "…", audience_tip: "…",
      },
      run_of_show: [{ time: slot.greenroomEt, segment: "Greenroom check-in", description: "Audio/video test, lower thirds, screen share rehearsed.", on_screen: { shape: "BACKSTAGE", who: "Host + speakers" } }],
      discussion_guide: { opening_script: "…", questions: [{ n: 1, theme: "…", question: "…" }] },
      social_posts: [
        { kind: "ANNOUNCE", voice: "West Peek", body: "…", hashtags: ["#WestPeek"] },
        { kind: "SPEAKER", voice: src.hostName, body: "…", hashtags: ["#WestPeek"] },
      ],
    }, null, 1),
  ].filter((l) => l !== "").join("\n");
}

// ── Parsing ──────────────────────────────────────────────────────────────────

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}
function strings(v: unknown): string[] {
  return Array.isArray(v) ? (v as unknown[]).map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean) : [];
}
function jsonBody(raw: string): Record<string, unknown> | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * The model's answer, into the shape — with the four things it does not decide supplied from
 * outside it. The platform, the slot and the open items are arguments, not fields it can write.
 */
export function parseEventKit(raw: string, src: EventKitSource, slot: ProposedSlot, open: readonly OpenItem[]): EventKit | null {
  const p = jsonBody(raw);
  if (!p) return null;
  const d = (p.description && typeof p.description === "object" ? p.description : {}) as Record<string, unknown>;
  const g = (p.discussion_guide && typeof p.discussion_guide === "object" ? p.discussion_guide : {}) as Record<string, unknown>;
  const title = str(p.event_title) ?? src.angleTitle;
  const rows: EventKitRow[] = list(p.run_of_show)
    .map((r) => {
      const os = (r.on_screen && typeof r.on_screen === "object" ? r.on_screen : {}) as Record<string, unknown>;
      const shape = onScreenShapeOf(os.shape);
      return {
        timeEt: str(r.time) ?? "",
        segment: str(r.segment) ?? "",
        description: str(r.description) ?? "",
        // A missing shape is kept as null here and DEFAULTED (with a flag) in the verifier, so the
        // absence is reported once rather than silently becoming SOLO in two places.
        onScreen: { shape: (shape ?? ("" as OnScreenShape)), who: str(os.who) ?? "" },
      };
    })
    .filter((r) => r.timeEt && r.segment);
  if (rows.length === 0) return null;
  const posts: EventKitPost[] = list(p.social_posts)
    .map((s) => ({
      kind: (str(s.kind)?.toUpperCase() === "SPEAKER" ? "SPEAKER" : "ANNOUNCE") as EventKitPost["kind"],
      voice: str(s.voice) ?? "West Peek",
      body: str(s.body) ?? "",
      hashtags: strings(s.hashtags),
    }))
    .filter((s) => s.body);
  return {
    stream: src.stream,
    month: src.month,
    topic: src.topic,
    angleTitle: src.angleTitle,
    whyThisAngle: src.whyThisAngle,
    header: {
      eventTitle: title,
      format: str(p.format) ?? (src.stream === "WORKSHOP" ? "Live working session" : "Live broadcast"),
      totalMinutes: src.totalMinutes,
      platform: EVENT_KIT_PLATFORM,
      slot,
    },
    description: {
      title: str(d.title) ?? title,
      broadcastTime: `${slot.label} (greenroom check-in ${slot.greenroomEt})`,
      hook: str(d.hook) ?? "",
      parts: list(d.parts)
        .map((x) => ({ label: str(x.label) ?? "", minutes: num(x.minutes) ?? 0, detail: str(x.detail) ?? "" }))
        .filter((x) => x.label),
      whoItsFor: str(d.who_its_for) ?? src.whoItsFor,
      audienceTip: str(d.audience_tip) ?? "",
    },
    runOfShow: rows,
    discussionGuide: {
      openingScript: str(g.opening_script) ?? "",
      questions: list(g.questions)
        .map((q, i) => ({ n: num(q.n) ?? i + 1, theme: str(q.theme) ?? "", question: str(q.question) ?? "" }))
        .filter((q) => q.question),
    },
    socialPosts: posts,
    open: [...open],
    flags: [],
  };
}

// ── Verification ─────────────────────────────────────────────────────────────

/** Anything in square brackets that reads as a to-do. `[n]`-style citations are not placeholders. */
const PLACEHOLDER = /\[(?!\d+\])[^\]\n]{0,80}\]/g;

/**
 * THE FOUR GUARANTEES, APPLIED AFTER GENERATION.
 *
 * Every one of them was a defect in the kit that actually shipped, and every one is closed here
 * rather than in the prompt, because a prompt is a request and this is not.
 */
export function verifyEventKit(kit: EventKit, src: EventKitSource): EventKit {
  const flags: EventKitFlag[] = [];
  const names = new Set<string>([src.hostName.toLowerCase(), ...(src.coHostName ? [src.coHostName.toLowerCase()] : []), ...(src.guestName ? [src.guestName.toLowerCase()] : [])]);

  const clean = (s: string): string => {
    let out = s;
    for (const p of RETIRED_PLATFORMS) {
      const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      if (re.test(out)) {
        flags.push({ code: "retired_platform_removed", detail: `"${p}" was named; every West Peek event runs on ${EVENT_KIT_PLATFORM}` });
        out = out.replace(re, EVENT_KIT_PLATFORM);
      }
    }
    // Collapse the "West Peek Live / West Peek Live / West Peek Live" a struck list leaves behind.
    out = out.replace(new RegExp(`(${EVENT_KIT_PLATFORM})(\\s*[/|]\\s*${EVENT_KIT_PLATFORM})+`, "gi"), EVENT_KIT_PLATFORM);
    out = out.replace(PLACEHOLDER, (m) => {
      flags.push({ code: "placeholder_removed", detail: `${m} is a to-do disguised as a document; the date is ${kit.header.slot.label} and anything genuinely unknown is marked open` });
      return /date|time|when/i.test(m) ? kit.header.slot.label : "OPEN — not yet decided";
    });
    return out;
  };

  const out: EventKit = {
    ...kit,
    // NOT THE MODEL'S. Restated rather than trusted, every time.
    header: { ...kit.header, platform: EVENT_KIT_PLATFORM, slot: kit.header.slot, eventTitle: clean(kit.header.eventTitle), format: clean(kit.header.format) },
    description: {
      ...kit.description,
      title: clean(kit.description.title),
      broadcastTime: `${kit.header.slot.label} (greenroom check-in ${kit.header.slot.greenroomEt})`,
      hook: clean(kit.description.hook),
      parts: kit.description.parts.map((p) => ({ ...p, label: clean(p.label), detail: clean(p.detail) })),
      whoItsFor: clean(kit.description.whoItsFor),
      audienceTip: clean(kit.description.audienceTip),
    },
    runOfShow: kit.runOfShow.map((r) => ({ ...r, segment: clean(r.segment), description: clean(r.description), onScreen: { ...r.onScreen, who: clean(r.onScreen.who) } })),
    discussionGuide: {
      openingScript: clean(kit.discussionGuide.openingScript),
      questions: kit.discussionGuide.questions.map((q) => ({ ...q, theme: clean(q.theme), question: clean(q.question) })),
    },
    socialPosts: kit.socialPosts.map((s) => ({ ...s, body: clean(s.body) })),
    open: [...kit.open],
    flags: [],
  };

  // EVERY ROW SAYS WHO IS IN FRAME. A blank On Screen cell is a table a producer cannot run from.
  out.runOfShow = out.runOfShow.map((r) => {
    if (onScreenShapeOf(r.onScreen.shape)) return r;
    flags.push({ code: "on_screen_defaulted", detail: `"${r.segment}" came back with no recognised On Screen layout; defaulted to SOLO — say who is in frame` });
    return { ...r, onScreen: { shape: "SOLO", who: r.onScreen.who || src.hostName } };
  });

  // THE GREENROOM SURVIVES FROM THE SEPTEMBER KIT, and is inserted if the model dropped it.
  if (!out.runOfShow.some((r) => /greenroom/i.test(r.segment))) {
    flags.push({ code: "greenroom_inserted", detail: `no greenroom row; the check-in is ${GREENROOM_MINUTES_BEFORE} minutes before, and it was added back` });
    out.runOfShow = [
      { timeEt: out.header.slot.greenroomEt, segment: "Greenroom check-in", description: `Audio and video test, lower thirds, screen share rehearsed on ${EVENT_KIT_PLATFORM}.`, onScreen: { shape: "BACKSTAGE", who: "Host and speakers, backstage" } },
      ...out.runOfShow,
    ];
  }

  // NOBODY IS NAMED WHO HAS NOT AGREED. An open seat stays open; a model that filled it is undone.
  for (const item of out.open) {
    if (item.kind === "JOIN_LINK") continue;
    const seat = item.kind === "CO_HOST" ? /co-?host/i : /guest/i;
    out.runOfShow = out.runOfShow.map((r) => {
      if (!seat.test(r.onScreen.who)) return r;
      const invented = r.onScreen.who
        .split(/[,+]/)
        .map((w) => w.trim())
        .find((w) => /^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/.test(w) && !names.has(w.toLowerCase()));
      if (!invented) return r;
      flags.push({ code: "invented_person_removed", detail: `"${invented}" was put in frame as the ${item.kind === "CO_HOST" ? "co-host" : "guest"}; nobody has been asked, so the seat stays open` });
      return { ...r, onScreen: { ...r.onScreen, who: r.onScreen.who.replace(invented, item.label) } };
    });
  }

  if (out.discussionGuide.questions.length === 0) flags.push({ code: "no_questions", detail: "the discussion guide came back with no questions; a host cannot run an interview from an opening line" });
  if (!out.socialPosts.some((s) => s.kind === "ANNOUNCE") || !out.socialPosts.some((s) => s.kind === "SPEAKER")) {
    flags.push({ code: "no_social_posts", detail: "a kit carries both posts: one to announce it, and one in a speaker's own voice for them to share" });
  }
  const partMinutes = out.description.parts.reduce((n, p) => n + p.minutes, 0);
  if (partMinutes > 0 && Math.abs(partMinutes - src.totalMinutes) > 10) {
    flags.push({ code: "duration_off", detail: `the description's parts add up to ${partMinutes} minutes against a ${src.totalMinutes}-minute run of show` });
  }

  out.flags = flags;
  return out;
}

// ── Rendering ────────────────────────────────────────────────────────────────

const heading = (key: EventKitSectionKey): string => {
  const i = EVENT_KIT_SECTIONS.findIndex((s) => s.key === key);
  return `## ${i + 1}. ${EVENT_KIT_SECTIONS[i]!.label}`;
};

/**
 * THE KIT AS THE DELIVERABLE'S BODY — the thing the link opens.
 *
 * The owner's own product settled the shape of the delivery, in West Peek Live's instruction pages:
 * "The email never carries the text, so correcting a page corrects it for everyone who already has
 * the link." A draft changes; an attachment cannot. So this is filed once, linked from the mail,
 * and rewritten in place when Parker rebuilds it.
 */
export function renderEventKitMarkdown(kit: EventKit): string {
  const lines: string[] = [
    `# DRAFT PROPOSED EVENT KIT — ${kit.header.eventTitle}`,
    "",
    `**A draft, and one angle only.** This is the ${kit.stream === "WORKSHOP" ? "Workshop" : "Room"} I would run for ${kit.month}, written up so the only thing left is to say yes. Nothing is booked and nobody outside the firm has been contacted.`,
    "",
    heading("header"),
    "",
    `**Event title:** ${kit.header.eventTitle}`,
    `**Format:** ${kit.header.format} | **Total duration:** ${kit.header.totalMinutes} minutes`,
    `**Platform:** ${kit.header.platform} (${EVENT_KIT_PLATFORM_URL})`,
    `**Date and time:** ${kit.header.slot.label} · greenroom check-in ${kit.header.slot.greenroomEt}`,
    `**Topic:** ${kit.topic} · **Angle:** ${kit.angleTitle}`,
    kit.whyThisAngle ? `**Why this angle:** ${kit.whyThisAngle}` : "",
    "",
    "**Still open — said, not invented:**",
    ...kit.open.map((o) => `- ${o.label} — ${o.why}`),
    "",
    heading("event_description"),
    "",
    `**Title:** ${kit.description.title}`,
    `**Broadcast time:** ${kit.description.broadcastTime}`,
    "",
    kit.description.hook,
    "",
    `### What we'll cover in ${kit.header.totalMinutes} minutes`,
    ...kit.description.parts.map((p) => `- **${p.label} (${p.minutes} mins)** — ${p.detail}`),
    "",
    `**Who is this for?** ${kit.description.whoItsFor}`,
    kit.description.audienceTip ? `> **Tip:** ${kit.description.audienceTip}` : "",
    "",
    heading("run_of_show"),
    "",
    "| Time (ET) | Segment | Description & notes | On screen |",
    "| :---- | :---- | :---- | :---- |",
    ...kit.runOfShow.map((r) => `| **${r.timeEt}** | ${r.segment} | ${r.description} | ${r.onScreen.shape}${r.onScreen.who ? ` — ${r.onScreen.who}` : ""} |`),
    "",
    heading("discussion_guide"),
    "",
    "### Opening script (host)",
    "",
    `> ${kit.discussionGuide.openingScript || "—"}`,
    "",
    "### Core questions",
    ...kit.discussionGuide.questions.map((q) => `${q.n}. **${q.theme}** — *"${q.question}"*`),
    "",
    heading("social_posts"),
    ...kit.socialPosts.flatMap((s) => [
      "",
      `### Post ${s.kind === "ANNOUNCE" ? "A — announcement" : `B — for ${s.voice} to share, in their own voice`}`,
      "",
      s.body,
      s.hashtags.length ? `\n${s.hashtags.join(" ")}` : "",
    ]),
    "",
    kit.flags.length ? `---\n\n**What I had to correct in my own draft:**\n${kit.flags.map((f) => `- ${f.detail}`).join("\n")}` : "",
    "",
    `— Parker, via West Peek OS. Every West Peek virtual event runs on ${kit.header.platform}.`,
  ];
  return lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * THE EMAIL CARRIES THE TL;DR AND THE LINK, NEVER THE KIT.
 *
 * Proposed title, proposed date and time, the duration shape, and the one line on why this angle —
 * enough to react to without clicking.
 */
export function eventKitTldr(kit: EventKit): string {
  return [
    `**Draft event kit — ${kit.header.eventTitle}.**`,
    `${kit.header.slot.label}, ${kit.header.totalMinutes} minutes on ${kit.header.platform}${kit.description.parts.length ? ` (${kit.description.parts.map((p) => `${p.minutes} min ${p.label.replace(/^Part \d+:\s*/i, "")}`).join(" + ")})` : ""}.`,
    kit.whyThisAngle ? `Why this angle: ${kit.whyThisAngle}` : "",
  ].filter(Boolean).join(" ");
}

/** Where the kit lives, so the mail links to it rather than carrying it. */
export function eventKitLink(deliverableId: string): string {
  return `https://os.joinwestpeek.com/api/deliverables/${deliverableId}/download`;
}
