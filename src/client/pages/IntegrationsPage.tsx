import { useState } from "react";
import { readableDate } from "../lib/dates";
import { api, useApi, type MeResponse } from "../lib/api";

/**
 * What West Peek OS is joined to on the outside, and what each of those joins can and cannot do.
 *
 * WHAT WAS WRONG (operator, item 25: pages "jumbled", make them read like the LP tab). Four
 * unrelated subjects sat on one page as bare noun-labels — "Connectors", "Meeting prep queue",
 * "Specialist lane", "LP operations" — with an `h4` card wedged between two `h3` siblings and no
 * order to any of it. The LP-operations block was FOUR unlabelled `<ul>`s in a row: nothing on
 * screen said that the first was administrator sources, the second a reconciliation schedule, the
 * third where each investor conversation stood, the fourth what remains impossible.
 *
 * WORSE, THE WHOLE BLOCK VANISHED ON A REFUSAL. If the API said "you do not have investor access",
 * every one of those sections collapsed to a single line of prose, so a reader without the scope
 * could not learn that the sections exist. A section now always renders and states the fact —
 * "you cannot see this" is information; an absent heading is not.
 *
 * ORDER: nearest to the firm first. What we are connected to → the meetings those connections
 * would serve → outside specialists → the investor-facing back office (where figures come from,
 * when they are checked, where each conversation stands, what has been asked for and shared) →
 * and last, plainly, the things that still cannot happen at all.
 *
 * NOTHING HERE IS PRESENTED AS WORKING. That was true before and stays true; what changed is that
 * it is said in sentences instead of in `NOT_CONFIGURED`, `NO_CONTRACT` and
 * `UNPROVEN — VENDOR ACCESS GATE`.
 */

interface Connector {
  id: string;
  connector_key: string;
  name: string;
  kind: string;
  owns: string;
  direction: string;
  credential_name: string | null;
  credential_configured: boolean;
  can_be_reached: boolean;
  live_detail?: string;
  last_check_mode: string | null;
  last_check_detail: string | null;
  scopes: string[];
  consent_required: number;
  approval_gate: string;
  status: string;
  detail: string;
  last_checked_at: string | null;
}

interface PrepRow {
  id: string;
  title: string;
  meeting_type: string;
  scheduled_at: string;
  needs_prep: boolean;
  recording_state: string;
  participants: number;
}

/** The vocabulary, in one place, so no two sections say the same state differently. */
const CONNECTOR_STATE: Record<string, string> = {
  NOT_CONFIGURED: "Not set up",
  CONFIGURED: "Set up",
  GATED: "Waiting on approval",
  FAILED: "Last check failed",
};

const DIRECTION: Record<string, string> = {
  READ: "reads only",
  WRITE: "sends only",
  BIDIRECTIONAL: "reads and sends",
};

const MEETING_KIND: Record<string, string> = {
  FOUNDER: "Founder meeting",
  DILIGENCE: "Diligence",
  PORTFOLIO: "Portfolio company",
  LP: "Investor",
  INTERNAL: "Internal",
  BROKER: "Broker",
  OTHER: "Meeting",
};

const ENGAGEMENT_STATE: Record<string, string> = {
  NOT_ENGAGED: "not approached yet",
  IN_CONVERSATION: "in conversation",
  IN_DILIGENCE: "doing their diligence",
  AWAITING_DECISION: "deciding",
  COMMITTED: "committed",
  DECLINED: "said no",
};

const GATE_SUBJECT: Record<string, string> = {
  fund_admin: "The fund administrator",
  vdr: "The data room",
  distribution: "Sending documents to investors",
};

function label(map: Record<string, string>, key: string | null | undefined): string {
  if (!key) return "—";
  return map[key] ?? key.toLowerCase().split("_").join(" ");
}

/**
 * Administrator/VDR freshness, which the API returns as `NEVER_IMPORTED — …`, `FRESH`, or
 * `STALE by 4 day(s)`. All three are facts worth having and none of them is a sentence.
 */
function freshnessSentence(freshness: string): string {
  if (freshness.startsWith("NEVER_IMPORTED")) return "nothing has ever been imported from it";
  if (freshness === "FRESH") return "up to date";
  const stale = /^STALE by (\d+)/.exec(freshness);
  if (stale) return `${stale[1]} day${stale[1] === "1" ? "" : "s"} out of date`;
  return freshness;
}

/**
 * The prep queue reports a meeting's recording state as a substrate sentence — "policy activated
 * but NO consent granted — transcription is refused (P7)". Both facts in it matter to a partner
 * about to walk into the room; the phrasing and the phase number do not.
 */
