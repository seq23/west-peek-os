import { useEffect, useMemo, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { originLabel, stage } from "@shared/investment/pipeline";

/**
 * Which company the register should open on, handed over from another page.
 *
 * WHY A HANDOVER AND NOT A PROP. Navigation in this app is a nav key and nothing else —
 * `onNavigate("companies")` — and the router falls back to Home for any hash that is not a bare
 * key, so there is nowhere in the URL to put a company id. Threading one through the shell would
 * add a second piece of page state to App for the sake of one link. This is read once and cleared,
 * so it cannot outlive the click that set it, and a stale one can never reopen a card by surprise.
 *
 * It lives here rather than in a shared module because the REGISTER is what is being opened: the
 * page that honours the request owns the way to ask for it.
 */
const OPEN_ON_REGISTER = "wp-register-open";

/** Open the register on this company — used by the deal rows on Dealflow. */
export function openOnRegister(companyId: string): void {
  try {
    window.sessionStorage.setItem(OPEN_ON_REGISTER, companyId);
  } catch {
    // Storage refused. The register still opens; it just will not have picked the company out.
  }
}

function takeRegisterRequest(): string | null {
  try {
    const id = window.sessionStorage.getItem(OPEN_ON_REGISTER);
    if (id) window.sessionStorage.removeItem(OPEN_ON_REGISTER);
    return id;
  } catch {
    return null;
  }
}

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
  deal_id: string | null;
  deal_status: string | null;
  amount_usd: number | null;
  amount_is_provisional: boolean;
  origin: string | null;
  meetings: number;
  /** Why the firm said no. Required when the deal was passed, so it is never empty in practice. */
  exit_reason: string | null;
  /** When it left. Null where the deal never moved — the register does not invent a date. */
  left_pipeline_at: string | null;
}

/** Passed or withdrawn: out of the working list, still in the register. */
const hasLeft = (c: RegisterCompany): boolean => Boolean(c.deal_status && stage(c.deal_status)?.isExit);

const usd = (n: number | null): string =>
  n === null || !Number.isFinite(n)
    ? "—"
    : n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `$${Math.round(n / 1_000)}K`
        : `$${Math.round(n)}`;


interface HistoryEntry {
  id: string;
  at: string;
  by: string;
  what: string;
  said: string | null;
}

/**
 * Editing a company, and the record of who changed what.
 *
 * Operator, item 9: "Can't edit Sensori's numbers; History does nothing; need an edit trail."
 *
 * ALL THREE HAD THE SAME CAUSE. `PATCH /api/companies/:id` existed and no button called it; the
 * route had no authorization and appended no event, so there was no trail for a History control to
 * show; and with nothing written, a History button could only ever have done nothing. Fixing the
 * route was the prerequisite for both halves of what was asked for.
 *
 * SECTOR IS A LIST NOW, not free text — see item 10. Typing it was how "Ed tech" and "ED_TECH" came
 * to be two sectors.
 */
