import { useMemo, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { originLabel, stage } from "@shared/investment/pipeline";

/**
 * The register, as something a partner can scan.
 *
 * WHAT WAS WRONG. It listed names and a status. That is the right shape for an identity spine and
 * useless for eyeballing: you could not tell an ed-tech company from a beverage brand without
 * opening each one, and nothing said which of them the fund actually has money in.
 *
 * SO EVERY CARD ANSWERS THE SAME FOUR THINGS: what they do, what sector, where the deal stands, and
 * how much of the fund is in it. Four facts in fixed positions is what makes a grid scannable —
 * the eye learns the layout once and then reads the whole page at a glance.
 *
 * MONEY IS SHOWN WITH ITS PROVENANCE. Sensori's amount is arithmetic over placeholder values, so
 * the card says so rather than printing a confident number. A figure nobody can tell is invented is
 * worse than no figure at all, and this is the exact page where an invented one would get believed.
 */

interface RegisterCompany {
  id: string;
  canonical_name: string;
  sector: string | null;
  one_liner: string | null;
  website: string | null;
  status: string;
  deal_status: string | null;
  amount_usd: number | null;
  amount_is_provisional: boolean;
  origin: string | null;
  meetings: number;
}

const usd = (n: number | null): string =>
  n === null || !Number.isFinite(n)
    ? "—"
    : n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `$${Math.round(n / 1_000)}K`
        : `$${Math.round(n)}`;

export function CompaniesPage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }) {
  const register = useApi<{ companies: RegisterCompany[]; sectors: string[]; count: number }>("/api/companies/register");
  const [sector, setSector] = useState("ALL");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [newSector, setNewSector] = useState("");
  const [oneLiner, setOneLiner] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const all = register.data?.companies ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all.filter((c) => {
      if (sector !== "ALL" && c.sector !== sector) return false;
      if (!q) return true;
      return (
        c.canonical_name.toLowerCase().includes(q) ||
        (c.one_liner ?? "").toLowerCase().includes(q) ||
        (c.sector ?? "").toLowerCase().includes(q)
      );
    });
  }, [all, sector, query]);

  const owned = all.filter((c) => c.deal_status === "CLOSED");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const res = await api<{ id?: string; error?: string; detail?: string }>("/api/companies", {
      method: "POST",
      body: {
        canonical_name: name.trim(),
        ...(newSector.trim() ? { sector: newSector.trim() } : {}),
        ...(oneLiner.trim() ? { one_liner: oneLiner.trim() } : {}),
      },
    });
    if (res.status !== 201) {
      setMessage(`Not added: ${res.data?.detail ?? res.data?.error ?? res.status}`);
      return;
    }
    setMessage(`${name.trim()} added to the register.`);
    setName("");
    setNewSector("");
    setOneLiner("");
    setAdding(false);
    register.reload();
  }

  if (register.loading && !register.data) return <p data-testid="companies-loading">Loading the register…</p>;

  return (
    <section data-testid="companies-page">
      <p className="muted small">
        Every company the firm has a record of, {me.fullName.split(" ")[0]} — {all.length} in all,{" "}
        {owned.length} the fund has money in.
      </p>

      <div className="form-row">
        <label>
          Sector{" "}
          <select data-testid="companies-sector" value={sector} onChange={(e) => setSector(e.target.value)}>
            <option value="ALL">All ({all.length})</option>
            {(register.data?.sectors ?? []).map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Find{" "}
          <input data-testid="companies-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="name, sector or what they do" />
        </label>
        <button type="button" className="link-button" data-testid="companies-add-toggle" onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : "Add a company"}
        </button>
      </div>

      {message && <p className="notice" data-testid="companies-message">{message}</p>}

      {adding && (
        <form className="card form-row" data-testid="companies-add-form" onSubmit={create}>
          <label>
            Name <input data-testid="companies-add-name" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Sector{" "}
            <input
              data-testid="companies-add-sector"
              value={newSector}
              onChange={(e) => setNewSector(e.target.value)}
              placeholder="Ed tech"
              list="known-sectors"
            />
            <datalist id="known-sectors">
              {(register.data?.sectors ?? []).map((s) => <option key={s} value={s} />)}
            </datalist>
          </label>
          <label>
            What they do{" "}
            <input data-testid="companies-add-oneliner" value={oneLiner} onChange={(e) => setOneLiner(e.target.value)} placeholder="Mental health care for youth, through schools" />
          </label>
          <button type="submit" className="btn-strong" data-testid="companies-add-submit">Add</button>
        </form>
      )}

      <div className="company-grid" data-testid="company-grid">
        {shown.map((c) => {
          const s = c.deal_status ? stage(c.deal_status) : null;
          return (
            <article className="card company-card" key={c.id} data-testid={`company-${c.id}`}>
              <header className="company-card-head">
                <h4>{c.canonical_name}</h4>
                {c.sector ? (
                  <span className="badge">{c.sector}</span>
                ) : (
                  <span className="muted small">no sector</span>
                )}
              </header>

              <p className="company-oneliner">
                {c.one_liner ?? <span className="muted">Nothing recorded about what they do.</span>}
              </p>

              <dl className="company-facts">
                <div>
                  <dt>Stage</dt>
                  <dd>{s?.label ?? "Not in the pipeline"}</dd>
                </div>
                <div>
                  <dt>In it</dt>
                  <dd data-testid={`company-amount-${c.id}`}>
                    {usd(c.amount_usd)}
                    {c.amount_is_provisional && c.amount_usd !== null && (
                      <span className="muted small"> · placeholder</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Met via</dt>
                  <dd>{c.origin ? originLabel(c.origin) : "—"}</dd>
                </div>
                <div>
                  <dt>Meetings</dt>
                  <dd>{c.meetings}</dd>
                </div>
              </dl>
            </article>
          );
        })}
        {shown.length === 0 && (
          <p className="state-empty" data-testid="companies-empty">
            {all.length === 0
              ? "No companies yet. Add one above, or capture one as you meet them."
              : "Nothing matches that filter."}
          </p>
        )}
      </div>

      <button type="button" className="link-button" onClick={() => onNavigate("investment")}>
        See where these stand in the pipeline →
      </button>
    </section>
  );
}
