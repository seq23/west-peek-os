import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { deliver } from "./deliverables";
import { notify } from "./notifications";
import { chiefOfStaffFor } from "../../shared/work/chiefOfStaff";

/**
 * The Wednesday prep packet, one per partner, and the fund-deck discrepancy register.
 *
 * WHAT WAS ASKED FOR. Operator, 9 Sep 2026: "1 employee for each me and scooter needs to send me
 * and scooter prep packets for the wednesday meetings of things we have completed and what is
 * needed. saying nothing was done is okay too."
 *
 * WHY THIS IS NOT THE WEEKLY OPERATING REVIEW. That already exists and is a different artifact: ONE
 * document two partners work through together, signed jointly, prepared once. This is per-person —
 * what YOU finished, and what is waiting on YOU. Two people cannot prepare for a sync from a single
 * shared list of the firm's open items, and the firm's data says so plainly: on 9 Sep 2026
 * production held five weekly reviews and five `weekly_review` deliverables addressed to Scooter
 * against ONE addressed to Sequoia, last written on 20 August. The joint agenda picks its recipient
 * with `ORDER BY u.id LIMIT 1` under a comment describing "the senior partner on the roster" —
 * `fu_scooter_taylor` sorts before `fu_sequoia_taylor`, so alphabetical order has been standing in
 * for seniority for three weeks. Addressing is the fix, not a second copy of the agenda.
 *
 * "SAYING NOTHING WAS DONE IS OKAY TOO" IS AN INSTRUCTION, NOT A DISCLAIMER, and it decides the
 * whole design of this file. A packet with nothing in it is a legitimate output. A packet that
 * silently did not build is a failure. ON A SCREEN THEY LOOK IDENTICAL — which is exactly the
 * failure mode the weekly review already has: `if (items.length > 0)` guards its handover, so an
 * empty week produces no deliverable at all and a partner cannot tell a quiet week from a broken
 * job.
 *
 * So every packet is generated, always, and carries a COVERAGE block: the window it looked at and
 * how many rows it read from each source. "Nothing was completed — 41 work cards, 17 approvals and
 * 6 deliverables examined" is a quiet week that can be checked. A build that could read nothing at
 * all throws instead of handing over a confident blank, and `runWednesdayPrep` raises a CRITICAL
 * notification when a packet fails, because a missing packet has to be louder than an empty one.
 */

/** Chosen once so the packet, its title and its coverage line can never describe different windows. */
export interface PrepWindow {
  /** Inclusive ISO instant the window opens: the previous Wednesday sync. */
  from: string;
  /** Exclusive ISO instant it closes: `now`. */
  to: string;
  /** The date of the meeting this packet is FOR. */
  meetingDate: string;
}

/**
 * The window between two Wednesday syncs.
 *
 * The standing series is Wednesdays at 11:00 New York. Anchoring on 15:00 UTC is deliberately
 * approximate — it is 11:00 EDT and 10:00 EST — and approximate is correct here: the window's job
 * is to divide a week into "since we last spoke" and "before that", and an hour either side of a
 * boundary moves nothing between those two buckets that a reader would notice. Pinning it to a
 * named zone would imply a precision that the underlying question does not have.
 */
export function prepWindow(now: Date): PrepWindow {
  const to = new Date(now.getTime());
  // Walk back to the most recent Wednesday 15:00Z that is strictly before `now`.
  const from = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate(), 15, 0, 0, 0));
  while (from.getUTCDay() !== 3 || from.getTime() >= to.getTime()) {
    from.setUTCDate(from.getUTCDate() - 1);
  }
  /*
   * THE MEETING BEING PREPARED FOR IS ALWAYS THE ONE AFTER `from`, which is one week later by
   * definition. Deriving it from `now` instead — "the next Wednesday at or on today" — gets a
   * Wednesday AFTERNOON wrong: at 16:00Z the sync has already happened, and a packet titled with
   * today's date, covering the hour since it ended, is prep for a meeting nobody is going to have.
   * Anchoring on `from` makes the window and the meeting one week apart, always, and there is no
   * hour of the week where the two disagree.
   */
  const meeting = new Date(from.getTime() + 7 * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString(), meetingDate: meeting.toISOString().slice(0, 10) };
}

