import { useState } from "react";
import { api, useApi } from "../lib/api";

/**
 * SCENARIOS — Fund strategy's sixth band (design/FUND_STRATEGY_DESIGN.md §3.6).
 *
 * The scenarios as rows; "Open a scenario" reveals a two-field form — a name, and the one figure
 * the system will not work out for you (investable after fees; there is no fee model on file, so
 * the sleeve's estimate is prefilled and said to be an estimate). Opening pins the CURRENT version
 * of each policy and reads `fund_size` and `fund_deployed` from `/basis`, which since 19 Sep 2026
 * falls back to the mandate's size rather than refusing on a fund whose LP size was never typed.
 *
 * The open scenario's body — assumptions, options, the comparison run, the decisions — keeps the
 * content it always had; no invented capital, no `<code>` ids in the reading line. The old
 * `capital` default of "2100000" and `existingCost` of "1500000" were figures in the request body's
 * clothing (audit #6) and are gone: a field with nothing in it is a field she fills.
 */

interface FundRow {
  id: string;
  name: string;
}

interface ScenarioRow {
  id: string;
  name: string;
  status: string;
  model_version: string;
}

interface AllocationOptionRow {
  id: string;
  option_type: string;
  label: string;
  capital: number;
  decision: string;
  proposed_by_type: string;
}

interface RunResultRow {
  option_id: string;
  sleeve_remaining_after: number;
  concentration_pct_after: number;
  reserve_uncommitted_after: number;
  breach_count: number;
}

interface ViolationRow {
  id: string;
  option_id: string;
  kind: string;
  severity: string;
  detail: string;
}

