import { useState } from "react";
import { api } from "../lib/api";
import type { SelectedFund } from "../lib/selectedFund";

/**
 * Which fund you are looking at, and how a second one starts existing.
 *
 * IT GROWS A CONTROL RATHER THAN HAVING ONE. With a single fund this is a line of text naming it,
 * because a dropdown with one option is furniture that teaches the operator to ignore a control
 * that will later matter. The moment Fund II exists the same spot becomes a real switch. Nothing is
 * configured to make that happen — creating the second fund IS the switch.
 *
 * ADDING A FUND IS DELIBERATELY PLAIN and deliberately not the primary action: raising a second
 * fund is a once-every-few-years act, and a prominent "New fund" button next to a thesis you edit
 * weekly is a misread of how often each happens. It is a quiet link that asks for one thing.
 *
 * A NEW FUND STARTS EMPTY, and the surfaces say so rather than inheriting. Copying Fund I's thesis
 * into Fund II would be the wrong default in the way that is hardest to notice — a mandate that
 * looks deliberate and was never decided. Fund II usually differs precisely in check size and
 * ownership, which are exactly the fields a copy would carry over unexamined.
 */
export function FundPicker({ selected, label }: { selected: SelectedFund; label?: string }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  if (selected.loading) return null;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/funds", {
      method: "POST",
      body: { name: trimmed },
    });
    if (res.status !== 201 || !res.data?.id) {
      setMessage(`Not created: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`);
      return;
    }
    setMessage(`${trimmed} created. It has no thesis yet — set one before the analyst can search against it.`);
    setName("");
    setAdding(false);
    selected.reload();
    // Land on the fund just made: creating one and still looking at the other is a small
    // confusion that costs a wrong edit.
    selected.select(res.data.id);
  }

  return (
    <div className="fund-picker" data-testid="fund-picker">
      <div className="form-row" style={{ alignItems: "baseline" }}>
        {selected.hasChoice ? (
          <label>
            {label ?? "Fund"}{" "}
            <select
              data-testid="fund-select"
              value={selected.fund?.id ?? ""}
              onChange={(e) => selected.select(e.target.value)}
            >
              {selected.funds.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span data-testid="fund-single">
            <span className="muted small">{label ?? "Fund"}</span>{" "}
            <strong>{selected.fund?.name ?? "none yet"}</strong>
          </span>
        )}

        {!adding && (
          <button
            type="button"
            className="link-button"
            data-testid="fund-add-toggle"
            onClick={() => {
              setMessage(null);
              setAdding(true);
            }}
          >
            Add a fund
          </button>
        )}
      </div>

      {adding && (
        <form className="form-row" data-testid="fund-add-form" onSubmit={create}>
          <label>
            Name{" "}
            <input
              data-testid="fund-add-name"
              value={name}
              placeholder="West Peek Ventures Fund II"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <button type="submit" className="btn-strong" data-testid="fund-add-submit">
            Create
          </button>
          <button type="button" className="link-button" onClick={() => setAdding(false)}>
            Cancel
          </button>
          <span className="muted small">It starts with no thesis and no construction — nothing is copied across.</span>
        </form>
      )}

      {message && (
        <p className="notice small" data-testid="fund-picker-message">
          {message}
        </p>
      )}
    </div>
  );
}