/** One line of a packet, always carrying the row it came from. */
export interface PrepLine {
  text: string;
  sourceType: string;
  sourceId: string;
}

export interface PrepPacket {
  firmUserId: string;
  fullName: string;
  /** The employee who signs it: that partner's own Chief of Staff, from the roster. */
  preparedBy: string;
  window: PrepWindow;
  completed: PrepLine[];
  needed: PrepLine[];
  /** What was read to produce the above. An empty packet is only believable with this. */
  coverage: Array<{ source: string; rowsRead: number }>;
  body: string;
}

/**
 * Read a list, and say how much of it there was.
 *
 * A THROW IS NOT A ZERO, which is the rule the whole health board is built on and the one this file
 * would most easily break. If a source cannot be read, that has to reach the packet as an unreadable
 * source rather than as "nothing happened there" — the difference between a quiet week and a broken
 * query is the entire value of this document.
 */
async function readSource<T>(
  env: Env,
  name: string,
  sql: string,
  binds: unknown[],
  coverage: Array<{ source: string; rowsRead: number }>,
  unreadable: string[],
): Promise<T[]> {
  try {
    const res = await env.WP_OS_DB.prepare(sql).bind(...binds).all<T>();
    const rows = res.results ?? [];
    coverage.push({ source: name, rowsRead: rows.length });
    return rows;
  } catch {
    unreadable.push(name);
    return [];
  }
}

/**
 * Build one partner's packet.
 *
 * Throws when NOTHING could be read. That is the one case where handing over a document would be
 * worse than handing over none: a packet whose every source failed is indistinguishable from a
 * genuinely quiet week, and this system has already been burned by a job that reported "nothing
 * came in" over a source it could not see.
 */
