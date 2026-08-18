#!/usr/bin/env node
/**
 * Commission the firm: create Fund I, its policies, and the deals that exist today.
 *
 * WHY THIS EXISTS. On 18 Aug 2026 production was queried directly and found EMPTY of everything
 * the product is about: zero funds, zero mandates, zero companies, zero opportunities, zero
 * meetings, zero positions — while 959 unit tests passed. The operator's report that "none of the
 * buttons work" was exactly this. Nothing was broken; there was simply nothing to act on, so every
 * surface rendered its empty state and every button operated on a record that did not exist.
 *
 * A test suite can prove that a button works. It cannot prove that the firm was ever loaded into
 * the system. This script is the missing step, and `tests/commissioned.test.ts` is the missing
 * assertion.
 *
 * IT DRIVES THE REAL API, NEVER SQL. Writing rows straight into D1 would be faster and would be a
 * lie: it would skip authorize(), skip the event_record trail, and skip every validation the
 * services own — so a green run would prove nothing about whether the operator can do the same
 * thing through the UI. Every write here goes through the same endpoint the browser calls. If this
 * script succeeds, those paths genuinely work.
 *
 * IT IS IDEMPOTENT. Every step looks before it writes, so a re-run after a partial failure
 * continues rather than duplicating. Nothing here updates or deletes: several of these tables
 * reject UPDATE at the database layer (D15), and corrections are new versions or compensating
 * rows, never edits.
 *
 * Usage:
 *   node scripts/seed/commission-fund.mjs --base-url http://127.0.0.1:8787 --dev-user sequoia@westpeek.ventures
 *   node scripts/seed/commission-fund.mjs --base-url https://os.joinwestpeek.com --access-token "$(cloudflared access token --app=https://os.joinwestpeek.com)"
 *   …add --dry-run to print the plan and write nothing.
 */

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const DRY_RUN = args.includes("--dry-run");
const BASE_URL = String(flag("base-url", "http://127.0.0.1:8787")).replace(/\/$/, "");
const DEV_USER = flag("dev-user");
const ACCESS_TOKEN = flag("access-token");

if (!DEV_USER && !ACCESS_TOKEN && !DRY_RUN) {
  console.error("Refusing to run: pass --dev-user (local) or --access-token (production).");
  process.exit(2);
}

const headers = {
  "content-type": "application/json",
  ...(DEV_USER ? { "x-wpos-dev-user": String(DEV_USER) } : {}),
  ...(ACCESS_TOKEN ? { "cf-access-token": String(ACCESS_TOKEN) } : {}),
};

let created = 0;
let existed = 0;
const notes = [];

async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text.slice(0, 400) };
  }
  return { status: res.status, data };
}

/** Create only if `find` turns up nothing. Returns the record either way. */
async function ensure(label, find, create) {
  const existing = await find();
  if (existing) {
    existed += 1;
    console.log(`  ·  ${label} — already present`);
    return existing;
  }
  if (DRY_RUN) {
    console.log(`  +  ${label} — WOULD CREATE`);
    return { id: `dry-run-${label}` };
  }
  const made = await create();
  if (!made) throw new Error(`could not create ${label}`);
  created += 1;
  console.log(`  +  ${label} — created`);
  return made;
}

// ── The firm, as it actually is on 18 Aug 2026 ────────────────────────────────────────────────
//
// Every figure below comes from the Fund I deck (Aug 2026) or from the operator directly. Where
// the two disagree, or where something is genuinely unknown, it is recorded as unknown rather
// than filled with a plausible number — an invented entry price is worse than an absent one,
// because only one of them is visibly missing.

const FUND_NAME = "West Peek Ventures Fund I";