function CompanyEditor({ company, sectors, onSaved, arrivedHere }: {
  company: RegisterCompany;
  sectors: Array<{ key: string; label: string }>;
  onSaved: () => void;
  /**
   * Somebody clicked this company's name on a deal and was sent here. Open the record rather than
   * landing them on a closed card they have to find and click again — the click already said what
   * they wanted, and asking for it twice is how a link stops feeling like a link.
   */
  arrivedHere: boolean;
}) {
  const [open, setOpen] = useState(arrivedHere);
  const [showHistory, setShowHistory] = useState(false);
  const [form, setForm] = useState({ sector: company.sector ?? "", one_liner: company.one_liner ?? "", website: "" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const history = useApi<{ entries: HistoryEntry[] }>(showHistory ? `/api/companies/${company.id}/history` : null, [showHistory, note]);

  async function save() {
    setBusy(true);
    const body: Record<string, string> = {};
    if (form.sector) body.sector = form.sector;
    if (form.one_liner.trim()) body.one_liner = form.one_liner.trim();
    if (form.website.trim()) body.website = form.website.trim();
    const res = await api<{ error?: string; detail?: string }>(`/api/companies/${company.id}`, { method: "PATCH", body });
    setBusy(false);
    setNote(res.status === 200 ? "Saved." : `Not saved: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`);
    if (res.status === 200) {
      setOpen(false);
      onSaved();
    }
  }

  return (
    <div className="company-edit">
      <button type="button" className="link-button" data-testid={`company-edit-${company.id}`} onClick={() => setOpen((v) => !v)}>
        {open ? "never mind" : "Edit"}
      </button>{" "}
      <button type="button" className="link-button" data-testid={`company-history-${company.id}`} onClick={() => setShowHistory((v) => !v)}>
        {showHistory ? "hide history" : "History"}
      </button>

      {open && (
        <div className="form-row" data-testid={`company-edit-form-${company.id}`}>
          <label>
            Sector{" "}
            <select value={form.sector} onChange={(e) => setForm((f) => ({ ...f, sector: e.target.value }))}>
              <option value="">— not said —</option>
              {sectors.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            What they do{" "}
            <input value={form.one_liner} onChange={(e) => setForm((f) => ({ ...f, one_liner: e.target.value }))} placeholder="in one line" />
          </label>
          <label>
            Website{" "}
            <input className="input-money" value={form.website} onChange={(e) => setForm((f) => ({ ...f, website: e.target.value }))} placeholder="optional" />
          </label>
          <button type="button" className="btn-strong" disabled={busy} onClick={() => void save()}>
            Save
          </button>
        </div>
      )}

      {showHistory && (
        <ul className="card-list small" data-testid={`company-history-list-${company.id}`}>
          {(history.data?.entries ?? []).map((e) => (
            <li key={e.id}>
              <span className="muted">{new Date(e.at).toLocaleDateString()}</span> · {e.by} ·{" "}
              {e.said ?? e.what.split(".").join(" ").split("_").join(" ")}
            </li>
          ))}
          {history.data && history.data.entries.length === 0 && (
            <li className="state-empty">
              Nothing recorded yet. Every change from now on is, with who made it and what it was before.
            </li>
          )}
        </ul>
      )}

      {note && <p className="muted small">{note}</p>}
    </div>
  );
}

/** One company, the same four facts in the same places whether it is live or passed. */
function CompanyCard({ company: c, sectors, arrivedHere, onSaved }: {
  company: RegisterCompany;
  sectors: Array<{ key: string; label: string }>;
  arrivedHere: boolean;
  onSaved: () => void;
}) {
  const s = c.deal_status ? stage(c.deal_status) : null;
  const left = hasLeft(c);
  return (
    <article
      /* `deal-row-out` is the dimming the pipeline already uses for a deal that has left it, reused
         rather than duplicated: the two lists are showing the same fact and should read the same. */
      className={left ? "card company-card deal-row-out" : "card company-card"}
      data-testid={`company-${c.id}`}
    >
      <header className="company-card-head">
        <h4>{c.canonical_name}</h4>
        {c.sector ? <span className="badge">{c.sector}</span> : <span className="muted small">no sector</span>}
      </header>

      <p className="company-oneliner">
        {c.one_liner ?? <span className="muted">Nothing recorded about what they do.</span>}
      </p>

      {/* THE REASON, ON THE CARD. A passed company whose card looks like every other card is the
          thing the operator asked to be able to see at a glance, and the reason is what makes the
          pile worth keeping — a list of names the firm declined answers nothing. */}
      {left && (
        <p className="company-oneliner" data-testid={`company-passed-${c.id}`}>
          <strong>{s?.key === "WITHDRAWN" ? "It went away" : "We said no"}</strong>
          {c.left_pipeline_at ? ` on ${new Date(c.left_pipeline_at).toLocaleDateString()}` : ""} —{" "}
          {c.exit_reason ?? <span className="muted">no reason was recorded, which is the part worth having.</span>}
        </p>
      )}

      {/*
        A COMPANY WITH NO DEAL IS A FAULT, NOT A STATE. Owner, 18 Sep 2026: "all companies should be
        in the pipeline, no matter how they come in. They are top of funnel if they are in the
        system." Every intake route opens the opportunity at arrival and migration 0197 backfilled
        the register, so this row should never render — and when it does, it says so in those
        terms rather than as the calm "Not in the pipeline" that let Northwind Robotics and Vynlo
        sit unseen for a month. `validate:companies-in-pipeline` fails the build if the calm label
        comes back.
      */}
      {!s && (
        <p className="notice notice-bad small" data-testid={`company-no-deal-${c.id}`}>
          <strong>Not on the board, and it should be.</strong> Every company in the system is meant to be at the
          top of the funnel; this one has no deal, which is a fault in how it came in. Open it from Dealflow.
        </p>
      )}

      <dl className="company-facts">
        <div>
          <dt>Stage</dt>
          <dd>{s?.label ?? "—"}</dd>
        </div>
        <div>
          <dt>In it</dt>
          <dd data-testid={`company-amount-${c.id}`}>
            {usd(c.amount_usd)}
            {c.amount_is_provisional && c.amount_usd !== null && <span className="muted small"> · placeholder</span>}
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
      <CompanyEditor company={c} sectors={sectors} onSaved={onSaved} arrivedHere={arrivedHere} />
    </article>
  );
}

export function CompaniesPage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }) {
  const register = useApi<{ companies: RegisterCompany[]; sectors: string[]; count: number }>("/api/companies/register");
  const [sector, setSector] = useState("ALL");
  /* Derived from the thesis — see shared/investment/sectors.ts and item 10. */
  const sectorList = useApi<{ options: Array<{ key: string; label: string }> }>("/api/thesis/sectors");
  const sectors = sectorList.data?.options ?? [];
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  /* Read once, on the way in. See openOnRegister above for why this is not a prop. */
  const [openOn] = useState<string | null>(() => takeRegisterRequest());

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

  /*
   * THE PASS PILE IS BELOW, NOT MIXED IN.
   *
   * Operator, item 9, verbatim: a company the firm passed on "should drop out of the active
   * pipeline but keep its history", and the pass pile must be "clearly visible and easy to get to"
   * — greyed out, below, not deleted. It was mixed into the same grid at full strength, so the
   * working register and the record of what was declined were one undifferentiated list.
   *
   * Both halves obey the filter and the search box. Narrowing to health tech and then not seeing
   * the health-tech company you passed on last month would make the pile look empty when it is not.
   */
  const working = shown.filter((c) => !hasLeft(c));
  const passed = shown.filter(hasLeft);
  const owned = all.filter((c) => c.deal_status === "CLOSED");
  const passedInAll = all.filter(hasLeft);

  /*
   * Arriving from a deal, land ON the company rather than at the top of a grid containing it. The
   * card opens itself (see CompanyEditor); this puts it on screen, which the open state alone does
   * not do once the register runs past one screenful.
   */
  useEffect(() => {
    if (!openOn || !register.data) return;
    document.querySelector(`[data-testid="company-${openOn}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [openOn, register.data]);

  if (register.loading && !register.data) return <p data-testid="companies-loading">Loading the register…</p>;

  return (
    <section data-testid="companies-page">
      <p className="muted small">
        Every company the firm has a record of, {me.fullName.split(" ")[0]} — {all.length} in all,{" "}
        {owned.length} the fund has money in
        {passedInAll.length > 0 && `, ${passedInAll.length} it turned down`}.
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
      </div>

      {/* THE DOOR MOVED, AND LEAVING A BUTTON BEHIND WAS THE MISTAKE.

          Both this page and Dealflow carried "Add a company", doing different things — this one
          made a company record and no deal, that one attached a deal to a company that had to
          already exist. So the top of the funnel had two openings and neither was complete.

          The first fix left a button here labelled "Add a company →" that navigated to Dealflow.
          Same place, same words, still button-shaped: the operator read the page as unchanged, and
          fairly. A signpost must not be shaped like the thing it replaced. It is a sentence now,
          in the register's own explanation, where it reads as information rather than as an action. */}
      <p className="muted small" data-testid="companies-register-note">
        This is the register — everything the firm has recorded, whether or not it is a live deal.
        Nothing is created here. A company enters the firm in one place, on{" "}
        <button type="button" className="link-button" data-testid="companies-add-toggle" onClick={() => onNavigate("dealflow")}>
          Dealflow
        </button>
        , because a company worth recording is almost always one you are already looking at.
      </p>

      {message && <p className="notice" data-testid="companies-message">{message}</p>}


      <div className="company-grid" data-testid="company-grid">
        {working.map((c) => (
          <CompanyCard
            key={c.id}
            company={c}
            sectors={sectors}
            arrivedHere={c.id === openOn}
            onSaved={() => register.reload()}
          />
        ))}
        {working.length === 0 && (
          <p className="state-empty" data-testid="companies-empty">
            {all.length === 0
              ? "No companies yet. The first one enters on Dealflow, with its deal."
              : passed.length > 0
                ? "Nothing live matches that. What the firm passed on is below."
                : "Nothing matches that filter."}
          </p>
        )}
      </div>

      <button type="button" className="link-button" onClick={() => onNavigate("dealflow")}>
        See where these stand in the pipeline →
      </button>

      {/* WHAT THE FIRM TURNED DOWN, kept and readable.
          A pass is one of the more valuable things a fund owns — it is the only record of the
          judgement, and it is the first thing you want when the same founder comes back raising.
          Below the live register and dimmed, so it never competes with the working list; open by
          default and headed with a count, so it is never something you have to know to look for. */}
      {passedInAll.length > 0 && (
        <section data-testid="companies-passed">
          <div className="home-section-head">
            <h3>Who did we turn down, and why?</h3>
            <span className="muted small">
              {passedInAll.length} {passedInAll.length === 1 ? "company" : "companies"} · out of the pipeline,
              still on the record
            </span>
          </div>
          <div className="company-grid">
            {passed.map((c) => (
              <CompanyCard
                key={c.id}
                company={c}
                sectors={sectors}
                arrivedHere={c.id === openOn}
                onSaved={() => register.reload()}
              />
            ))}
            {passed.length === 0 && (
              <p className="state-empty" data-testid="companies-passed-empty">
                None of the {passedInAll.length} the firm turned down match that filter.
              </p>
            )}
          </div>
        </section>
      )}
    </section>
  );
}