export async function buildPrepPacket(env: Env, firmUserId: string, now: Date): Promise<PrepPacket> {
  const window = prepWindow(now);
  const coverage: Array<{ source: string; rowsRead: number }> = [];
  const unreadable: string[] = [];

  const user = await env.WP_OS_DB.prepare("SELECT id, full_name FROM firm_user WHERE id = ?1")
    .bind(firmUserId)
    .first<{ id: string; full_name: string }>();
  if (!user) throw new Error(`no such firm user: ${firmUserId}`);

  // ── COMPLETED: things this person finished, or that were finished for them, in the window ──

  const decided = await readSource<{ id: string; title: string; state: string; decided_at: string }>(
    env,
    "approvals you decided",
    `SELECT id, title, state, decided_at FROM approval_card
      WHERE decided_by = ?1 AND decided_at >= ?2 AND decided_at < ?3
      ORDER BY decided_at`,
    [firmUserId, window.from, window.to],
    coverage,
    unreadable,
  );

  const cardsDone = await readSource<{ id: string; title: string; updated_at: string }>(
    env,
    "work you closed",
    `SELECT id, title, updated_at FROM work_card
      WHERE owner_type = 'HUMAN' AND owner_id = ?1 AND state = 'DONE'
        AND updated_at >= ?2 AND updated_at < ?3
      ORDER BY updated_at`,
    [firmUserId, window.from, window.to],
    coverage,
    unreadable,
  );

  const delivered = await readSource<{ id: string; kind: string; title: string; prepared_by: string; created_at: string }>(
    env,
    "work delivered to you",
    `SELECT id, kind, title, prepared_by, created_at FROM deliverable
      WHERE prepared_for = ?1 AND created_at >= ?2 AND created_at < ?3 AND dismissed_at IS NULL
      ORDER BY created_at`,
    [firmUserId, window.from, window.to],
    coverage,
    unreadable,
  );

  const acked = await readSource<{ id: string; title: string; acked_at: string }>(
    env,
    "exceptions you took responsibility for",
    `SELECT id, title, acked_at FROM notification
      WHERE acked_by = ?1 AND acked_at >= ?2 AND acked_at < ?3
      ORDER BY acked_at`,
    [firmUserId, window.from, window.to],
    coverage,
    unreadable,
  );

  const completed: PrepLine[] = [
    ...decided.map((r) => ({
      text: `${r.state === "approved" ? "Approved" : r.state === "rejected" ? "Rejected" : `Decided (${r.state})`}: ${r.title}`,
      sourceType: "approval_card",
      sourceId: r.id,
    })),
    ...cardsDone.map((r) => ({ text: `Closed: ${r.title}`, sourceType: "work_card", sourceId: r.id })),
    ...delivered.map((r) => ({
      text: `${r.prepared_by} delivered: ${r.title}`,
      sourceType: "deliverable",
      sourceId: r.id,
    })),
    ...acked.map((r) => ({
      text: `Took responsibility for: ${r.title}`,
      sourceType: "notification",
      sourceId: r.id,
    })),
  ];

  // ── NEEDED: things waiting on this person, whenever they arrived ──

  const pending = await readSource<{ id: string; title: string; created_at: string; risk_level: string }>(
    env,
    "approvals waiting on a partner",
    `SELECT id, title, created_at, risk_level FROM approval_card
      WHERE state = 'pending_review' ORDER BY created_at`,
    [],
    coverage,
    unreadable,
  );

  const cardsOpen = await readSource<{ id: string; title: string; state: string; due_at: string | null }>(
    env,
    "work you own that is still open",
    `SELECT id, title, state, due_at FROM work_card
      WHERE owner_type = 'HUMAN' AND owner_id = ?1 AND state IN ('OPEN','IN_PROGRESS','BLOCKED')
      ORDER BY CASE state WHEN 'BLOCKED' THEN 0 ELSE 1 END, created_at`,
    [firmUserId],
    coverage,
    unreadable,
  );

  const unread = await readSource<{ id: string; title: string; severity: string }>(
    env,
    "exceptions addressed to you and unread",
    `SELECT id, title, severity FROM notification
      WHERE (firm_user_id = ?1 OR firm_user_id IS NULL) AND read_at IS NULL
        AND severity IN ('CRITICAL','WARNING')
      ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 ELSE 1 END, created_at`,
    [firmUserId],
    coverage,
    unreadable,
  );

  const faults = await readSource<{ check_key: string; label: string; reading: string | null }>(
    env,
    "things the health board says are down",
    "SELECT check_key, label, reading FROM health_fault WHERE resolved_at IS NULL ORDER BY first_seen_at",
    [],
    coverage,
    unreadable,
  );

  const needed: PrepLine[] = [
    ...pending.map((r) => ({
      text: `Waiting on a decision${r.risk_level && r.risk_level !== "UNCLASSIFIED" ? ` (${r.risk_level.toLowerCase()} risk)` : ""}: ${r.title}`,
      sourceType: "approval_card",
      sourceId: r.id,
    })),
    ...cardsOpen.map((r) => ({
      text: `${r.state === "BLOCKED" ? "Blocked" : "Open"}${r.due_at ? `, due ${r.due_at.slice(0, 10)}` : ""}: ${r.title}`,
      sourceType: "work_card",
      sourceId: r.id,
    })),
    ...unread.map((r) => ({
      text: `${r.severity === "CRITICAL" ? "Critical" : "Unread warning"}: ${r.title}`,
      sourceType: "notification",
      sourceId: r.id,
    })),
    ...faults.map((r) => ({
      text: `Still down: ${r.label}${r.reading ? ` — ${r.reading}` : ""}`,
      sourceType: "health_fault",
      sourceId: r.check_key,
    })),
  ];

  /*
   * EVERY source failed. Handing over a packet here would be handing over a lie in the shape of a
   * quiet week, so this throws and the caller turns it into a CRITICAL notification instead. A
   * PARTIAL failure is different and is reported inside the packet: some of it is real.
   */
  if (coverage.length === 0) {
    throw new Error(`could not read any source for ${user.full_name}: ${unreadable.join(", ")}`);
  }

  const preparedBy = chiefOfStaffFor(user.full_name);
  const body = renderPacket({
    fullName: user.full_name, preparedBy, window, completed, needed, coverage, unreadable,
  });

  return { firmUserId, fullName: user.full_name, preparedBy, window, completed, needed, coverage, body };
}

/**
 * The packet as somebody reads it.
 *
 * THE EMPTY STATE IS WRITTEN OUT IN WORDS, not left as an absent heading. "Nothing was completed in
 * this window" under a coverage line naming what was examined is a fact; a missing section is an
 * ambiguity.
 */