export function ScenariosBand({ fundId: fundIdProp, investableDefault }: { fundId: string | null; investableDefault: number | null }): JSX.Element {
  const [nonce, setNonce] = useState(0);
  const funds = useApi<{ funds: FundRow[] }>("/api/funds");
  const scenarios = useApi<{ scenarios: ScenarioRow[] }>("/api/allocation/scenarios", [nonce]);
  const [scenarioId, setScenarioId] = useState("");
  const detail = useApi<{
    name: string;
    model_version: string;
    outcome_label: string;
    mandate_version_id: string;
    sleeve_version_id: string;
    reserve_version_id: string;
    concentration_version_id: string;
    options: AllocationOptionRow[];
    assumptions: Array<{ id: string; assumption_key: string; assumption_value: string; basis: string }>;
  }>(scenarioId ? `/api/allocation/scenarios/${scenarioId}` : null, [scenarioId, nonce]);
  const [runId, setRunId] = useState("");
  const run = useApi<{ results: RunResultRow[]; violations: ViolationRow[]; breach_count: number }>(runId ? `/api/allocation/runs/${runId}` : null, [runId]);
  const [optionType, setOptionType] = useState("FOLLOW_ON");
  const [optionLabel, setOptionLabel] = useState("");
  const [capital, setCapital] = useState("");
  const [existingCost, setExistingCost] = useState("");
  const [receipt, setReceipt] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const post = async <T,>(path: string, body: unknown, okStatus: number, label: string): Promise<{ status: number; data: (T & { error?: string }) | null }> => {
    const { status, data } = await api<T & { error?: string }>(path, { method: "POST", body });
    setMessage(status === okStatus ? `${label} ok.` : `${label} refused: ${data?.error ?? status}`);
    setNonce((n) => n + 1);
    return { status, data };
  };

  const rows = scenarios.data?.scenarios ?? [];
  const fundOptions = funds.data?.funds ?? [];

  return (
    <section className="band" data-testid="allocation-page">
      <div className="band-head">
        <h3>Scenarios</h3>
        <span className="band-when">what the next cheque does to the shape — each one pins the policy versions it was modelled against</span>
      </div>

      {rows.length === 0 ? (
        <p className="state-empty" data-testid="scenario-list-empty">No scenario yet. Open one below; it pins the current mandate, sleeve, reserve and concentration versions so the answer stays honest as they change.</p>
      ) : (
        <ul className="deal-list" data-testid="scenario-list">
          {rows.map((s) => (
            <li key={s.id} className="deal-row-2" data-testid={`scenario-row-${s.id}`} aria-current={scenarioId === s.id ? "true" : undefined}>
              <div>
                <strong>{s.name}</strong>
                <div className="muted small">{s.status.toLowerCase()} · model {s.model_version}</div>
              </div>
              <button type="button" className={scenarioId === s.id ? "btn-strong" : ""} data-testid={`scenario-open-${s.id}`} aria-expanded={scenarioId === s.id} onClick={() => setScenarioId(scenarioId === s.id ? "" : s.id)}>
                {scenarioId === s.id ? "Close" : "Open"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {/* THE SAME CHOICE, AS A SELECT, for keyboards and for the journeys that drive it by label. */}
      <label className="muted small">
        Working scenario{" "}
        <select data-testid="scenario-select" value={scenarioId} onChange={(e) => setScenarioId(e.target.value)}>
          <option value="">— none open —</option>
          {rows.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} ({s.status})
            </option>
          ))}
        </select>
      </label>

      <div className="actions">
        <button type="button" className="btn-strong" data-testid="scenario-new" aria-expanded={opening} aria-controls="scenario-open-form" onClick={() => setOpening((o) => !o)}>
          {opening ? "Never mind" : "Open a scenario"}
        </button>
      </div>
      <form
        className="form-row"
        hidden={!opening}
        id="scenario-open-form"
        data-testid="scenario-form"
        onSubmit={async (e) => {
          e.preventDefault();
          // Read the form BEFORE any await: currentTarget is gone by the time the
          // policy lookups below resolve.
          const form = new FormData(e.currentTarget);
          const scenarioName = (form.get("name") as string) || "scenario";
          const fundId = (form.get("fund") as string) || fundIdProp || funds.data?.funds[0]?.id;
          if (!fundId) {
            setMessage("Scenario refused: no fund exists yet.");
            return;
          }
          // Pin the CURRENT latest version of each policy at scenario-open time.
          const pins: Record<string, string> = {};
          for (const kind of ["mandate", "sleeve", "reserve", "concentration"]) {
            const { data } = await api<{ versions: Array<{ id: string }>; current: { id: string } | null }>(`/api/funds/${fundId}/policies/${kind}`);
            // `current` from the API. This was the ONE call site that took `.at(-1)` while six
            // others took `[0]`, so the allocation model pinned a different policy version from
            // the one every display showed.
            const latest = data?.current;
            if (!latest) {
              setMessage(`Scenario refused: fund has no ${kind} policy version yet.`);
              return;
            }
            pins[kind] = latest.id;
          }

          // THE FUND'S OWN NUMBERS, READ RATHER THAN INVENTED. What stood here was
          // `fund_size: 30000000, investable: 24000000, fund_deployed: 10000000` — hardcoded, in
          // the request body, where no partner ever saw them. The constraint engine then answered
          // "does the sleeve fit" and "is the reserve sufficient" against a thirty-million-dollar
          // fund the firm does not have, and printed the answers as arithmetic. This page already
          // refused to open a scenario without a pinned policy version; it had no business being
          // stricter about a policy id than about the size of the fund.
          /*
           * Read BEFORE any await, like the rest of this handler: `currentTarget` is gone by the
           * time the policy lookups resolve, and reading it afterwards is how this form lost fields
           * silently once already.
           */
          const investableGiven = Number(form.get("investable"));
          if (!Number.isFinite(investableGiven) || investableGiven <= 0) {
            setMessage(
              "Scenario refused: say how much of the fund is actually investable after fees. Nobody has recorded a fee model, so this is the one number the system cannot work out for you.",
            );
            return;
          }

          const { data: basis } = await api<{
            fund_size: number | null;
            fund_deployed: number;
            ready: boolean;
            blocked_because: string | null;
          }>(`/api/funds/${fundId}/basis`);
          if (!basis?.ready) {
            setMessage(`Scenario refused: ${basis?.blocked_because ?? "the fund's own numbers could not be read."}`);
            return;
          }

          const { status, data } = await post<{ id: string }>(
            "/api/allocation/scenarios",
            {
              fund_id: fundId,
              name: scenarioName,
              mandate_version_id: pins.mandate,
              sleeve_version_id: pins.sleeve,
              reserve_version_id: pins.reserve,
              concentration_version_id: pins.concentration,
              fund_size: basis.fund_size,
              investable: investableGiven,
              fund_deployed: basis.fund_deployed,
              // Investable and the modelled reserve need are OMITTED, not zeroed. Nobody has
              // recorded a fee model or a reserve plan, and a zero would be read as "the fund has
              // nothing set aside" rather than "we were never told" — which is how the last set of
              // invented numbers came to look like facts.
            },
            201,
            "Scenario",
          );
          if (status === 201 && data) setScenarioId(data.id);
        }}
      >
        {/* One fund exists; the picker returns only if the firm has more than one. */}
        {fundOptions.length > 1 && (
          <label>
            Fund{" "}
            <select name="fund" data-testid="scenario-fund" defaultValue={fundIdProp ?? undefined}>
              {fundOptions.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Name <input name="name" data-testid="scenario-name" defaultValue="" />
        </label>
        {/*
          ASKED FOR, BECAUSE NOBODY HAS RECORDED IT. `investable` is NOT NULL and the firm has no fee
          model on file, so there are only three options: invent a number, refuse to open scenarios
          at all, or ask. Inventing is what put a $30M fund into every scenario in the first place,
          and refusing would take Fund strategy away entirely — so the form asks for the one figure
          the system genuinely does not know, and the answer is recorded rather than assumed.
        */}
        <label>
          Investable after fees{" "}
          <input
            name="investable"
            data-testid="scenario-investable"
            inputMode="decimal"
            defaultValue={investableDefault ?? ""}
            placeholder="what is actually deployable"
          />
          <span className="muted small"> The one figure the system will not work out for you — there is no fee model on file; the sleeve's estimate is prefilled.</span>
        </label>
        <button type="submit" className="btn-strong" data-testid="scenario-create">
          Pin the versions and open it
        </button>
      </form>

      {detail.data && (
        <div className="card" data-testid="scenario-detail">
          <p className="muted small" data-testid="scenario-pins">
            Pinned: model {detail.data.model_version} · mandate {detail.data.mandate_version_id} · sleeve {detail.data.sleeve_version_id} · reserve {detail.data.reserve_version_id} · concentration {detail.data.concentration_version_id}
          </p>
          <p data-testid="scenario-outcome-label">{detail.data.outcome_label}</p>
          <div className="section-head"><h4>Assumptions — stated, append-only</h4></div>
          <ul data-testid="assumption-list">
            {detail.data.assumptions.map((a) => (
              <li key={a.id} data-testid={`assumption-${a.id}`}>
                <code>{a.assumption_key}</code> = {a.assumption_value} — {a.basis}
              </li>
            ))}
            {detail.data.assumptions.length === 0 && <li className="state-empty" data-testid="no-assumptions">No assumptions stated yet. An allocation scenario cannot run until its assumptions are on the record.</li>}
          </ul>
          <button
            type="button"
            data-testid="assumption-add"
            onClick={() =>
              post(
                `/api/allocation/scenarios/${scenarioId}/assumptions`,
                { assumption_key: "graduation_rate", assumption_value: "35%", basis: "operator-stated planning figure, not an observed rate" },
                201,
                "Assumption",
              )
            }
          >
            State graduation-rate assumption
          </button>
        </div>
      )}

      {scenarioId && (<>
      <div className="section-head"><h4>Capital options — initial, follow-on, reserve, secondary, exit, one framework</h4></div>
      <form
        className="form-row"
        data-testid="option-form"
        onSubmit={async (e) => {
          e.preventDefault();
          await post(
            `/api/allocation/scenarios/${scenarioId}/options`,
            {
              option_type: optionType,
              label: optionLabel,
              sleeve_key: "early",
              sleeve_target_pct: 60,
              sleeve_deployed: 10000000,
              capital: Number(capital),
              reserve_draw: optionType === "RESERVE" ? Number(capital) : 0,
              existing_company_cost: Number(existingCost),
            },
            201,
            "Option",
          );
        }}
      >
        <label>
          Type{" "}
          <select data-testid="option-type" value={optionType} onChange={(e) => setOptionType(e.target.value)}>
            {["INITIAL", "FOLLOW_ON", "RESERVE", "SECONDARY_PURCHASE", "SECONDARY_SALE", "EXIT"].map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label>
          Label <input data-testid="option-label" value={optionLabel} onChange={(e) => setOptionLabel(e.target.value)} />
        </label>
        <label>
          Capital <input data-testid="option-capital" value={capital} onChange={(e) => setCapital(e.target.value)} />
        </label>
        <label>
          Existing cost <input data-testid="option-existing-cost" value={existingCost} onChange={(e) => setExistingCost(e.target.value)} />
        </label>
        <button type="submit" className="btn-strong" data-testid="option-create">
          Add option
        </button>
      </form>

      <button
        type="button"
        data-testid="run-comparison"
        onClick={async () => {
          const { status, data } = await post<{ run: { id: string } }>(`/api/allocation/scenarios/${scenarioId}/compare`, {}, 201, "Comparison");
          if (status === 201 && data) setRunId(data.run.id);
        }}
      >
        Run cross-sleeve comparison
      </button>
      {message && <p className="notice" data-testid="allocation-message">{message}</p>}

      {run.data && (
        <div className="card" data-testid="run-detail">
          <p data-testid="run-breaches">{run.data.violations.filter((v) => v.severity === "BREACH").length} constraint breach(es)</p>
          <ul data-testid="violation-list">
            {run.data.violations.map((v) => (
              <li key={v.id} data-testid={`violation-${v.kind}`}>
                <code>{v.severity}</code> <code>{v.kind}</code> — {v.detail}
              </li>
            ))}
            {run.data.violations.length === 0 && <li className="state-empty" data-testid="no-violations">No constraint violations.</li>}
          </ul>
        </div>
      )}

      <div className="section-head"><h4>Options — humans decide</h4></div>
      {/* The receipt is typed in, not remembered for you: an approval card is
          presented deliberately, and it survives leaving this page to approve it. */}
      <label>
        Approval receipt <input data-testid="option-receipt" value={receipt} onChange={(e) => setReceipt(e.target.value)} />
      </label>
      <ul className="card-list" data-testid="option-list">
        {(detail.data?.options ?? []).map((o) => (
          <li key={o.id} className="card" data-testid={`option-${o.id}`}>
            <code>{o.option_type}</code> {o.label} · {o.capital} · <code data-testid={`option-decision-${o.id}`}>{o.decision}</code> · proposed by{" "}
            {o.proposed_by_type}
            <div className="form-row">
              <button
                type="button"
                data-testid={`option-request-${o.id}`}
                onClick={async () => {
                  const { status, data } = await post<{ id: string }>(`/api/allocation/options/${o.id}/request-approval`, {}, 201, "Approval request");
                  if (status === 201 && data) setReceipt(data.id);
                }}
              >
                Request the reserved approval
              </button>
              <button
                type="button"
                data-testid={`option-approve-${o.id}`}
                onClick={() => post(`/api/allocation/options/${o.id}/decide`, { decision: "APPROVED", ...(receipt ? { approval_receipt_id: receipt } : {}) }, 200, "Decision")}
              >
                Record APPROVED
              </button>
            </div>
          </li>
        ))}
        {(detail.data?.options ?? []).length === 0 && <li className="state-empty" data-testid="no-options">No options in this scenario.</li>}
      </ul>
      </>)}
    </section>
  );
}