function recordingSentence(state: string): string {
  if (state.startsWith("policy activated and consent")) return "being recorded, and everyone in it has agreed";
  if (state.startsWith("policy activated but NO consent")) {
    return "recording is switched on but nobody has agreed to it, so nothing will be written down";
  }
  if (state.startsWith("no recording policy")) return "not being recorded — only a partner or compliance can change that";
  return state;
}

/**
 * A gate arrives as `UNPROVEN — SOURCE CONTRACT GATE: no administrator system has been read…`.
 * The prefix is a label for the same thing the sentence after it already says, shouted. Drop it
 * and keep the sentence.
 */
function plainGate(text: string): string {
  const stripped = text.replace(/^[A-Z][A-Z\s—–-]*:\s*/, "");
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

function connectorTone(status: string): string {
  if (status === "CONFIGURED") return "badge badge-ok";
  if (status === "FAILED") return "badge badge-bad";
  return "badge badge-gate";
}

export function IntegrationsPage({ me }: { me: MeResponse }) {
  const connectors = useApi<{ connectors: Connector[]; network_os: { authority: string; contract_declared: boolean; open_conflicts: number; mapped_records: number }; rules: Record<string, string> }>(
    "/api/connectors",
  );
  const prep = useApi<{ queue: PrepRow[]; note: string }>("/api/meeting-prep/queue");
  const specialist = useApi<{ engagements: Array<{ id: string; provider_key: string; matter_type: string; status: string; block_reason: string | null }>; providers: Array<{ provider_key: string; display_name: string; enabled: number; allowed_labels: number; credential_configured: boolean; endpoint_known: boolean }>; status: string; gate_detail: string }>(
    "/api/specialist/engagements",
  );
  const lpOps = useApi<{
    sources: Array<{ source_key: string; name: string; kind: string; contract_state: string; freshness: string; note: string }>;
    reconciliation_schedules: Array<{ fund_name: string; cadence: string; next_due_at: string; due: boolean }>;
    outstanding_diligence: Array<{ id: string; request_text: string; status: string }>;
    data_room_access: Array<{ id: string; recipient_label: string; permission: string; revoked: boolean }>;
    lp_engagements: Array<{ lp_record_id: string; legal_name: string; state: string; next_step: string }>;
    gates: Record<string, string>;
    authority: string;
    error?: string;
    detail?: string;
  }>("/api/lp-ops/overview");
  const [message, setMessage] = useState<string | null>(null);

  /*
   * ONE REFUSAL, SAID ONCE PER SECTION.
   *
   * The investor sections are LP_PRIVATE. When the reader lacks that access the API refuses, and
   * every section below still renders its heading and says this instead of disappearing.
   */
  const lpBlocked = lpOps.status === 403
    ? "You do not have investor access, so this cannot be shown to you. A Managing Partner can see it."
    : null;
  const lpRows = lpBlocked ? null : lpOps.data;

  return (
    <section data-testid="integrations-page">
      <p className="muted small">
        Everything West Peek OS reaches on the outside — the systems, the meetings they serve,
        outside specialists, and the investor back office. Network OS is connected and live; the
        rest are registered but not connected, and each one says exactly what is missing.
      </p>

      <h3>What we are connected to</h3>
      <p className="muted small" data-testid="connector-rules">
        {connectors.data?.rules.credentials} {connectors.data?.rules.checks}
      </p>
      <ul className="card-list" data-testid="connector-list">
        {connectors.loading && <li className="state-message" data-testid="connector-list-loading">Loading…</li>}
        {(connectors.data?.connectors ?? []).map((c) => (
          <li key={c.id} className="card" data-testid={`connector-${c.connector_key}`}>
            <p>
              <strong>{c.name}</strong> <span className={connectorTone(c.status)}>{label(CONNECTOR_STATE, c.status)}</span>{" "}
              <span className="badge">{label(DIRECTION, c.direction)}</span>
              {c.consent_required === 1 && <span className="badge badge-gate">the other side must agree</span>}
            </p>
            <p className="small">{c.owns}</p>
            <p className="muted small">
              {c.credential_name === null
                ? "No password or key has been named for it yet."
                : c.credential_configured
                  ? "Its key is set on this machine."
                  : "Its key has not been set on this machine, so it cannot be used."}
              {c.scopes.length > 0 ? ` It ${c.can_be_reached ? "asks" : "would ask"} for: ${c.scopes.join(", ")}.` : ""}
            </p>
            {c.live_detail && <p className="muted small">{c.live_detail}</p>}
            {c.approval_gate && <p className="muted small">Before it can run: {c.approval_gate}</p>}
            <p className="muted small">{c.detail}</p>
            {c.last_checked_at && (
              <p className="muted small">
                {/* Which KIND of check ran matters more than when: one contacted the far end and
                    one read this machine's own configuration, and they are not the same evidence. */}
                Last checked {readableDate(c.last_checked_at)}
                {c.last_check_mode === "LIVE" ? ", by contacting it" : ", without contacting it"}.
                {c.last_check_detail ? ` ${c.last_check_detail.replace(/^(LIVE|LOCAL_FIXTURE): /, "")}` : ""}
              </p>
            )}
            <button
              type="button"
              data-testid={`connector-check-${c.connector_key}`}
              onClick={async () => {
                const res = await api<{ detail: string }>(`/api/connectors/${c.connector_key}/check`, { method: "POST" });
                setMessage(res.data?.detail ?? `The check did not run (HTTP ${res.status}).`);
                connectors.reload();
              }}
            >
              {c.can_be_reached ? "Check the connection now" : "Check what is missing"}
            </button>
          </li>
        ))}
        {!connectors.loading && (connectors.data?.connectors ?? []).length === 0 && (
          <li className="state-empty">No outside system is registered. Registering one records what it would need; it does not connect it.</li>
        )}
      </ul>
      {message && <p className="notice" data-testid="integrations-message" role="status">{message}</p>}

      {/* Network OS is a connector with a second story — who owns the truth — so it sits inside
          this section as a card rather than as a sibling heading of its own. */}
      <section className="card" data-testid="network-os-authority">
        <h4>Who owns the contact record</h4>
        <p className="small">{connectors.data?.network_os.authority}</p>
        <p className="muted small">
          The agreement about how the two systems talk is{" "}
          {connectors.data?.network_os.contract_declared ? "written down" : "not written down yet"} ·{" "}
          {connectors.data?.network_os.mapped_records ?? 0} record{connectors.data?.network_os.mapped_records === 1 ? "" : "s"} matched
          up · {connectors.data?.network_os.open_conflicts ?? 0} disagreement
          {connectors.data?.network_os.open_conflicts === 1 ? "" : "s"} still open
        </p>
      </section>

      <h3>Which meetings still need preparing</h3>
      <p className="muted small" data-testid="prep-note">
        {prep.data?.note}
      </p>
      <ul className="card-list small" data-testid="prep-queue">
        {prep.loading && <li className="state-message" data-testid="prep-queue-loading">Loading…</li>}
        {(prep.data?.queue ?? []).map((m) => (
          <li key={m.id}>
            <strong>{m.title}</strong> — {label(MEETING_KIND, m.meeting_type)}, {readableDate(m.scheduled_at)}, {m.participants}{" "}
            person{m.participants === 1 ? "" : "s"}{" "}
            {m.needs_prep ? <span className="badge badge-gate">nothing prepared</span> : <span className="badge badge-ok">prepared</span>}
            <br />
            <span className="muted">This meeting is {recordingSentence(m.recording_state)}.</span>
          </li>
        ))}
        {!prep.loading && (prep.data?.queue ?? []).length === 0 && (
          <li className="state-empty">No meeting is coming up. Meetings entered in West Peek OS appear here with what has been prepared for each.</li>
        )}
      </ul>

      <h3>Sending work to an outside specialist</h3>
      <p className="small" data-testid="specialist-status">
        No outside specialist has ever been called from here.
      </p>
      <p className="muted small" data-testid="specialist-gate">
        {specialist.data?.gate_detail}
      </p>
      <ul className="card-list small" data-testid="specialist-providers">
        {(specialist.data?.providers ?? []).map((p) => (
          <li key={p.provider_key}>
            <strong>{p.display_name}</strong> — {p.enabled ? "switched on" : "switched off"} · {p.allowed_labels} kind
            {p.allowed_labels === 1 ? "" : "s"} of firm information may leave for them · key{" "}
            {p.credential_configured ? "set" : "not set"} · address {p.endpoint_known ? "known" : "unknown"}
          </li>
        ))}
        {!specialist.loading && (specialist.data?.providers ?? []).length === 0 && (
          <li className="state-empty">No specialist firm is registered.</li>
        )}
      </ul>
      <ul className="card-list small" data-testid="specialist-engagements">
        {(specialist.data?.engagements ?? []).map((e) => (
          <li key={e.id}>
            <strong>{e.matter_type.toLowerCase().split("_").join(" ")}</strong> with {e.provider_key} —{" "}
            {e.status.toLowerCase().split("_").join(" ")}
            {e.block_reason ? ` — ${e.block_reason}` : ""}
          </li>
        ))}
        {!specialist.loading && (specialist.data?.engagements ?? []).length === 0 && (
          <li className="state-empty">Nothing has been sent to a specialist. Doing so would go through the same governed boundary as any other outside call.</li>
        )}
      </ul>

      <h3>Where the investor figures would come from</h3>
      <p className="muted small" data-testid="lp-ops-authority">
        {lpBlocked ?? lpOps.data?.authority}
      </p>
      <ul className="card-list small" data-testid="lp-ops-sources">
        {(lpRows?.sources ?? []).map((s) => (
          <li key={s.source_key}>
            <strong>{s.name}</strong>{" "}
            <span className="badge badge-gate">
              {s.contract_state === "NO_CONTRACT" ? "no agreement yet" : "format agreed"}
            </span>{" "}
            — {freshnessSentence(s.freshness)}
            <br />
            <span className="muted">{s.note}</span>
          </li>
        ))}
        {!lpOps.loading && (lpRows?.sources ?? []).length === 0 && (
          <li className="state-empty">
            {lpBlocked ??
              "No administrator, accountant or data room is on file. Until one is, every figure the fund reports is typed in by hand."}
          </li>
        )}
      </ul>

      <h3>When our numbers are next checked against theirs</h3>
      <ul className="card-list small" data-testid="lp-ops-schedules">
        {(lpRows?.reconciliation_schedules ?? []).map((s) => (
          <li key={s.fund_name}>
            <strong>{s.fund_name}</strong> — {s.cadence === "MONTHLY" ? "every month" : "every quarter"}, next due{" "}
            {readableDate(s.next_due_at)} {s.due && <span className="badge badge-bad">due now</span>}
          </li>
        ))}
        {!lpOps.loading && (lpRows?.reconciliation_schedules ?? []).length === 0 && (
          <li className="state-empty">
            {lpBlocked ??
              "No fund has a checking schedule. Comparing the administrator's numbers with ours is done on the LP page whenever somebody asks for it."}
          </li>
        )}
      </ul>

      <h3>Where each investor conversation stands</h3>
      <ul className="card-list small" data-testid="lp-ops-engagements">
        {(lpRows?.lp_engagements ?? []).map((e) => (
          <li key={e.lp_record_id}>
            <strong>{e.legal_name}</strong> — {label(ENGAGEMENT_STATE, e.state)}
            {e.next_step ? `. Next: ${e.next_step}` : ""}
          </li>
        ))}
        {!lpOps.loading && (lpRows?.lp_engagements ?? []).length === 0 && (
          <li className="state-empty">
            {lpBlocked ?? "Nobody's conversation has been given a state yet. Investors themselves are added on the LP page."}
          </li>
        )}
      </ul>

      {/* Both of these were fetched by this page and rendered nowhere. What an investor has asked
          for and what they have been given are the two halves of the same obligation, so they are
          one section with a heading each. */}
      <h3>What investors have asked for, and what they can see</h3>
      <div className="card">
        <h4>Still owed an answer</h4>
        <ul className="card-list small" data-testid="lp-ops-diligence">
          {(lpRows?.outstanding_diligence ?? []).map((d) => (
            <li key={d.id}>{d.request_text}</li>
          ))}
          {!lpOps.loading && (lpRows?.outstanding_diligence ?? []).length === 0 && (
            <li className="state-empty">{lpBlocked ?? "No investor question is outstanding."}</li>
          )}
        </ul>

        <h4>Given access to the data room</h4>
        <ul className="card-list small" data-testid="lp-ops-access">
          {(lpRows?.data_room_access ?? []).map((a) => (
            <li key={a.id}>
              <strong>{a.recipient_label}</strong> — {a.permission.toLowerCase().split("_").join(" ")}
              {a.revoked ? " · access has since been taken away" : ""}
            </li>
          ))}
          {!lpOps.loading && (lpRows?.data_room_access ?? []).length === 0 && (
            <li className="state-empty">
              {lpBlocked ??
                "Nobody has been given access. West Peek OS records who was given what; it has never delivered a document itself."}
            </li>
          )}
        </ul>
      </div>

      <h3>What still cannot happen</h3>
      <p className="small">
        Each of these is a thing the product records but has never done. They are listed so the
        distinction between "written down" and "actually sent" is never left to be assumed.
      </p>
      <ul className="card-list small" data-testid="lp-ops-gates">
        {Object.entries(lpRows?.gates ?? {}).map(([k, v]) => (
          <li key={k}>
            <strong>{GATE_SUBJECT[k] ?? k.toLowerCase().split("_").join(" ")}</strong> — {plainGate(v)}
          </li>
        ))}
        {!lpOps.loading && Object.keys(lpRows?.gates ?? {}).length === 0 && (
          <li className="state-empty">{lpBlocked ?? "Nothing is recorded here."}</li>
        )}
      </ul>

      <p className="muted small">Signed in as {me.fullName}.</p>
    </section>
  );
}