function renderPacket(p: {
  fullName: string;
  preparedBy: string;
  window: PrepWindow;
  completed: PrepLine[];
  needed: PrepLine[];
  coverage: Array<{ source: string; rowsRead: number }>;
  unreadable: string[];
}): string {
  const first = p.fullName.split(" ")[0] ?? p.fullName;
  const lines: string[] = [];

  lines.push(`# ${first} — prep for the Wednesday sync, ${p.window.meetingDate}`);
  lines.push("");
  lines.push(`Covering ${p.window.from.slice(0, 16).replace("T", " ")}Z to ${p.window.to.slice(0, 16).replace("T", " ")}Z — since the last sync.`);
  lines.push("");

  lines.push("## Completed");
  lines.push("");
  if (p.completed.length === 0) {
    lines.push(
      "**Nothing was completed in this window.** That is the reading, not a missing section — see " +
      "*What was examined* below for the sources this was checked against.",
    );
  } else {
    for (const line of p.completed) lines.push(`- ${line.text}`);
  }
  lines.push("");

  lines.push("## Needed from you");
  lines.push("");
  if (p.needed.length === 0) {
    lines.push("**Nothing is waiting on you.** Checked against the same sources below.");
  } else {
    for (const line of p.needed) lines.push(`- ${line.text}`);
  }
  lines.push("");

  /*
   * THE LINE THAT MAKES AN EMPTY PACKET BELIEVABLE. Without it, "nothing was completed" and "this
   * job silently read nothing" are the same document.
   */
  lines.push("## What was examined");
  lines.push("");
  for (const c of p.coverage) lines.push(`- ${c.source}: ${c.rowsRead} row${c.rowsRead === 1 ? "" : "s"}`);
  if (p.unreadable.length > 0) {
    lines.push("");
    lines.push(
      `**${p.unreadable.length} source${p.unreadable.length === 1 ? "" : "s"} could not be read: ` +
      `${p.unreadable.join(", ")}.** Anything they would have carried is missing from this packet, ` +
      "so treat those areas as unknown rather than as empty.",
    );
  }
  lines.push("");
  lines.push(`Prepared by ${p.preparedBy}.`);

  return lines.join("\n");
}

// ── The fund-deck discrepancy register ────────────────────────────────────────────────────────

export interface Discrepancy {
  /** Where it lives: a slide, a field, a table. */
  where: string;
  what: string;
  shouldBe: string;
  /** What is known about whether anyone acted, in the firm's own records. */
  actedOn: string;
  /** RECORDED = the firm wrote this down at the time. DERIVED = arithmetic over the live records. */
  origin: "RECORDED" | "DERIVED";
}

/**
 * What the firm already wrote down about its own deck, recovered rather than re-derived.
 *
 * WHERE THESE COME FROM. When the fund was commissioned on 18 Aug 2026 the deck's figures were
 * loaded through the real API, and where the deck disagreed with itself the disagreement was
 * RECORDED in the policy version rather than quietly resolved — `sleeve_policy_version.sleeve_json`
 * carries a `note`, `investment_mandate_version.mandate_json` carried an `open_question`. Those are
 * findings the firm made about its own deck and then never surfaced anywhere a person looks. This
 * reads them back out.
 *
 * IT ALSO CHECKS THE ARITHMETIC, marked DERIVED so the two can be told apart at a glance: a note
 * somebody wrote in August and a sum that does not add up today are different kinds of claim, and
 * an operator deciding what to fix before a meeting needs to know which is which.
 *
 * HARD-FAILS ON NO POLICIES rather than reporting a clean deck. A register that returns "nothing
 * found" because the fund has no policy rows is the empty-loop pass this repo hunts by name.
 */
