import { useEffect, useRef, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { useSelectedFund } from "../lib/selectedFund";
import { FundPicker } from "./FundPicker";
import { reserveUsd, sleeveTargetUsd, type ReserveDoc, type SleeveDoc } from "@shared/fund/sleeveMath";

/**
 * The thesis — the firm's investment mandate, editable, and versioned rather than overwritten.
 *
 * design/DEALS_SECTION_DESIGN.md §7 (artboard H). The page is the DOCUMENT: one sentence, then the
 * numbers it commits the firm to, in the order Wyatt checks them. It has no lifecycle beyond
 * versions, so there are no faces; the stage rail is the pattern's contribution here, and it is
 * a FIT RAIL — six checks in the order they are applied — rather than a pipeline.
 *
 * WHY IT EXISTS. The mandate is what the firm is looking for, and it is the input the scout
 * searches against. It lived only in `investment_mandate_version` with no surface at all, so the
 * one thing the operator said would change often was the one thing that could not be changed.
 *
 * WHY EDITING WRITES A NEW VERSION. `investment_mandate_version` is keyed UNIQUE(fund_id,
 * version_no) and nothing here updates a row. That is the point: "what were we looking for when we
 * passed on that company in March" is a question a fund actually has to answer, and it is
 * unanswerable the moment an edit overwrites its predecessor. Saving therefore reads the current
 * highest version, adds one, and posts. The versions rail is the record, not a changelog.
 *
 * WHY THE INPUTS ARE COLLAPSED. Nine fields and two buttons at reading weight sat under the
 * document on every visit (§1.5 #1), so the single most consequential statement the firm makes
 * read as a settings screen. They open behind one verb — Amend — and close on save or Escape.
 *
 * WHAT THE NUMBERS MEAN. Check size and target ownership are not decoration — the ownership figure
 * is what decides whether one good outcome can return the fund, so it is shown with its
 * consequence attached rather than as a bare field. The arithmetic is deliberately done here and
 * not by a model: it is one division, and a number the operator will act on should not arrive from
 * something that can hallucinate.
 *
 * NOTHING ON THIS PAGE IS INVENTED. Every figure is read from a policy version; where one is
 * absent the cell says so ("—", "not set") and the rail node stays unfilled. The version's date is
 * `effective_from` as recorded, never today's date or a stand-in.
 */

interface PolicyVersion {
  id: string;
  version_no: number;
  effective_from: string;
  mandate_json?: string;
  sleeve_json?: string;
  reserve_json?: string;
  concentration_json?: string;
  created_by: string;
  created_at: string;
}

type PolicyList = { versions: PolicyVersion[]; current: PolicyVersion | null };

interface Mandate {
  vintage?: number;
  target_size_usd?: number;
  hard_cap_usd?: number;
  structure?: string;
  fund_life_years?: number;
  investment_period_years?: number;
  management_fee_pct?: number;
  carried_interest_pct?: number;
  geography?: string[];
  stage?: string[];
  sectors?: string[];
  cross_cutting_filter?: string;
  check_size_usd?: { min?: number; max?: number };
  target_ownership_pct?: number;
  minimum_ownership_pct?: number;
  target_positions?: number;
  thesis_statement?: string;
  open_question?: string;
}

/** $30M / $750K / $12 — the short form for a masthead or a rail. */
const usd = (n: number | undefined | null): string =>
  n === undefined || n === null || Number.isNaN(n)
    ? "—"
    : n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
      : n >= 1_000
        ? `$${Math.round(n / 1_000)}K`
        : `$${n}`;

/** $500,000 — the full form for a figure the firm commits to. */
const usdFull = (n: number | undefined | null): string =>
  n === undefined || n === null || Number.isNaN(n) ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;

/** Comma or newline separated, trimmed, blanks dropped. */
const toList = (s: string): string[] => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

/**
 * `PRE_SEED` is a database value; "Pre-seed" is what it is. The policy stores enum-shaped keys
 * beside free text, so anything that is not SHOUTING_WITH_UNDERSCORES is left exactly as typed.
 */
const KNOWN: Record<string, string> = {
  PRE_SEED: "Pre-seed",
  SEED: "Seed",
  SERIES_A: "Series A",
  SERIES_B: "Series B",
  AI: "AI",
  US: "US",
  UK: "UK",
  EU: "EU",
  FUTURE_OF_WORK: "Future of work",
  HEALTH_TECH: "Health tech",
  ED_TECH: "Ed tech",
  CONSUMER: "Consumer",
};
function humanise(token: string): string {
  if (KNOWN[token]) return KNOWN[token]!;
  if (!/^[A-Z0-9_]+$/.test(token)) return token;
  const words = token.toLowerCase().split("_").filter(Boolean);
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}
const list = (xs: string[] | undefined): string | null => (xs && xs.length ? xs.map(humanise).join(" · ") : null);

function parse<T>(blob: string | undefined | null): T {
  try {
    return blob ? (JSON.parse(blob) as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

/** A policy row's JSON column, whichever kind it is. */
function policyDoc<T>(v: PolicyVersion | null | undefined): T {
  return parse<T>(v?.mandate_json ?? v?.sleeve_json ?? v?.reserve_json ?? v?.concentration_json);
}

export function ThesisPage({ me }: { me: MeResponse }) {
  const selected = useSelectedFund();
  const fund = selected.fund;
  const versions = useApi<PolicyList>(fund ? `/api/funds/${fund.id}/policies/mandate` : null, [fund?.id]);

  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Mandate>({});
  const firstField = useRef<HTMLTextAreaElement>(null);

  // `current` from the API, never an index. This read `[0]` from an oldest-first list, so the
  // page showed version 1 for ever and amending the mandate appeared to do nothing.
  const latest = versions.data?.current ?? null;
  const current: Mandate = policyDoc<Mandate>(latest);
  const history = versions.data?.versions ?? [];

  useEffect(() => {
    if (!editing) setDraft(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id, editing]);

  // The first field takes focus when the form opens, and Escape closes it — the disclosure the
  // accessibility review (§11) describes for Amend.
  useEffect(() => {
    if (editing) firstField.current?.focus();
  }, [editing]);

  /**
   * Compose the thesis sentence from the fields, and put it in the box for editing.
   *
   * Reads the DRAFT rather than the saved version, so it writes from what you have just typed —
   * otherwise "add a sector then rewrite it" would silently ignore the sector. It proposes into the
   * box rather than saving: the partner reads it, changes it, and saves a version like any other.
   * A model quietly rewriting the mandate would show up in the history as theirs.
   */
  async function writeStatement() {
    setEditing(true);
    setWriting(true);
    setMessage(null);
    const from = editing ? draft : current;
    const res = await api<{ statement?: string; needs?: string; detail?: string; error?: string }>("/api/thesis/statement", {
      method: "POST",
      body: {
        fund_name: fund?.name ?? "the fund",
        sectors: from.sectors ?? [],
        stage: from.stage ?? [],
        geography: from.geography ?? [],
        cross_cutting_filter: from.cross_cutting_filter ?? null,
        check_min_usd: from.check_size_usd?.min ?? null,
        check_max_usd: from.check_size_usd?.max ?? null,
        target_ownership_pct: from.target_ownership_pct ?? null,
        target_positions: from.target_positions ?? null,
        open_question: from.open_question ?? null,
      },
    });
    setWriting(false);
    if (res.status === 200 && res.data?.statement) {
      setDraft({ ...from, thesis_statement: res.data.statement });
      setMessage("Written from the fields. Edit it, then save it as a new version.");
    } else if (res.data?.needs) {
      // Declining is a real answer, and it names the field that would fix it.
      setMessage(`Not enough to write from yet — ${res.data.needs}`);
    } else {
      setMessage(`Could not write it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    }
  }

  async function save() {
    if (!fund) return;
    setSaving(true);
    const nextVersion = history.reduce((max, v) => Math.max(max, v.version_no), 0) + 1;
    const res = await api<{ error?: string; detail?: string }>(`/api/funds/${fund.id}/policies/mandate`, {
      method: "POST",
      body: {
        version_no: nextVersion,
        effective_from: new Date().toISOString().slice(0, 10),
        policy: draft,
      },
    });
    setSaving(false);
    if (res.status === 201) {
      setMessage(`Saved as version ${nextVersion}. The previous version is kept.`);
      setEditing(false);
      versions.reload();
    } else {
      setMessage(`Not saved: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`);
    }
  }

  if (selected.loading) return <p data-testid="thesis-loading">Loading…</p>;

  if (!fund) {
    return (
      <section data-testid="thesis-page">
        <FundPicker selected={selected} />
        <p className="state-empty" data-testid="thesis-no-fund">
          No fund exists yet, so there is nothing for a thesis to belong to. Create the fund first —
          the mandate is a policy version on a fund, not a standalone document.
        </p>
      </section>
    );
  }

  // One good outcome has to return the fund. Entry ownership roughly halves by exit through later
  // dilution, so this is the number the check size is really buying.
  const entry = editing ? draft.target_ownership_pct : current.target_ownership_pct;
  const size = editing ? draft.target_size_usd : current.target_size_usd;
  const exitOwnership = entry ? entry / 2 : null;
  const returnerUsd = exitOwnership && size ? size / (exitOwnership / 100) : null;

  /*
   * THE FIT RAIL. Six checks in the order Wyatt applies them (§7): Stage → Sector → Filter →
   * Cheque → Ownership → Shape. Ink = the check has a value in the current version; unfilled = the
   * version does not say; orange = the filter, because it is the one judgement call among six
   * lookups. Nodes are not buttons — there is no list to filter — so they are `aria-hidden` and
   * the label column carries the meaning.
   */
  const sectorCount = current.sectors?.length ?? 0;
  const checks: Array<{ key: string; label: string; value: string | null; judgement?: boolean }> = [
    { key: "stage", label: "Stage", value: list(current.stage) },
    { key: "sector", label: "Sector", value: list(current.sectors) },
    {
      key: "filter",
      label: "The filter",
      value: current.cross_cutting_filter
        ? `${current.cross_cutting_filter} — applied across all ${sectorCount > 1 ? sectorCount : "sectors"}`
        : null,
      judgement: true,
    },
    {
      key: "cheque",
      label: "Cheque",
      value:
        current.check_size_usd?.min !== undefined || current.check_size_usd?.max !== undefined
          ? `${usdFull(current.check_size_usd?.min)} – ${usdFull(current.check_size_usd?.max)}`
          : null,
    },
    {
      key: "ownership",
      label: "Ownership",
      value:
        current.target_ownership_pct !== undefined
          ? `${current.target_ownership_pct}%${current.minimum_ownership_pct !== undefined ? ` · walk below ${current.minimum_ownership_pct}%` : ""}`
          : null,
    },
    {
      key: "shape",
      label: "Shape",
      value:
        [
          current.target_positions !== undefined ? `${current.target_positions} positions` : null,
          current.target_size_usd !== undefined
            ? `${usd(current.target_size_usd)}${current.hard_cap_usd ? ` (cap ${usd(current.hard_cap_usd)})` : ""}`
            : null,
          list(current.geography),
        ]
          .filter(Boolean)
          .join(" · ") || null,
    },
  ];
  const filledChecks = checks.filter((c) => c.value !== null).length;

  return (
    <section data-testid="thesis-page">
      <FundPicker selected={selected} />

      {/* THE MASTHEAD (§2): eyebrow → answer → detail. The answer is derived from what the page
          loaded — whether a version exists and how many checks it fills — never a fixed slogan. */}
      <div className="masthead" data-testid="thesis-masthead">
        <p className="masthead-date" data-testid="thesis-eyebrow">
          {fund.name} · investment thesis · {history.length === 0 ? "no version yet" : `version ${latest!.version_no} of ${history.length}`}
        </p>
        <h2 data-testid="thesis-answer">
          {!latest
            ? "Nothing to screen against yet."
            : filledChecks === checks.length
              ? "One sentence, and the numbers it commits us to."
              : `One sentence, and ${filledChecks} of ${checks.length} numbers it commits us to.`}
        </h2>
        <p className="masthead-second" data-testid="thesis-second">
          Every company on Dealflow is screened against this, not against instinct. Amending never
          overwrites: it writes a new version and keeps the old one readable.
        </p>
      </div>

      {message && (
        <p className="notice" data-testid="thesis-message" role="status">
          {message}
        </p>
      )}

      <article className="thesis-doc" data-testid="thesis-current">
        {/*
          THE STATEMENT, ON THE ACCENT, IN A SERIF — [BRAND-CONSTRAINED — INTENTIONAL, NO CHANGE].

          This is the one block in the product where orange fills a whole field rather than marking
          an edge. Its area is ~12% of a desktop viewport, over Hallmark gate 25's ~5% accent ceiling,
          and it is KEPT as the recorded exception (design/DEALS_SECTION_DESIGN.md §1.5 #3, §13 Q3,
          owner's decision 18 Sep 2026). It earns it by being the one sentence everything else on
          this page — and on Dealflow — is downstream of. The top-rule alternative `.thesis-statement`
          exists in the stylesheet and is deliberately NOT worn.
        */}
        <div className="thesis-banner" data-testid="thesis-banner">
          {current.thesis_statement ? (
            <p className="thesis-banner-statement" data-testid="thesis-statement">
              {current.thesis_statement}
            </p>
          ) : (
            <p className="thesis-banner-empty" data-testid="thesis-empty">
              No thesis written yet. Press <strong>Amend the thesis</strong>, fill in the fields and press{" "}
              <strong>Write it for me</strong>, or type the sentence yourself — until it exists, nothing
              can be screened against it.
            </p>
          )}

          {latest && (
            // The date is `effective_from` as the version records it — never today, never a stand-in.
            <p className="thesis-doc-stamp" data-testid="thesis-version">
              <span>Version {latest.version_no}</span>
              <span>effective {latest.effective_from}</span>
            </p>
          )}
        </div>

        {latest && (
          <div className="thesis-doc-grid" data-testid="thesis-fit">
            <p className="eyebrow">What a company must be, in the order it is checked</p>
            <ul className="stage-rail" aria-label="What a company must be, in the order it is checked" data-testid="thesis-rail">
              {checks.map((c, i) => (
                <li key={c.key} data-testid={`thesis-check-${c.key}`}>
                  <div className="stage-rail-line">
                    <i />
                    {/* Literal class strings, one branch each: validate:css-classes reads only the
                        literal fragments of a className, and the register must see these worn. */}
                    {c.judgement ? (
                      <span className="stage-node stage-node-current" aria-hidden="true">{i + 1}</span>
                    ) : c.value !== null ? (
                      <span className="stage-node stage-node-filled" aria-hidden="true">{i + 1}</span>
                    ) : (
                      <span className="stage-node" aria-hidden="true">{i + 1}</span>
                    )}
                    <i />
                  </div>
                  <span className="stage-label">
                    {c.label}
                    {c.judgement && <span className="sr-only"> — the judgement call</span>}
                  </span>
                  <span className="stage-q">{c.value ?? "not set in this version"}</span>
                </li>
              ))}
            </ul>

            {returnerUsd && !editing && (
              <p className="muted small" data-testid="thesis-consequence">
                At {entry}% entry — roughly {exitOwnership!.toFixed(1)}% after dilution — a single company would
                need about <strong>{usdFull(Math.round(returnerUsd))}</strong> at exit to return the fund on its
                own. That is what the cheque size is buying.
              </p>
            )}

            {current.open_question && (
              <p className="notice" data-testid="thesis-open-question">
                Unresolved: {current.open_question}
              </p>
            )}
          </div>
        )}
      </article>

      {/* THE INPUTS, BEHIND AMEND. Saving writes a new version and keeps the old one. */}
      {editing && (
        <section className="card" data-testid="thesis-inputs" id="thesis-inputs">
          <div className="section-head">
            <h3>Amend the thesis</h3>
            <span className="muted small">saving writes a new version — nothing is overwritten</span>
          </div>

          <form
            data-testid="thesis-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              }
            }}
          >
            <label>
              Thesis, in a sentence
              <textarea
                ref={firstField}
                data-testid="thesis-input-statement"
                rows={3}
                value={draft.thesis_statement ?? ""}
                onChange={(e) => setDraft({ ...draft, thesis_statement: e.target.value })}
              />
            </label>
            <label>
              Sectors <span className="muted small">comma separated</span>
              <input
                data-testid="thesis-input-sectors"
                value={(draft.sectors ?? []).join(", ")}
                onChange={(e) => setDraft({ ...draft, sectors: toList(e.target.value) })}
              />
            </label>
            <label>
              Applied across all sectors
              <input
                data-testid="thesis-input-filter"
                value={draft.cross_cutting_filter ?? ""}
                onChange={(e) => setDraft({ ...draft, cross_cutting_filter: e.target.value })}
              />
            </label>
            <label>
              Stage <span className="muted small">comma separated</span>
              <input
                data-testid="thesis-input-stage"
                value={(draft.stage ?? []).join(", ")}
                onChange={(e) => setDraft({ ...draft, stage: toList(e.target.value) })}
              />
            </label>
            <div className="form-row">
              <label>
                Cheque minimum, USD
                <input
                  type="number"
                  data-testid="thesis-input-check-min"
                  value={draft.check_size_usd?.min ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, check_size_usd: { ...draft.check_size_usd, min: Number(e.target.value) } })
                  }
                />
              </label>
              <label>
                Cheque maximum, USD
                <input
                  type="number"
                  data-testid="thesis-input-check-max"
                  value={draft.check_size_usd?.max ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, check_size_usd: { ...draft.check_size_usd, max: Number(e.target.value) } })
                  }
                />
              </label>
            </div>
            <div className="form-row">
              <label>
                Target ownership, %
                <input
                  type="number"
                  step="0.1"
                  data-testid="thesis-input-ownership"
                  value={draft.target_ownership_pct ?? ""}
                  onChange={(e) => setDraft({ ...draft, target_ownership_pct: Number(e.target.value) })}
                />
              </label>
              <label>
                Walk below, %
                <input
                  type="number"
                  step="0.1"
                  data-testid="thesis-input-minimum"
                  value={draft.minimum_ownership_pct ?? ""}
                  onChange={(e) => setDraft({ ...draft, minimum_ownership_pct: Number(e.target.value) })}
                />
              </label>
              <label>
                Target positions
                <input
                  type="number"
                  data-testid="thesis-input-positions"
                  value={draft.target_positions ?? ""}
                  onChange={(e) => setDraft({ ...draft, target_positions: Number(e.target.value) })}
                />
              </label>
            </div>
            {returnerUsd && (
              <p className="muted small" data-testid="thesis-live-consequence">
                One company would need about {usdFull(Math.round(returnerUsd))} at exit to return the fund.
              </p>
            )}
            <div className="form-row">
              <button type="submit" className="btn-strong" disabled={saving} data-testid="thesis-save">
                {saving ? "Saving…" : "Save as new version"}
              </button>
              <button type="button" className="btn-ghost" data-testid="thesis-cancel" onClick={() => setEditing(false)}>
                Never mind
              </button>
              <span className="muted small">Signed as {me.fullName}. The current version is kept and stays readable.</span>
            </div>
          </form>
        </section>
      )}

      <div className="two-col">
        <ConstructionCard fundId={fund.id} mandate={current} />

        {/* VERSIONS: the record, not a changelog. Every version the firm has held, newest first;
            nothing is edited or removed — "what were we looking for when we passed on that company"
            is a question you will eventually need to answer. */}
        <section className="card" data-testid="thesis-history">
          <div className="section-head">
            <h3>Versions</h3>
            <span className="muted small">nothing is overwritten</span>
          </div>
          <div className="version-rail" data-testid="thesis-version-rail">
            {history.length === 0 ? (
              <span>no version yet — the first amendment becomes v1</span>
            ) : (
              <>
                {[...history].reverse().map((v) =>
                  latest && v.id === latest.id ? (
                    <span key={v.id} className="v v-current" data-testid={`thesis-v-${v.version_no}`}>
                      v{v.version_no} · current
                    </span>
                  ) : (
                    <span key={v.id} className="v" data-testid={`thesis-v-${v.version_no}`}>
                      v{v.version_no}
                    </span>
                  ),
                )}
                <span>← the next amendment becomes v{history.reduce((m, v) => Math.max(m, v.version_no), 0) + 1}</span>
              </>
            )}
          </div>
          <ul className="card-list" data-testid="thesis-version-list">
            {[...history].reverse().map((v) => (
              <li key={v.id} data-testid={`thesis-version-${v.version_no}`}>
                <strong>v{v.version_no}</strong>
                <span className="muted small">
                  {" "}
                  — effective {v.effective_from} · recorded {v.created_at.slice(0, 10)}
                </span>
              </li>
            ))}
            {history.length === 0 && <li className="state-empty">No versions yet.</li>}
          </ul>
          <div className="form-row thesis-doc-actions">
            {/* Eight states of the one primary act on this page: default · hover · focus (global
                ring) · active · expanded (aria-expanded) · disabled with the reason while a save
                is in flight · the notice above carries error and success. */}
            <button
              type="button"
              className="btn-strong"
              data-testid="thesis-edit-toggle"
              aria-expanded={editing}
              aria-controls="thesis-inputs"
              disabled={saving}
              title={saving ? "Saving the new version" : undefined}
              onClick={() => {
                setMessage(null);
                setEditing((e) => !e);
              }}
            >
              {editing ? "Close without saving" : "Amend the thesis"}
            </button>
            <button type="button" className="btn-ghost" disabled={writing} data-testid="thesis-write" onClick={() => void writeStatement()}>
              {writing ? "Writing…" : "Write it for me"}
            </button>
            <button type="button" className="link-button" data-testid="thesis-print" onClick={() => window.print()}>
              Print or save as PDF
            </button>
          </div>
        </section>
      </div>
    </section>
  );
}

/**
 * Portfolio construction — the reserve and concentration decisions, editable on the same terms as
 * the thesis above, with the sleeves and the fee estimate read beside them.
 *
 * These are separate policy kinds rather than fields on the mandate because the allocation engine
 * reads them directly: `allocation.ts` pulls `reserve_pct` and `max_single_company_pct` when it
 * checks whether an option fits. So a number changed here changes what the system will tell you
 * about a deal, which is exactly why it belongs on a screen instead of in a seed script.
 *
 * THE DOLLARS ARE COMPUTED, NOT STORED — `src/shared/fund/sleeveMath.ts` explains why storing both
 * a percentage and a dollar figure put $200K between two readings of the same fund. Reserves are
 * `reserveUsd(sleeve, reserve)`; the concentration cap is the percentage of the mandate's committed
 * size. Where a policy is absent the cell says "not set", and no dollar figure is shown for it.
 *
 * Versioned for the same reason as the mandate. A reserve policy that quietly changed is the
 * hardest kind of drift to reconstruct afterwards, because nothing about the portfolio looks
 * different until the follow-on you cannot fund.
 */
function ConstructionCard({ fundId, mandate }: { fundId: string; mandate: Mandate }) {
  const reserve = useApi<PolicyList>(`/api/funds/${fundId}/policies/reserve`, [fundId]);
  const concentration = useApi<PolicyList>(`/api/funds/${fundId}/policies/concentration`, [fundId]);
  const sleeve = useApi<PolicyList>(`/api/funds/${fundId}/policies/sleeve`, [fundId]);

  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reservePct, setReservePct] = useState<string>("");
  const [maxPct, setMaxPct] = useState<string>("");
  const firstField = useRef<HTMLInputElement>(null);

  const latestReserve = reserve.data?.current ?? undefined;
  const latestConc = concentration.data?.current ?? undefined;
  const reserveDoc = policyDoc<ReserveDoc>(latestReserve);
  const concDoc = policyDoc<{ max_single_company_pct?: number; basis?: string }>(latestConc);
  const sleeveDoc = policyDoc<SleeveDoc>(sleeve.data?.current);
  const currentReserve = reserveDoc.reserve_pct;
  const currentMax = concDoc.max_single_company_pct;

  const reservesUsd = latestReserve && sleeve.data?.current ? reserveUsd(sleeveDoc, reserveDoc) : null;
  const maxUsd = currentMax !== undefined && mandate.target_size_usd !== undefined ? (currentMax / 100) * mandate.target_size_usd : null;
  const sleeves = (sleeveDoc.sleeves ?? []).map((s) => ({
    key: s.key,
    pct: s.target_pct,
    usd: sleeveTargetUsd(sleeveDoc, s),
  }));
  const investable =
    typeof sleeveDoc.estimated_investable_usd === "number"
      ? sleeveDoc.estimated_investable_usd
      : sleeveDoc.committed_usd
        ? sleeveDoc.committed_usd - (sleeveDoc.estimated_fees_usd ?? 0) - (sleeveDoc.estimated_expenses_usd ?? 0)
        : null;

  useEffect(() => {
    if (!editing) {
      setReservePct(currentReserve === undefined ? "" : String(currentReserve));
      setMaxPct(currentMax === undefined ? "" : String(currentMax));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestReserve?.id, latestConc?.id, editing]);

  useEffect(() => {
    if (editing) firstField.current?.focus();
  }, [editing]);

  async function saveBoth() {
    const today = new Date().toISOString().slice(0, 10);
    const next = (l: PolicyVersion[] | undefined) => (l ?? []).reduce((max, v) => Math.max(max, v.version_no), 0) + 1;
    const failures: string[] = [];

    if (reservePct !== "" && Number(reservePct) !== currentReserve) {
      const res = await api<{ error?: string }>(`/api/funds/${fundId}/policies/reserve`, {
        method: "POST",
        body: { version_no: next(reserve.data?.versions), effective_from: today, policy: { ...reserveDoc, reserve_pct: Number(reservePct) } },
      });
      if (res.status !== 201) failures.push(`reserves (HTTP ${res.status})`);
    }

    if (maxPct !== "" && Number(maxPct) !== currentMax) {
      const res = await api<{ error?: string }>(`/api/funds/${fundId}/policies/concentration`, {
        method: "POST",
        body: { version_no: next(concentration.data?.versions), effective_from: today, policy: { ...concDoc, max_single_company_pct: Number(maxPct) } },
      });
      if (res.status !== 201) failures.push(`concentration (HTTP ${res.status})`);
    }

    setMessage(failures.length ? `Not saved: ${failures.join(", ")}.` : "Saved as new versions. Previous ones are kept.");
    if (!failures.length) setEditing(false);
    reserve.reload();
    concentration.reload();
  }

  return (
    <section className="card" data-testid="construction-card">
      <div className="section-head">
        <h3>Construction</h3>
        <button
          type="button"
          className="link-button"
          data-testid="construction-edit-toggle"
          aria-expanded={editing}
          onClick={() => {
            setMessage(null);
            setEditing((e) => !e);
          }}
        >
          {editing ? "Never mind" : "Amend"}
        </button>
      </div>

      {message && (
        <p className="notice" data-testid="construction-message" role="status">
          {message}
        </p>
      )}

      {!editing ? (
        <dl className="thesis-grid">
          <div>
            <dt>Reserves</dt>
            <dd data-testid="construction-reserve">
              {currentReserve === undefined
                ? "not set"
                : `${currentReserve}% of the early sleeve${reservesUsd !== null ? ` · ${usdFull(reservesUsd)}` : ""}`}
            </dd>
          </div>
          <div>
            <dt>Maximum in one company</dt>
            <dd data-testid="construction-max">
              {currentMax === undefined ? "not set" : `${currentMax}% of committed capital${maxUsd !== null ? ` · ${usdFull(maxUsd)}` : ""}`}
            </dd>
          </div>
          <div>
            <dt>Sleeves</dt>
            <dd data-testid="construction-sleeves">
              {sleeves.length === 0
                ? "not set"
                : `${sleeves.map((s) => `${s.pct !== undefined ? `${s.pct}%` : usd(s.usd)} ${s.key === "EARLY_STAGE_PRIMARY" ? "primary" : s.key === "SECONDARY_PURCHASE" ? "secondary" : humanise(s.key)}`).join(" · ")}${investable !== null ? `, of ${usd(investable)} investable` : ""}`}
            </dd>
          </div>
          <div>
            <dt>Fees and expenses</dt>
            <dd data-testid="construction-fees">
              {sleeveDoc.estimated_fees_usd === undefined && sleeveDoc.estimated_expenses_usd === undefined
                ? "not set"
                : `${usdFull(sleeveDoc.estimated_fees_usd ?? 0)} + ${usdFull(sleeveDoc.estimated_expenses_usd ?? 0)}, off the top`}
            </dd>
          </div>
        </dl>
      ) : (
        <form
          data-testid="construction-form"
          onSubmit={(e) => {
            e.preventDefault();
            void saveBoth();
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              setEditing(false);
            }
          }}
        >
          <div className="form-row">
            <label>
              Reserves, % of the early sleeve
              <input ref={firstField} type="number" step="1" data-testid="construction-input-reserve" value={reservePct} onChange={(e) => setReservePct(e.target.value)} />
            </label>
            <label>
              Max in one company, % of committed
              <input type="number" step="1" data-testid="construction-input-max" value={maxPct} onChange={(e) => setMaxPct(e.target.value)} />
            </label>
          </div>
          <p className="muted small">
            At pre-seed, reserves below roughly a third of the sleeve mean the best company in the portfolio raises
            a Series A you cannot follow. Sleeves and the fee estimate are the sleeve policy; amend them on Fund
            strategy.
          </p>
          <button type="submit" className="btn-strong" data-testid="construction-save">
            Save as new versions
          </button>
        </form>
      )}
      <p className="muted small">
        Fund strategy reads these directly when it checks whether a deal fits, so changing a number here changes
        what the system tells you about the next one. The plan ring lives there.
      </p>
    </section>
  );
}