const MANDATE = {
  vintage: 2026,
  target_size_usd: 30_000_000,
  hard_cap_usd: 50_000_000,
  structure: "Delaware Limited Partnership",
  fund_life_years: 10,
  extensions: "2 x 1 year",
  investment_period_years: 4,
  management_fee_pct: 2.0,
  carried_interest_pct: 20.0,
  geography: ["US"],
  stage: ["PRE_SEED", "SEED"],
  sectors: ["AI", "FUTURE_OF_WORK", "HEALTH_TECH", "ED_TECH", "CONSUMER"],
  // Not a sixth sector — a filter applied ACROSS the five. The deck's central claim is
  // "community is the new moat", so a company that cannot benefit from community is out of
  // mandate even when its sector matches.
  cross_cutting_filter: "benefits from community",
  check_size_usd: { min: 500_000, max: 750_000 },
  target_ownership_pct: 8.0,
  minimum_ownership_pct: 5.0,
  target_positions: 20,
  thesis_statement:
    "Pre-seed and seed companies in AI, future of work, health tech, ed tech and consumer, " +
    "where community is a durable advantage rather than a marketing channel.",
  // The deck states the sector list two different ways and neither matches what the operator
  // says out loud. Recorded so the disagreement is visible rather than silently resolved here.
  open_question:
    "Deck p4 lists healthcare/education/consumer/future-of-work; the Terms page lists " +
    "AI/consumer/education/future-of-work. This mandate uses the operator's five-sector list. " +
    "The deck should be made to match whichever is decided.",
};

const SLEEVE = {
  basis: "investable capital after fees and expenses",
  committed_usd: 30_000_000,
  estimated_fees_usd: 5_000_000,
  estimated_expenses_usd: 1_000_000,
  estimated_investable_usd: 24_000_000,
  sleeves: [
    { key: "EARLY_STAGE_PRIMARY", target_pct: 70, target_usd: 17_000_000, stage: "PRE_SEED" },
    { key: "SECONDARY_PURCHASE", target_pct: 30, target_usd: 7_000_000, stage: "SERIES_B_C" },
  ],
  note:
    "The deck's construction table sums to $27M of a $30M fund, labels $3M of reserves as '30% " +
    "of the fund' when it is 10%, and calls a $6M secondaries sleeve 30% when it is 20%. It also " +
    "deploys the full $30M with no fee drag. This version starts from investable capital instead.",
};

// Consumed by allocation.ts, which reads { reserve_pct }.
const RESERVE = {
  reserve_pct: 40,
  basis: "early-stage sleeve",
  reserve_usd: 7_000_000,
  rationale:
    "Pre-seed reserves are how ownership survives the Series A. The deck's $3M is 10% of the " +
    "fund; at that level the best company in the portfolio raises an A and the position cannot " +
    "be defended, which is where pre-seed funds lose their returns.",
};

// Consumed by allocation.ts, which reads { max_single_company_pct }.
const CONCENTRATION = {
  max_single_company_pct: 10,
  basis: "committed capital",
  rationale:
    "At a $500-750K initial check plus reserves, no single name should exceed 10% of the fund. " +
    "Set as a ceiling to be argued with, not a target.",
};

const COMPANIES = [
  {
    canonical_name: "Sensori",
    website: "https://drinksensori.com",
    description:
      "Alcohol-free beverages built around social occasions, health and wellness. Founded 2024 " +
      "(Shanna Pearre, Darean Rhodes, Ashlyn Knox), Texas. Raised a ~$100K seed in Aug 2025 with " +
      "Block Inc., 19keys and J&J Innovation. Identity confirmed by the operator — NOT the New " +
      "Zealand construction-tech company of the same name.",
  },
  {
    canonical_name: "Psyflo",
    description:
      "Mental health care for youth and young adults, delivered through schools and " +
      "youth-serving non-profits. Uses AI agents for early intervention and delivers billable " +
      "tele-health sessions in-app. Founder Deana Oliver (NYU, Cornell Tech; public health and " +
      "health tech). Won a West Peek pitch competition.",
  },
  {
    canonical_name: "Synthient.ai",
    description:
      "AI infrastructure and future-of-work company. Founders ex-Visa, Upwork, Lockheed Martin " +
      "and Hyperloop; CEO Marcell Hilliard. Appeared in the Fund I deck as pipeline.",
  },
];