export async function buildDiscrepancyRegister(
  env: Env,
): Promise<{ fundId: string; fundName: string; recorded: Discrepancy[]; derived: Discrepancy[]; body: string }> {
  const fund = await env.WP_OS_DB.prepare("SELECT id, name, target_size_minor, vintage_year FROM fund LIMIT 1")
    .first<{ id: string; name: string; target_size_minor: number | null; vintage_year: number | null }>();
  if (!fund) throw new Error("no fund exists: there is nothing to compare a deck against");

  const mandates = (
    await env.WP_OS_DB.prepare(
      "SELECT version_no, mandate_json FROM investment_mandate_version WHERE fund_id = ?1 ORDER BY version_no",
    ).bind(fund.id).all<{ version_no: number; mandate_json: string }>()
  ).results ?? [];
  const sleeves = (
    await env.WP_OS_DB.prepare(
      "SELECT version_no, sleeve_json FROM sleeve_policy_version WHERE fund_id = ?1 ORDER BY version_no",
    ).bind(fund.id).all<{ version_no: number; sleeve_json: string }>()
  ).results ?? [];
  const reserves = (
    await env.WP_OS_DB.prepare(
      "SELECT version_no, reserve_json FROM reserve_policy_version WHERE fund_id = ?1 ORDER BY version_no",
    ).bind(fund.id).all<{ version_no: number; reserve_json: string }>()
  ).results ?? [];

  // The empty-loop guard. No policies means this examined nothing, and that is a failure, not a
  // clean bill of health.
  if (mandates.length === 0 && sleeves.length === 0) {
    throw new Error("the fund carries no mandate or sleeve policy: this register examined nothing");
  }

  const parse = <T>(raw: string): T => JSON.parse(raw) as T;
  const recorded: Discrepancy[] = [];
  const derived: Discrepancy[] = [];

  /*
   * THE OPEN QUESTION THAT WAS DELETED RATHER THAN ANSWERED.
   *
   * Mandate v1 (18 Aug) carried `open_question`: the deck states its sector list two different ways
   * and neither matches what the operator says out loud. Mandate v2 (21 Aug) does not carry it —
   * and carries no resolution either. The policy tables are immutable and versioned precisely so a
   * change is visible, and the change here was the disappearance of the only record that a question
   * was open. That is worth reporting louder than the question itself.
   */
  const withQuestion = mandates.filter((m) => typeof parse<{ open_question?: string }>(m.mandate_json).open_question === "string");
  const latestMandate = mandates.length > 0 ? parse<Record<string, unknown>>(mandates[mandates.length - 1]!.mandate_json) : {};
  for (const m of withQuestion) {
    const q = parse<{ open_question: string }>(m.mandate_json).open_question;
    const stillCarried = typeof latestMandate.open_question === "string";
    recorded.push({
      where: `Deck p4 and the Terms page · investment_mandate_version v${m.version_no}`,
      what: q,
      shouldBe: "One sector list, the same on the deck, on the Terms page, and in the mandate.",
      actedOn: stillCarried
        ? `Still open — carried forward into v${mandates[mandates.length - 1]!.version_no}.`
        : `NOT resolved, DROPPED. v${mandates[mandates.length - 1]!.version_no} no longer carries the question and records no answer, so the only trace that it was ever open is v${m.version_no}.`,
      origin: "RECORDED",
    });
  }

  for (const s of sleeves) {
    const note = parse<{ note?: string }>(s.sleeve_json).note;
    if (!note) continue;
    recorded.push({
      where: `The deck's fund-construction table · sleeve_policy_version v${s.version_no}`,
      what: note,
      shouldBe:
        "A construction table that sums to the fund size, states each sleeve's percentage of the " +
        "same base it is a percentage of, and models fee and expense drag.",
      actedOn:
        "Recorded at commissioning on 18 Aug 2026 and carried on the live policy. The OS works " +
        "from investable capital instead; the deck itself has not been shown to be changed.",
      origin: "RECORDED",
    });
  }

  // ── DERIVED: arithmetic over what is on the records right now ──

  if (fund.target_size_minor === null || fund.vintage_year === null) {
    derived.push({
      where: `fund row ${fund.id}`,
      what:
        `The fund record itself carries ${fund.target_size_minor === null ? "no target size" : ""}` +
        `${fund.target_size_minor === null && fund.vintage_year === null ? " and " : ""}` +
        `${fund.vintage_year === null ? "no vintage year" : ""}, while the mandate states a $30M target and a 2026 vintage.`,
      shouldBe: "The fund row and the mandate agree, or the fund row is the one place the size lives.",
      actedOn: "No — both columns are still NULL.",
      origin: "DERIVED",
    });
  }

  for (const s of sleeves) {
    const sleeve = parse<{
      estimated_investable_usd?: number;
      sleeves?: Array<{ key: string; target_pct: number; target_usd: number }>;
    }>(s.sleeve_json);
    const base = sleeve.estimated_investable_usd ?? 0;
    for (const sl of sleeve.sleeves ?? []) {
      const impliedUsd = Math.round((sl.target_pct / 100) * base);
      if (base > 0 && Math.abs(impliedUsd - sl.target_usd) >= 1) {
        derived.push({
          where: `sleeve_policy_version v${s.version_no} · ${sl.key}`,
          what:
            `${sl.target_pct}% of the $${(base / 1e6).toFixed(1)}M investable base is ` +
            `$${(impliedUsd / 1e6).toFixed(1)}M, but the sleeve is stated as $${(sl.target_usd / 1e6).toFixed(1)}M — ` +
            `a $${(Math.abs(impliedUsd - sl.target_usd) / 1000).toFixed(0)}K disagreement between the percentage and the dollars.`,
          shouldBe: "The percentage and the dollar figure describe the same number.",
          actedOn:
            "No. This is the same class of error the deck was flagged for in August, committed by " +
            "the policy written to replace it.",
          origin: "DERIVED",
        });
      }
    }
  }

  /*
   * CAN THE MANDATE AFFORD ITS OWN PORTFOLIO? The mandate names a target position count and a check
   * range; the sleeve and reserve policies decide how much initial capital actually exists. Nobody
   * had multiplied the two together.
   */
  const mandate = latestMandate as {
    target_positions?: number;
    check_size_usd?: { min?: number; max?: number };
  };
  const early = (sleeves.length > 0
    ? parse<{ sleeves?: Array<{ key: string; target_usd: number }> }>(sleeves[sleeves.length - 1]!.sleeve_json).sleeves
    : []
  )?.find((sl) => sl.key === "EARLY_STAGE_PRIMARY");
  const reserve = reserves.length > 0
    ? parse<{ reserve_pct?: number; basis?: string }>(reserves[reserves.length - 1]!.reserve_json)
    : {};
  if (early && mandate.target_positions && mandate.check_size_usd?.min && mandate.check_size_usd.max && reserve.reserve_pct) {
    const forInitials = early.target_usd * (1 - reserve.reserve_pct / 100);
    const atMin = mandate.target_positions * mandate.check_size_usd.min;
    const atMax = mandate.target_positions * mandate.check_size_usd.max;
    if (atMax > forInitials) {
      derived.push({
        where: "investment_mandate_version × sleeve_policy_version × reserve_policy_version",
        what:
          `${mandate.target_positions} positions at the stated $${(mandate.check_size_usd.min / 1000).toFixed(0)}–` +
          `${(mandate.check_size_usd.max / 1000).toFixed(0)}K check needs $${(atMin / 1e6).toFixed(1)}M–` +
          `$${(atMax / 1e6).toFixed(1)}M of initial capital. The early-stage sleeve is ` +
          `$${(early.target_usd / 1e6).toFixed(1)}M with ${reserve.reserve_pct}% reserved, leaving ` +
          `$${(forInitials / 1e6).toFixed(1)}M for initials. The target portfolio is only affordable if ` +
          `every cheque is written at ${atMin <= forInitials ? "the bottom of the range" : "below the stated minimum"}.`,
        shouldBe:
          "Either fewer positions, a smaller check, a larger early-stage sleeve, or a stated " +
          "expectation that the range's midpoint is not the plan.",
        actedOn: "No — this arithmetic does not appear anywhere in the firm's records.",
        origin: "DERIVED",
      });
    }
  }

  const body = renderRegister(fund.name, recorded, derived);
  return { fundId: fund.id, fundName: fund.name, recorded, derived, body };
}

