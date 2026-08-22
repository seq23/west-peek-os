import { useState } from "react";
import { api, useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { formatUsd, type CompanyFact } from "@shared/market/mapping";

/**
 * The Market Mapping Room (P46, V1 #33).
 *
 * TWO VIEWS OF ONE DATASET. The map is the default because that is what a VC means by "market map"
 * — subsegments as panels, companies as tiles, the shape of the sector at a glance. The table
 * exists because a landscape is bad at the other job: sorting by raise and comparing.
 *
 * An unknown renders as "—", never as zero, and coverage is stated on every finished map. A map
 * that lists twelve companies without saying what it could not see reads as "these are the twelve",
 * which is a claim no free-source map can make.
 */

interface MapRow { id: string; sector: string; status: string; company_count: number; created_at: string }
interface MapDetail {
  map: { id: string; sector: string; coverage_note: string | null; company_count: number; sources_used: string; created_at: string };
  panels: Array<{ segment: string; companies: CompanyFact[] }>;
}

export function MarketMapPage(): JSX.Element {
  const maps = useApi<{ maps: MapRow[] }>("/api/market-maps");
  const [openId, setOpenId] = useState<string | null>(null);
  const detail = useApi<MapDetail>(openId ? `/api/market-maps/${openId}` : "/api/market-maps", [openId]);
  const [sector, setSector] = useState("");
  const [view, setView] = useState<"map" | "table">("map");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const panels = openId ? detail.data?.panels ?? [] : [];
  const all = panels.flatMap((p) => p.companies);

  async function build(e: React.FormEvent) {
    e.preventDefault();
    if (!sector.trim() || busy) return;
    setBusy(true); setMessage(null);
    const res = await api<{ map_id?: string; companies?: number; sources_failed?: string[]; detail?: string; error?: string }>(
      "/api/market-maps", { method: "POST", body: { sector: sector.trim() } },
    );
    if (res.status === 201 && res.data?.map_id) {
      setOpenId(res.data.map_id);
      if (res.data.sources_failed?.length) setMessage(`Built, but some sources were unavailable: ${res.data.sources_failed.join("; ")}`);
      maps.reload();
    } else setMessage(res.data?.detail ?? res.data?.error ?? `Could not build (HTTP ${res.status}).`);
    setBusy(false);
  }

  function tile(c: CompanyFact) {
    return (
      <li key={c.name} className={c.is_ours ? "mkt-tile mkt-tile-ours" : "mkt-tile"} data-testid={`mkt-company-${c.name}`}>
        <strong>{c.name}</strong>
        {c.is_ours && <span className="help-tag help-tag-good">ours</span>}
        <span className="muted small">
          {formatUsd(c.total_raised_usd ?? c.last_round_usd)}
          {c.stage ? ` · ${c.stage}` : ""}
        </span>
        {c.source_url && (
          <a href={c.source_url} target="_blank" rel="noreferrer noopener" className="muted small">
            {c.funding_source === "SEC_FORM_D" ? "SEC filing" : "source"}
          </a>
        )}
      </li>
    );
  }

  return (
    <div className="page" data-testid="market-map-page">
      <h3>Market mapping</h3>
      <p className="muted">Who is in a sector, and how big they are.</p>

      <form className="card" onSubmit={build} data-testid="mkt-build-form">
        <div className="form-row">
          <input
            data-testid="mkt-sector" aria-label="Sector to map"
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            placeholder="AI inference infrastructure, health tech scheduling, embedded fintech…"
            style={{ flex: 1, minWidth: "18rem" }}
          />
          <button type="submit" className="btn-strong" disabled={busy} data-testid="mkt-build">
            {busy ? "Mapping…" : "Build map"}
          </button>
        </div>
        <p className="muted small">
          Reads your own records, funding news already swept, and SEC Form D filings. A filing beats
          a press release when they disagree.
        </p>
        {message && <p className="notice" data-testid="mkt-message">{message}</p>}
      </form>

      {openId && detail.data && (
        <section className="card" data-testid="mkt-result">
          <h4>
            {detail.data.map.sector}{" "}
            <span className="muted small">{detail.data.map.company_count} companies</span>
          </h4>

          <nav className="ic-tabs">
            <button type="button" className={view === "map" ? "ic-tab ic-tab-active" : "ic-tab"} data-testid="mkt-view-map" onClick={() => setView("map")}>Map</button>
            <button type="button" className={view === "table" ? "ic-tab ic-tab-active" : "ic-tab"} data-testid="mkt-view-table" onClick={() => setView("table")}>Table</button>
          </nav>

          {view === "map" && (
            <div className="mkt-map" data-testid="mkt-map">
              {panels.map((p) => (
                <section key={p.segment} className="mkt-panel" data-testid={`mkt-panel-${p.segment}`}>
                  <h5>{p.segment} <span className="muted small">{p.companies.length}</span></h5>
                  <ul className="mkt-tiles">{p.companies.map(tile)}</ul>
                </section>
              ))}
            </div>
          )}

          {view === "table" && (
            <div className="scroller">
              <table data-testid="mkt-table">
                <thead>
                  <tr><th>Company</th><th>Segment</th><th>Stage</th><th>Raised</th><th>Last round</th><th>Source</th></tr>
                </thead>
                <tbody>
                  {[...all].sort((a, b) => (b.total_raised_usd ?? -1) - (a.total_raised_usd ?? -1)).map((c) => (
                    <tr key={c.name}>
                      <td>{c.name}{c.is_ours && " ★"}</td>
                      <td>{c.segment}</td>
                      <td>{c.stage ?? "—"}</td>
                      <td>{formatUsd(c.total_raised_usd)}</td>
                      <td>{c.last_round_date ?? "—"}</td>
                      <td>{c.source_url ? <a href={c.source_url} target="_blank" rel="noreferrer noopener">{c.funding_source}</a> : c.funding_source}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {detail.data.map.coverage_note && (
            <p className="notice" data-testid="mkt-coverage">{detail.data.map.coverage_note}</p>
          )}
        </section>
      )}

      {(maps.data?.maps ?? []).length > 0 && (
        <details className="card intel-panel" data-testid="mkt-history">
          <summary>Earlier maps <span className="muted small">{maps.data!.maps.length}</span></summary>
          <ul className="card-list small">
            {maps.data!.maps.map((m) => (
              <li key={m.id}>
                <button type="button" className="link-button" onClick={() => setOpenId(m.id)}>{m.sector}</button>{" "}
                <span className="muted small">{m.company_count} companies · {new Date(m.created_at).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      <HowThisWorks
        title="Market mapping"
        testId="market-map"
        what="A map of who exists in a sector and how big they are — grouped into subsegments, with what each has raised and where that figure came from."
        when="When getting up to speed on a space, sizing a market, or checking who else is doing something a founder just pitched."
        operatorDoes={["Name a sector.", "Read the map, or switch to the table to sort by size.", "Follow any figure back to its source."]}
        aiDoes={["Groups the companies found into subsegments. It does not add companies and does not supply funding figures — those come from records."]}
        requiresOperator={["Judging the map. Coverage from free sources is partial, and the map says so."]}
        next="Every figure links to its source, and an SEC filing outranks a press release when they disagree."
        blocked={["Unknown funding shows as a dash, never as zero — a company we lack a figure for did not raise nothing.", "Investment funds that file a Form D are filtered out; they invest in the sector rather than being in it."]}
      />
    </div>
  );
}