const OPPORTUNITIES = [
  {
    company: "Sensori",
    title: "Sensori — SPV, closed",
    opportunity_type: "EARLY_STAGE_PRIMARY",
    // Community-sourced consumer deal. Recorded so the flywheel is measurable rather than asserted.
    relationship_origin: "COMMUNITY_INTRO",
    source_channel: "SPV",
    // STAND-INS, chosen so the arithmetic totals the real $10,000 invested and nothing else.
    // The operator asked for editable placeholders rather than empty fields, which is fine as
    // long as they are loud: a number indistinguishable from a real one gets charted and
    // eventually reported to an LP, and by then nobody can tell which figures were ever true.
    price_per_share: 1,
    quantity: 10_000,
    placeholder_fields: ["price_per_share", "quantity"],
    placeholder_note:
      "Entry price and share count are STAND-INS totalling the real $10,000 invested. Ownership, " +
      "mark and return computed from them are meaningless. Replace with the SPV terms.",
    terms: {
      vehicle: "SPV",
      amount_invested_usd: 10_000,
      status_note: "Closed. The firm's only investment to date; predates the fund.",
      entry_valuation_usd: null,
    },
  },
  {
    company: "Psyflo",
    title: "Psyflo — pre-seed, screening",
    opportunity_type: "EARLY_STAGE_PRIMARY",
    // The single most valuable provenance record the firm has: a live deal that came out of
    // West Peek's own pitch competition. This is the flywheel, evidenced.
    relationship_origin: "COMMUNITY_INTRO",
    source_channel: "West Peek pitch competition",
    terms: {
      thesis_fit: ["ED_TECH", "HEALTH_TECH"],
      community: "Educators, school superintendents",
      origin_detail:
        "Won a West Peek pitch competition. Recorded as COMMUNITY_INTRO because the " +
        "relationship_origin CHECK (migration 0044) has no PITCH_COMPETITION value yet; adding " +
        "one is queued, since pitch competitions are a named part of the sourcing engine.",
    },
  },
  {
    company: "Synthient.ai",
    title: "Synthient.ai — cold",
    opportunity_type: "EARLY_STAGE_PRIMARY",
    relationship_origin: "NETWORK",
    source_channel: "Partner network",
    terms: {
      thesis_fit: ["AI", "FUTURE_OF_WORK"],
      status_note:
        "Went cold, per the operator on 18 Aug 2026. Loaded rather than omitted: a pipeline that " +
        "only remembers live deals cannot show judgement, and the deck still lists this as " +
        "active. Move to PASS or WITHDRAWN with a reason once the Dealflow board ships.",
    },
  },
];

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nCommissioning West Peek OS at ${BASE_URL}${DRY_RUN ? "  (DRY RUN — nothing will be written)" : ""}\n`);

  const who = await api("GET", "/api/me");
  if (who.status !== 200) {
    console.error(`Cannot identify caller (HTTP ${who.status}). ${JSON.stringify(who.data)?.slice(0, 200)}`);
    if (!DRY_RUN) process.exit(1);
  } else {
    console.log(`Acting as ${who.data?.email ?? who.data?.fullName ?? "unknown"}\n`);
  }

  console.log("Fund");
  const fund = await ensure(
    FUND_NAME,
    async () => {
      const r = await api("GET", "/api/funds");
      return (r.data?.funds ?? []).find((f) => f.name === FUND_NAME) ?? null;
    },
    async () => (await api("POST", "/api/funds", { name: FUND_NAME })).data,
  );

  await ensure(
    "West Peek Ventures Fund I, L.P. (Delaware LP)",
    async () => {
      const r = await api("GET", `/api/funds/${fund.id}/entities`);
      return (r.data?.entities ?? [])[0] ?? null;
    },
    async () =>
      (await api("POST", `/api/funds/${fund.id}/entities`, {
        legal_entity_name: "West Peek Ventures Fund I, L.P.",
        entity_type: "LIMITED_PARTNERSHIP",
        jurisdiction: "Delaware",
      })).data,
  );

  console.log("\nPolicies");
  for (const [kind, policy] of [
    ["mandate", MANDATE],
    ["sleeve", SLEEVE],
    ["reserve", RESERVE],
    ["concentration", CONCENTRATION],
  ]) {
    await ensure(
      `${kind} v1`,
      async () => {
        const r = await api("GET", `/api/funds/${fund.id}/policies/${kind}`);
        return (r.data?.versions ?? [])[0] ?? null;
      },
      async () =>
        (await api("POST", `/api/funds/${fund.id}/policies/${kind}`, {
          version_no: 1,
          effective_from: "2026-08-18",
          policy,
        })).data,
    );
  }

  console.log("\nCompanies");
  const companyIds = {};
  for (const c of COMPANIES) {
    const rec = await ensure(
      c.canonical_name,
      async () => {
        const r = await api("GET", "/api/companies");
        return (r.data?.companies ?? []).find((x) => x.canonical_name === c.canonical_name) ?? null;
      },
      async () => (await api("POST", "/api/companies", c)).data,
    );
    companyIds[c.canonical_name] = rec.id;
  }

  console.log("\nOpportunities");
  for (const o of OPPORTUNITIES) {
    const { company, ...rest } = o;
    await ensure(
      o.title,
      async () => {
        const r = await api("GET", "/api/opportunities");
        return (r.data?.opportunities ?? []).find((x) => x.title === o.title) ?? null;
      },
      async () =>
        (await api("POST", "/api/opportunities", { ...rest, company_id: companyIds[company] })).data,
    );
  }

  // Opportunities are always born NEW. Walk each to where it actually stands, through the same
  // transition endpoint the board will use — so the stage on screen is a real transition with an
  // event behind it, not a column written at insert time.
  console.log("\nStages");
  const current = (await api("GET", "/api/opportunities")).data?.opportunities ?? [];
  for (const [title, to] of [
    ["Psyflo — pre-seed, screening", "SCREENING"],
    ["Synthient.ai — cold", "PASS"],
  ]) {
    const opp = current.find((o) => o.title === title);
    if (!opp) {
      console.log(`  !  ${title} — not found, cannot transition`);
      continue;
    }
    if (opp.status === to) {
      existed += 1;
      console.log(`  ·  ${title} — already ${to}`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  →  ${title} — WOULD MOVE ${opp.status} -> ${to}`);
      continue;
    }
    const r = await api("POST", `/api/opportunities/${opp.id}/transition`, { to });
    if (r.status >= 400) {
      console.log(`  !  ${title} — ${opp.status} -> ${to} REFUSED (HTTP ${r.status}): ${JSON.stringify(r.data)?.slice(0, 160)}`);
      notes.push(`${title}: could not reach ${to}; left at ${opp.status}.`);
      continue;
    }
    created += 1;
    console.log(`  →  ${title} — ${opp.status} -> ${to}`);
  }

  // Sensori predates the fund and never went to IC, so it takes the backfill lane (migration
  // 0050) rather than the lifecycle: the status is placed and the row is permanently marked as
  // history, with the reason attached. Walking it up through IC_DECIDED would have minted a
  // decision that never happened.
  console.log("\nPre-dated holdings");
  const sensori = ((await api("GET", "/api/opportunities")).data?.opportunities ?? [])
    .find((o) => o.title === "Sensori — SPV, closed");
  if (!sensori) {
    console.log("  !  Sensori — not found");
  } else if (sensori.backfilled_at) {
    existed += 1;
    console.log(`  ·  Sensori — already backfilled (${sensori.status})`);
  } else if (DRY_RUN) {
    console.log("  →  Sensori — WOULD BACKFILL to CLOSED");
  } else {
    const r = await api("POST", `/api/opportunities/${sensori.id}/backfill`, {
      to: "CLOSED",
      reason: "$10K SPV that closed before Fund I existed; never went through West Peek's IC",
      as_of_date: "2025-08-06",
    });
    if (r.status >= 400) {
      console.log(`  !  Sensori — backfill REFUSED (HTTP ${r.status}): ${JSON.stringify(r.data)?.slice(0, 160)}`);
    } else {
      created += 1;
      console.log("  →  Sensori — backfilled to CLOSED, marked as history");
    }
  }

  notes.push(
    "Sensori's price and share count are PLACEHOLDERS, marked as such. Anything computed from " +
    "them is meaningless until the real SPV terms are entered on the Dealflow page.",
  );
  notes.push("relationship_origin has no PITCH_COMPETITION value; Psyflo is recorded as COMMUNITY_INTRO with the detail in terms.");

  console.log(`\n${created} created, ${existed} already present.`);
  if (notes.length) {
    console.log("\nStated gaps (deliberately not invented):");
    for (const n of notes) console.log(`  - ${n}`);
  }
  console.log("");
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}\n`);
  process.exit(1);
});