function renderRegister(fundName: string, recorded: Discrepancy[], derived: Discrepancy[]): string {
  const lines: string[] = [];
  lines.push(`# ${fundName} — where our own records and the deck disagree`);
  lines.push("");
  lines.push(
    "Two sections, deliberately. **Already found** are discrepancies the firm wrote down at the " +
    "time, recovered from the policy versions they were recorded on. **Newly noticed** are ones " +
    "this run derived by checking the arithmetic on the live records. Old and unactioned is a " +
    "different problem from newly spotted, and they should not be read as one list.",
  );
  lines.push("");

  const section = (title: string, items: Discrepancy[], emptyLine: string) => {
    lines.push(`## ${title}`);
    lines.push("");
    if (items.length === 0) {
      lines.push(`**${emptyLine}**`);
      lines.push("");
      return;
    }
    for (const [n, d] of items.entries()) {
      lines.push(`### ${n + 1}. ${d.where}`);
      lines.push("");
      lines.push(`- **What is inconsistent** — ${d.what}`);
      lines.push(`- **What it should be** — ${d.shouldBe}`);
      lines.push(`- **Acted on?** — ${d.actedOn}`);
      lines.push("");
    }
  };

  section("Already found, and recorded at the time", recorded,
    "Nothing was recorded. No policy version on this fund carries a note or an open question.");
  section("Newly noticed by this run", derived,
    "Nothing new. Every arithmetic check this run performed came back consistent.");

  lines.push("---");
  lines.push("");
  lines.push(
    "Every item above is read from a row in this system — a policy version, a fund record — and " +
    "not from a reading of the deck file itself. Where an item says the deck says something, that " +
    "is what the firm recorded the deck as saying at commissioning on 18 Aug 2026.",
  );
  return lines.join("\n");
}

