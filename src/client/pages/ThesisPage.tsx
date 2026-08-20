import { useEffect, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { useSelectedFund } from "../lib/selectedFund";
import { FundPicker } from "./FundPicker";

/**
 * The thesis — the firm's investment mandate, editable, and versioned rather than overwritten.
 *
 * WHY IT EXISTS. The mandate is what the firm is looking for, and it is the input the scout
 * searches against. It lived only in `investment_mandate_version` with no surface at all, so the
 * one thing the operator said would change often was the one thing that could not be changed.
 *
 * WHY EDITING WRITES A NEW VERSION. `investment_mandate_version` is keyed UNIQUE(fund_id,
 * version_no) and nothing here updates a row. That is the point: "what were we looking for when we
 * passed on that company in March" is a question a fund actually has to answer, and it is
 * unanswerable the moment an edit overwrites its predecessor. Saving therefore reads the current
 * highest version, adds one, and posts. The history below is the record, not a changelog.
 *
 * WHAT THE NUMBERS MEAN. Check size and target ownership are not decoration — the ownership figure
 * is what decides whether one good outcome can return the fund, so it is shown with its
 * consequence attached rather than as a bare field. The arithmetic is deliberately done here and
 * not by a model: it is one division, and a number the operator will act on should not arrive from
 * something that can hallucinate.
 */

interface PolicyVersion {
  id: string;
  version_no: number;
  effective_from: string;
  mandate_json?: string;
  created_by: string;
  created_at: string;
}

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

const usd = (n: number | undefined): string =>
  n === undefined || n === null || Number.isNaN(n)
    ? "—"
    : n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
      : n >= 1_000
        ? `$${Math.round(n / 1_000)}K`
        : `$${n}`;

/** Comma or newline separated, trimmed, blanks dropped. */
const toList = (s: string): string[] => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

export function ThesisPage({ me }: { me: MeResponse }) {
  const selected = useSelectedFund();
  const fund = selected.fund;
  const versions = useApi<{ versions: PolicyVersion[] }>(
    fund ? `/api/funds/${fund.id}/policies/mandate` : null,
    [fund?.id],
  );

  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);

  /**
   * Compose the thesis sentence from the fields, and put it in the box for editing.
   *
   * Reads the DRAFT rather than the saved version, so it writes from what you have just typed —
   * otherwise "add a sector then rewrite it" would silently ignore the sector.
   */
  async function writeStatement() {
    setWriting(true);
    setMessage(null);
    const res = await api<{ statement?: string; needs?: string; detail?: string; error?: string }>(
      "/api/thesis/statement",
      {
        method: "POST",
        body: {
          fund_name: fund?.name ?? "the fund",
          sectors: draft.sectors ?? [],
          stage: draft.stage ?? [],
          geography: draft.geography ?? [],
          cross_cutting_filter: draft.cross_cutting_filter ?? null,
          check_min_usd: draft.check_size_usd?.min ?? null,
          check_max_usd: draft.check_size_usd?.max ?? null,
          target_ownership_pct: draft.target_ownership_pct ?? null,
          target_positions: draft.target_positions ?? null,
          open_question: draft.open_question ?? null,
        },
      },
    );
    setWriting(false);
    if (res.status === 200 && res.data?.statement) {
      setDraft({ ...draft, thesis_statement: res.data.statement });
      setMessage("Written from the fields below. Edit it, then save it as a new version.");
    } else if (res.data?.needs) {
      // Declining is a real answer, and it names the field that would fix it.
      setMessage(`Not enough to write from yet — ${res.data.needs}`);
    } else {
      setMessage(`Could not write it: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    }
  }

  const [draft, setDraft] = useState<Mandate>({});

  // Versions come back newest-first; the top row is what the firm is looking for today.
  const latest = versions.data?.versions?.[0] ?? null;
  let current: Mandate = {};
  try {
    current = latest?.mandate_json ? (JSON.parse(latest.mandate_json) as Mandate) : {};
  } catch {
    current = {};
  }

  useEffect(() => {
    if (!editing) setDraft(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest?.id, editing]);

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

  async function save() {
    if (!fund) return;
    const nextVersion = (versions.data?.versions ?? []).reduce((max, v) => Math.max(max, v.version_no), 0) + 1;
    const res = await api<{ error?: string; detail?: string }>(`/api/funds/${fund.id}/policies/mandate`, {
      method: "POST",
      body: {
        version_no: nextVersion,
        effective_from: new Date().toISOString().slice(0, 10),
        policy: draft,
      },
    });
    if (res.status === 201) {
      setMessage(`Saved as version ${nextVersion}. The previous version is kept.`);
      setEditing(false);
      versions.reload();
    } else {
      setMessage(`Not saved: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`);
    }
  }

  // One good outcome has to return the fund. Entry ownership roughly halves by exit through later
  // dilution, so this is the number the check size is really buying.
  const entry = draft.target_ownership_pct ?? current.target_ownership_pct;
  const size = draft.target_size_usd ?? current.target_size_usd;
  const exitOwnership = entry ? entry / 2 : null;
  const returnerUsd = exitOwnership && size ? size / (exitOwnership / 100) : null;

  return (
    <section data-testid="thesis-page">
      <FundPicker selected={selected} />
      <p className="muted small">
        This is what Wyatt searches against, so changing it changes what gets brought to you.
        Amending never overwrites — it writes a new version and keeps the old one.
      </p>

      {message && <p className="notice" data-testid="thesis-message">{message}</p>}

      {/*
        THE THESIS IS THE DOCUMENT, not a panel of settings for one.

        This rendered as an <h3> over a definition list inside a card, at the same visual weight as
        the version history beneath it — so the single most consequential statement the firm makes
        about what it invests in read as a settings screen. The operator asked for the thing itself
        to look official, and it should: this is what gets put in front of an LP.

        Nothing about the data changed. Reading and editing were simply separated, and the reading
        half was given document scale, a stamp, and print styles.
      */}
      <article className="thesis-doc" data-testid="thesis-current">
        <header className="thesis-doc-head">
          <div>
            <p className="thesis-doc-firm">{fund.name}</p>
            <h2 className="thesis-doc-title">Investment thesis</h2>
          </div>
          <button type="button" className="link-button" data-testid="thesis-print" onClick={() => window.print()}>
            Print or save as PDF
          </button>
        </header>

        {/*
          THE STATEMENT, ON THE ACCENT, IN A SERIF.

          The operator wanted the thesis itself at the top and the inputs beneath it, and they were
          right that a toggle was the wrong shape — you edit a thesis while looking at it, not
          instead of looking at it. So the banner is always the top of the page and the fields are
          always below it, and saving updates what you are already reading.

          This is the one block in the product where orange fills a whole field rather than marking
          an edge. It earns that by being the one sentence everything else is downstream of.
        */}
        <div className="thesis-banner" data-testid="thesis-banner">
          {current.thesis_statement ? (
            <p className="thesis-banner-statement" data-testid="thesis-statement">
              {current.thesis_statement}
            </p>
          ) : (
            <p className="thesis-banner-empty" data-testid="thesis-empty">
              No thesis written yet. Fill in the fields below and press <strong>Write it for me</strong>,
              or type the sentence yourself — until it exists, nothing can be screened against it.
            </p>
          )}

          {latest && (
            <p className="thesis-doc-stamp" data-testid="thesis-version">
              <span>Version {latest.version_no}</span>
              <span>
                Adopted{" "}
                {new Date(latest.created_at).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
              </span>
            </p>
          )}
        </div>

        {latest && (
          <>
            <dl className="thesis-grid thesis-doc-grid">
              <div><dt>Sectors</dt><dd data-testid="thesis-sectors">{(current.sectors ?? []).join(" · ") || "—"}</dd></div>
              <div><dt>Stage</dt><dd>{(current.stage ?? []).join(" · ") || "—"}</dd></div>
              <div><dt>Applied across all sectors</dt><dd>{current.cross_cutting_filter ?? "—"}</dd></div>
              <div><dt>Geography</dt><dd>{(current.geography ?? []).join(" · ") || "—"}</dd></div>
              <div>
                <dt>Initial check</dt>
                <dd data-testid="thesis-check">
                  {usd(current.check_size_usd?.min)} – {usd(current.check_size_usd?.max)}
                </dd>
              </div>
              <div>
                <dt>Target ownership</dt>
                <dd data-testid="thesis-ownership">
                  {current.target_ownership_pct ?? "—"}%{" "}
                  {current.minimum_ownership_pct !== undefined && (
                    <span className="muted small">(walk below {current.minimum_ownership_pct}%)</span>
                  )}
                </dd>
              </div>
              <div><dt>Target positions</dt><dd>{current.target_positions ?? "—"}</dd></div>
              <div><dt>Fund size</dt><dd>{usd(current.target_size_usd)}{current.hard_cap_usd ? ` (cap ${usd(current.hard_cap_usd)})` : ""}</dd></div>
            </dl>

            {returnerUsd && (
              <p className="muted small" data-testid="thesis-consequence">
                At {entry}% entry — roughly {exitOwnership!.toFixed(1)}% after dilution — a single
                company would need about <strong>{usd(Math.round(returnerUsd))}</strong> at exit to
                return the fund on its own. That is what the check size is buying.
              </p>
            )}

            {current.open_question && (
              <p className="notice" data-testid="thesis-open-question">
                Unresolved: {current.open_question}
              </p>
            )}
          </>
        )}
      </article>

      {/* THE INPUTS, ALWAYS VISIBLE. Amending writes a new version and keeps the old one. */}
      <section className="card" data-testid="thesis-inputs">
        <div className="home-section-head">
          <h3>What it is built from</h3>
          <span className="muted small">saving writes a new version — nothing is overwritten</span>
        </div>

        {(
          <form
            data-testid="thesis-form"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              Thesis, in a sentence
              <textarea
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
                Check minimum
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
                Check maximum
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
                Target ownership %
                <input
                  type="number"
                  step="0.1"
                  data-testid="thesis-input-ownership"
                  value={draft.target_ownership_pct ?? ""}
                  onChange={(e) => setDraft({ ...draft, target_ownership_pct: Number(e.target.value) })}
                />
              </label>
              <label>
                Walk below %
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
                One company would need about {usd(Math.round(returnerUsd))} at exit to return the fund.
              </p>
            )}
            <div className="form-row">
              <button type="submit" className="btn-strong" data-testid="thesis-save">
                Save as new version
              </button>
              {/* WRITE THE SENTENCE FROM THE FIELDS. It proposes into the box above rather than
                  saving — the partner reads it, changes it, and saves a version like any other.
                  A model quietly rewriting the mandate would show up in the history as theirs. */}
              <button
                type="button"
                disabled={writing}
                data-testid="thesis-write"
                onClick={() => void writeStatement()}
              >
                {writing ? "Writing…" : "Write it for me"}
              </button>
              <span className="muted small">
                Signed as {me.fullName}. The current version is kept and stays readable.
              </span>
            </div>
          </form>
        )}
      </section>

      <ConstructionCard fundId={fund.id} />

      {/* HISTORY IS REFERENCE, NOT THE PAGE. It sat at the same weight as the thesis itself, so
          the document competed with its own changelog. Folded, and the summary carries the only
          part you usually want — which version you are on. */}
      <details className="card" data-testid="thesis-history">
        <summary>
          History <span className="muted small">{(versions.data?.versions ?? []).length} versions</span>
        </summary>
        <p className="muted small">
          Every version the firm has held, newest first. Nothing here is edited or removed —
          “what were we looking for when we passed on that company” is a question you will
          eventually need to answer.
        </p>
        <ul className="card-list">
          {(versions.data?.versions ?? []).map((v) => (
            <li key={v.id} data-testid={`thesis-version-${v.version_no}`}>
              <strong>v{v.version_no}</strong> — effective {v.effective_from}
              <span className="muted small"> · recorded {v.created_at.slice(0, 10)}</span>
            </li>
          ))}
          {(versions.data?.versions ?? []).length === 0 && (
            <li className="state-empty">No versions yet.</li>
          )}
        </ul>
      </details>
    </section>
  );
}

/**
 * Portfolio construction — the reserve and concentration decisions, editable on the same terms as
 * the thesis above.
 *
 * These are separate policy kinds rather than fields on the mandate because the allocation engine
 * reads them directly: `allocation.ts` pulls `reserve_pct` and `max_single_company_pct` when it
 * checks whether an option fits. So a number changed here changes what the system will tell you
 * about a deal, which is exactly why it belongs on a screen instead of in a seed script.
 *
 * Versioned for the same reason as the mandate. A reserve policy that quietly changed is the
 * hardest kind of drift to reconstruct afterwards, because nothing about the portfolio looks
 * different until the follow-on you cannot fund.
 */
function ConstructionCard({ fundId }: { fundId: string }) {
  const reserve = useApi<{ versions: PolicyVersion[] }>(`/api/funds/${fundId}/policies/reserve`, [fundId]);
  const concentration = useApi<{ versions: PolicyVersion[] }>(`/api/funds/${fundId}/policies/concentration`, [fundId]);

  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [reservePct, setReservePct] = useState<string>("");
  const [maxPct, setMaxPct] = useState<string>("");

  /** Policy rows come back with a `<kind>_json` column; read whichever one is present. */
  const parse = (v: PolicyVersion | undefined): Record<string, unknown> => {
    const raw = (v as unknown as Record<string, string> | undefined);
    const blob = raw?.reserve_json ?? raw?.concentration_json ?? raw?.mandate_json;
    try {
      return blob ? (JSON.parse(blob) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const latestReserve = reserve.data?.versions?.[0];
  const latestConc = concentration.data?.versions?.[0];
  const currentReserve = parse(latestReserve).reserve_pct as number | undefined;
  const currentMax = parse(latestConc).max_single_company_pct as number | undefined;

  useEffect(() => {
    if (!editing) {
      setReservePct(currentReserve === undefined ? "" : String(currentReserve));
      setMaxPct(currentMax === undefined ? "" : String(currentMax));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestReserve?.id, latestConc?.id, editing]);

  async function saveBoth() {
    const today = new Date().toISOString().slice(0, 10);
    const next = (list: PolicyVersion[] | undefined) =>
      (list ?? []).reduce((max, v) => Math.max(max, v.version_no), 0) + 1;

    const failures: string[] = [];

    if (reservePct !== "" && Number(reservePct) !== currentReserve) {
      const res = await api<{ error?: string }>(`/api/funds/${fundId}/policies/reserve`, {
        method: "POST",
        body: {
          version_no: next(reserve.data?.versions),
          effective_from: today,
          policy: { ...parse(latestReserve), reserve_pct: Number(reservePct) },
        },
      });
      if (res.status !== 201) failures.push(`reserves (HTTP ${res.status})`);
    }

    if (maxPct !== "" && Number(maxPct) !== currentMax) {
      const res = await api<{ error?: string }>(`/api/funds/${fundId}/policies/concentration`, {
        method: "POST",
        body: {
          version_no: next(concentration.data?.versions),
          effective_from: today,
          policy: { ...parse(latestConc), max_single_company_pct: Number(maxPct) },
        },
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
      <header className="module-card-head">
        <h3>Construction</h3>
        <button
          type="button"
          className="link-button"
          data-testid="construction-edit-toggle"
          onClick={() => {
            setMessage(null);
            setEditing((e) => !e);
          }}
        >
          {editing ? "Cancel" : "Edit"}
        </button>
      </header>
      <p className="muted small">
        The allocation view reads these directly when it checks whether a deal fits, so changing a
        number here changes what the system tells you about the next one.
      </p>

      {message && <p className="notice" data-testid="construction-message">{message}</p>}

      {!editing ? (
        <dl className="thesis-grid">
          <div>
            <dt>Reserves</dt>
            <dd data-testid="construction-reserve">
              {currentReserve === undefined ? "not set" : `${currentReserve}% of the early sleeve`}
            </dd>
          </div>
          <div>
            <dt>Maximum in one company</dt>
            <dd data-testid="construction-max">
              {currentMax === undefined ? "not set" : `${currentMax}% of committed capital`}
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
        >
          <div className="form-row">
            <label>
              Reserves %
              <input
                type="number"
                step="1"
                data-testid="construction-input-reserve"
                value={reservePct}
                onChange={(e) => setReservePct(e.target.value)}
              />
            </label>
            <label>
              Max in one company %
              <input
                type="number"
                step="1"
                data-testid="construction-input-max"
                value={maxPct}
                onChange={(e) => setMaxPct(e.target.value)}
              />
            </label>
          </div>
          <p className="muted small">
            At pre-seed, reserves below roughly a third of the sleeve mean the best company in the
            portfolio raises a Series A you cannot follow.
          </p>
          <button type="submit" className="btn-strong" data-testid="construction-save">
            Save as new versions
          </button>
        </form>
      )}
    </section>
  );
}
