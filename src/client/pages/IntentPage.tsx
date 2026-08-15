import { useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * Intent → Execution (P18; GAP-08, GAP-09).
 *
 * The governed path from a rough thought to executed work. The operator's own words stay
 * visible at the top of the packet at every step — enhancement adds columns beside them and
 * can never replace them (the database enforces that, not this page).
 *
 * The lens bench is visible: which lenses are selected, which have run, what each found, and
 * which one can stop the work.
 */

interface Packet {
  id: string;
  original_text: string;
  enhancement_strength: string;
  enhancement_origin: string;
  interpretation: string;
  ambiguities_json: string;
  assumptions_json: string;
  risks_json: string;
  output_definition: string;
  acceptance_criteria_json: string;
  lens_stack_json: string;
  recommended_employee_id: string | null;
  machine_id: number | null;
  capability_keys_json: string;
  cost_basis: string;
  status: string;
  work_card_id: string | null;
  ai_run_id: string | null;
  created_at: string;
}

interface LensDef {
  key: string;
  name: string;
  job: string;
  produces: string;
  blocking: boolean;
}

interface LensOutput {
  id: string;
  lens_key: string;
  verdict: string;
  critique: string;
  summary: string;
  produced_by_type: string;
  created_at: string;
}

function statusBadge(status: string): string {
  if (status === "COMPLETE") return "badge badge-ok";
  if (status === "BLOCKED_BY_LENS" || status === "FAILED") return "badge badge-bad";
  if (status === "EXECUTING") return "badge badge-gate";
  return "badge";
}

function verdictBadge(v: string): string {
  if (v === "PASS") return "badge badge-ok";
  if (v === "ADVERSE") return "badge badge-bad";
  return "badge badge-gate";
}

function list(jsonText: string): string[] {
  try {
    return JSON.parse(jsonText) as string[];
  } catch {
    return [];
  }
}

function PacketDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const detail = useApi<{ packet: Packet; lens_outputs: LensOutput[]; revisions: Array<{ id: string; version_no: number; note: string }>; lens_bench: LensDef[]; note: string }>(
    `/api/work-packets/${id}`,
  );
  const [message, setMessage] = useState<string | null>(null);
  const [lensKey, setLensKey] = useState("TRUTH_COMPLIANCE_GATE");
  const [verdict, setVerdict] = useState("PASS");
  const [critique, setCritique] = useState("");

  if (detail.loading && !detail.data) return <p>Loading packet…</p>;
  if (!detail.data) return <p className="muted">Could not load this packet.</p>;
  const p = detail.data.packet;
  const stack = list(p.lens_stack_json);
  const run = (key: string) => detail.data!.lens_outputs.find((o) => o.lens_key === key);

  const refresh = () => {
    detail.reload();
    onChanged();
  };

  return (
    <section className="card" data-testid={`packet-detail-${p.id}`}>
      <h3>
        Work packet <span className={statusBadge(p.status)}>{p.status}</span>
      </h3>

      <section className="card" data-testid="packet-original">
        <h4>What you wrote</h4>
        <p>{p.original_text}</p>
        <p className="muted small">
          Preserved verbatim. Enhancement ({p.enhancement_strength}, {p.enhancement_origin}) adds the fields below and never
          rewrites this.
        </p>
      </section>

      <h4>Interpretation</h4>
      <p className="small">{p.interpretation || "—"}</p>

      <div className="module-grid">
        <section className="module-card" data-testid="packet-ambiguities">
          <h4>Ambiguities</h4>
          <ul className="small">
            {list(p.ambiguities_json).map((a) => (
              <li key={a}>{a}</li>
            ))}
            {list(p.ambiguities_json).length === 0 && <li className="state-empty">None found.</li>}
          </ul>
        </section>
        <section className="module-card" data-testid="packet-assumptions">
          <h4>Assumptions</h4>
          <ul className="small">
            {list(p.assumptions_json).map((a) => (
              <li key={a}>{a}</li>
            ))}
            {list(p.assumptions_json).length === 0 && <li className="state-empty">None recorded.</li>}
          </ul>
        </section>
        <section className="module-card" data-testid="packet-risks">
          <h4>Risks</h4>
          <ul className="small">
            {list(p.risks_json).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
        <section className="module-card" data-testid="packet-acceptance">
          <h4>Acceptance criteria</h4>
          <ul className="small">
            {list(p.acceptance_criteria_json).map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </section>
      </div>

      <h4>Routing</h4>
      <p className="small" data-testid="packet-routing">
        Output: {p.output_definition || "—"} · machine {p.machine_id ?? "none recommended"} · employee{" "}
        {p.recommended_employee_id ?? "none assigned"} · capabilities{" "}
        {list(p.capability_keys_json).join(", ") || "none"}
      </p>
      <p className="muted small">{p.cost_basis}</p>

      <h4>Lens bench</h4>
      <p className="muted small">{detail.data.note}</p>
      <ul className="card-list small" data-testid="packet-lenses">
        {stack.map((key) => {
          const def = detail.data!.lens_bench.find((l) => l.key === key);
          const output = run(key);
          return (
            <li key={key} data-testid={`packet-lens-${key}`}>
              <strong>{def?.name ?? key}</strong> {def?.blocking && <span className="badge badge-gate">blocking</span>}{" "}
              {output ? (
                <>
                  <span className={verdictBadge(output.verdict)}>{output.verdict}</span> — {output.critique}
                  <br />
                  <span className="muted">recorded by {output.produced_by_type}</span>
                </>
              ) : (
                <span className="muted">not run yet{def?.blocking ? " — execution is refused until it does" : ""}</span>
              )}
            </li>
          );
        })}
      </ul>

      {p.status !== "COMPLETE" && (
        <form
          data-testid="lens-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await api<{ error?: string; detail?: string }>(`/api/work-packets/${p.id}/lenses`, {
              method: "POST",
              body: { lens_key: lensKey, verdict, critique },
            });
            setMessage(res.status === 201 ? `${lensKey} recorded as ${verdict}.` : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`);
            setCritique("");
            refresh();
          }}
        >
          <div className="form-row">
            <select data-testid="lens-key" value={lensKey} onChange={(e) => setLensKey(e.target.value)}>
              {stack.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <select data-testid="lens-verdict" value={verdict} onChange={(e) => setVerdict(e.target.value)}>
              {["PASS", "CONCERN", "ADVERSE"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <input
              className="field-wide" data-testid="lens-critique"
              value={critique}
              onChange={(e) => setCritique(e.target.value)}
              placeholder="What did this lens find?"
            />
            <button type="submit" className="btn-strong" data-testid="lens-submit">
              Record finding
            </button>
          </div>
        </form>
      )}

      <div className="form-row">
        <button
          type="button"
          data-testid="packet-execute"
          disabled={p.status === "COMPLETE" || p.status === "EXECUTING"}
          onClick={async () => {
            const res = await api<{ packet?: Packet; run?: { status: string }; error?: string; detail?: string }>(
              `/api/work-packets/${p.id}/execute`,
              { method: "POST" },
            );
            setMessage(
              res.status === 200
                ? `Executed. Work card opened and the governed run finished ${res.data?.run?.status}.`
                : `Refused: ${res.data?.detail ?? res.data?.error ?? res.status}`,
            );
            refresh();
          }}
        >
          Execute packet
        </button>
      </div>
      {message && <p className="notice" data-testid="packet-message">{message}</p>}

      {p.work_card_id && (
        <p className="muted small">
          work card <code>{p.work_card_id}</code> · run <code>{p.ai_run_id}</code>
        </p>
      )}

      <p className="muted small">{detail.data.revisions.length} revision(s) recorded (append-only).</p>
    </section>
  );
}

export function IntentPage({ me }: { me: MeResponse }) {
  const packets = useApi<{ packets: Packet[]; lens_bench: LensDef[] }>("/api/work-packets");
  const bench = useApi<{ lenses: LensDef[]; default_stack: string[]; storage_rule: string }>("/api/work-packets/lens-bench");
  const [text, setText] = useState("");
  const [strength, setStrength] = useState("STANDARD");
  const [selected, setSelected] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <section data-testid="intent-page">
      <p className="muted small">
        {me.fullName}: describe the work in your own words. West Peek OS derives the interpretation, ambiguities,
        assumptions, risks, and acceptance criteria beside your text — it never replaces it.
      </p>

      <form
        className="card"
        data-testid="intent-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await api<{ packet: Packet; error?: string }>("/api/work-packets", {
            method: "POST",
            body: { text, enhancement_strength: strength },
          });
          if (res.status === 201 && res.data) {
            setMessage("Packet opened. Review the derived fields, run the lenses, then execute.");
            setSelected(res.data.packet.id);
            setText("");
            packets.reload();
          } else {
            setMessage(`Refused: ${res.data?.error ?? res.status}`);
          }
        }}
      >
        <div className="form-row">
          <textarea
            className="field-wide" data-testid="intent-text"
            rows={3}
            style={{ width: "100%" }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What needs doing? Write it however you think about it."
          />
        </div>
        <div className="form-row">
          <label>
            Enhancement{" "}
            <select data-testid="intent-strength" value={strength} onChange={(e) => setStrength(e.target.value)}>
              {["NONE", "LIGHT", "STANDARD", "DEEP"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="btn-strong" data-testid="intent-submit">
            Open work packet
          </button>
        </div>
      </form>
      {message && <p className="notice" data-testid="intent-message">{message}</p>}

      {selected && <PacketDetail id={selected} onChanged={packets.reload} />}

      <h3>Lens bench</h3>
      <p className="muted small" data-testid="lens-storage-rule">
        {bench.data?.storage_rule}
      </p>
      <ul className="card-list small" data-testid="lens-bench">
        {(bench.data?.lenses ?? []).map((l) => (
          <li key={l.key}>
            <strong>{l.name}</strong> {l.blocking && <span className="badge badge-gate">blocking</span>} — {l.job}
          </li>
        ))}
      </ul>

      <h3>Packets</h3>
      <ul className="card-list small" data-testid="packet-list">
        {(packets.data?.packets ?? []).map((p) => (
          <li key={p.id}>
            <span className={statusBadge(p.status)}>{p.status}</span>{" "}
            <button type="button" className="link-button" data-testid={`packet-open-${p.id}`} onClick={() => setSelected(p.id)}>
              {p.original_text.slice(0, 80)}
            </button>
          </li>
        ))}
        {!packets.loading && (packets.data?.packets ?? []).length === 0 && <li className="state-empty">No packets yet. Write the rough thought above — the text is stored verbatim and immutable, and the derived fields sit beside it.</li>}
      </ul>
    </section>
  );
}