// ── Running it ────────────────────────────────────────────────────────────────────────────────

export interface PrepRunResult {
  meetingDate: string;
  packets: Array<{ firmUserId: string; fullName: string; preparedBy: string; completed: number; needed: number; empty: boolean }>;
  register: { recorded: number; derived: number; preparedBy: string } | null;
  failures: Array<{ what: string; detail: string }>;
}

/** Preston owns fund construction and allocation on the roster, so the deck's arithmetic is his. */
const REGISTER_OWNER = "Preston";

/**
 * Build and hand over every Wednesday artifact.
 *
 * EVERY EMPLOYEE REPORTS COMPLETION. Operator, 9 Sep 2026, in capitals: "EVERY FUCKING EMPLOYEE I
 * GIVE A TASK SHOULD REPORT COMPLETION". So each of the three — both Chiefs of Staff and Preston —
 * hands over a deliverable AND writes a `meeting_prep.delivered` event AND raises a notification
 * addressed to the partner it is for. A deliverable that appears on a page with nothing announcing
 * it is not a report; it is a file somebody has to go and find.
 *
 * A FAILED PACKET IS LOUDER THAN AN EMPTY ONE. An empty packet is delivered and says it is empty.
 * A packet that could not be built raises a CRITICAL notification naming what failed, because
 * CRITICAL is the one severity quiet hours never hold — and a partner walking into a meeting
 * believing there was nothing to prepare is the exact failure this design exists to prevent.
 */
export async function runWednesdayPrep(env: Env, actor: Actor, now: Date): Promise<PrepRunResult> {
  const window = prepWindow(now);
  const failures: Array<{ what: string; detail: string }> = [];
  const packets: PrepRunResult["packets"] = [];

  const partners = (
    await env.WP_OS_DB.prepare(
      `SELECT fu.id, fu.full_name FROM firm_user fu
         JOIN firm_user_role fur ON fur.firm_user_id = fu.id
         JOIN role r ON r.id = fur.role_id
        WHERE r.key = 'MANAGING_PARTNER' AND fu.status = 'ACTIVE'
        ORDER BY fu.full_name`,
    ).all<{ id: string; full_name: string }>()
  ).results ?? [];

  /*
   * NO PARTNERS IS A FAILURE, NOT A QUIET WEEK. Exiting 0 here having written nothing is precisely
   * the stage that "runs but does nothing" — so it throws, and the tick reports it.
   */
  if (partners.length === 0) throw new Error("no active managing partner: there is nobody to prepare a packet for");

  for (const p of partners) {
    try {
      const packet = await buildPrepPacket(env, p.id, now);
      await deliver(env, actor, {
        kind: "meeting_prep",
        title: `${packet.fullName.split(" ")[0]} — prep for the Wednesday sync, ${window.meetingDate}`,
        body: packet.body,
        preparedBy: packet.preparedBy,
        preparedFor: p.id,
        // One packet per partner per meeting: re-running updates it rather than stacking copies.
        sourceType: "meeting_prep",
        sourceId: `${window.meetingDate}:${p.id}`,
      });

      const empty = packet.completed.length === 0;
      await notify(env, {
        kind: "MEETING",
        severity: "INFO",
        title: `${packet.preparedBy} has your prep for Wednesday`,
        body: empty
          ? `Nothing was completed since the last sync — that is the reading, and the packet says what it examined. ${packet.needed.length} item(s) are waiting on you.`
          : `${packet.completed.length} completed, ${packet.needed.length} waiting on you.`,
        objectType: "deliverable",
        objectId: `${window.meetingDate}:${p.id}`,
        firmUserId: p.id,
        dedupeKey: `meeting_prep:${window.meetingDate}:${p.id}`,
      });

      await appendEvent(env, {
        eventType: "meeting_prep.delivered",
        actorType: "system",
        actorId: packet.preparedBy,
        objectType: "firm_user",
        objectId: p.id,
        payload: {
          meeting_date: window.meetingDate,
          prepared_by: packet.preparedBy,
          completed: packet.completed.length,
          needed: packet.needed.length,
          sources_read: packet.coverage.length,
        },
      });

      packets.push({
        firmUserId: p.id, fullName: packet.fullName, preparedBy: packet.preparedBy,
        completed: packet.completed.length, needed: packet.needed.length, empty,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      failures.push({ what: `prep packet for ${p.full_name}`, detail });
      // CRITICAL, and never held: a missing packet must be louder than an empty one.
      await notify(env, {
        kind: "MEETING",
        severity: "CRITICAL",
        title: `${p.full_name.split(" ")[0]}'s Wednesday prep could NOT be built`,
        body: `${detail}. This is not a quiet week — the packet failed to build, and nothing should be read into its absence.`,
        objectType: "firm_user",
        objectId: p.id,
        firmUserId: p.id,
        dedupeKey: `meeting_prep_failed:${window.meetingDate}:${p.id}`,
      }).catch(() => undefined);
    }
  }

  // ── The discrepancy register, prepared once, for both ──
  let register: PrepRunResult["register"] = null;
  try {
    const reg = await buildDiscrepancyRegister(env);
    for (const p of partners) {
      await deliver(env, actor, {
        kind: "discrepancy_list",
        title: `${reg.fundName} — where our records and the deck disagree`,
        body: reg.body,
        preparedBy: REGISTER_OWNER,
        preparedFor: p.id,
        sourceType: "discrepancy_list",
        sourceId: `${window.meetingDate}:${p.id}`,
      });
      await notify(env, {
        kind: "MEETING",
        severity: "INFO",
        title: `${REGISTER_OWNER} has the deck discrepancy list`,
        body: `${reg.recorded.length} recorded at the time and still on the books, ${reg.derived.length} newly noticed by this run.`,
        objectType: "deliverable",
        objectId: `${window.meetingDate}:${p.id}`,
        firmUserId: p.id,
        dedupeKey: `discrepancy_list:${window.meetingDate}:${p.id}`,
      });
    }
    await appendEvent(env, {
      eventType: "discrepancy_register.delivered",
      actorType: "system",
      actorId: REGISTER_OWNER,
      objectType: "fund",
      objectId: reg.fundId,
      payload: { meeting_date: window.meetingDate, recorded: reg.recorded.length, derived: reg.derived.length },
    });
    register = { recorded: reg.recorded.length, derived: reg.derived.length, preparedBy: REGISTER_OWNER };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    failures.push({ what: "fund-deck discrepancy register", detail });
    await notify(env, {
      kind: "MEETING",
      severity: "CRITICAL",
      title: "The deck discrepancy list could NOT be built",
      body: `${detail}. Its absence means the check did not run, not that the deck is consistent.`,
      objectType: "fund",
      objectId: "register",
      dedupeKey: `discrepancy_failed:${window.meetingDate}`,
    }).catch(() => undefined);
  }

  return { meetingDate: window.meetingDate, packets, register, failures };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

export async function handleRunMeetingPrep(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "weekly_review.manage", {
    objectType: "meeting_prep",
    objectId: "wednesday",
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const result = await runWednesdayPrep(ctx.env, actor, new Date());
  // A run that produced nothing at all is reported as a problem, never as a 200 meaning "fine".
  const status = result.packets.length === 0 ? 500 : 200;
  return json(result, { status });
}
