import { useEffect, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { operatorAttention, type JobHealth } from "@shared/setup/operatorAttention";
import { attentionSignature } from "@shared/setup/attentionKey";
import { deliveryFor, greetingFor, roleFor } from "@shared/home/deliveries";
import { answerLine as answerLineFor, needsHer, secondLine as secondLineFor } from "@shared/home/answerLine";
import { DeliverableList } from "./DeliverableList";
import { PreviewApprovals, usePreviewApprovals } from "./PreviewApprovals";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";
import { DailyBriefPanel } from "./DailyBriefPanel";
import { bandsFor, effectiveFilter, readHomeFilter, writeHomeFilter, type HomeFilter } from "../lib/homeFilter";
import type { BriefStatusResponse } from "../lib/briefBand";
import { actionName } from "@shared/help/actionNames";
import { chiefOfStaffFor } from "@shared/work/chiefOfStaff";
import { ConnectPanel } from "./ConnectPanel";

/**
 * MP Home / Executive Command Center (P14, GAP-04 + GAP-23).
 *
 * Reads ONE aggregation (`/api/mp-home`) and renders configurable modules. Every module
 * states which Managing Partner question it answers and links to the surface that owns
 * the underlying records — the home is a view, never a second store.
 *
 * The private personal-intelligence panel is deliberately a separate, collapsed section
 * with its own disclaimer. It is owner-only server-side; hiding it here is presentation,
 * not the boundary.
 */

interface HomeModule {
  key: string;
  title: string;
  answers: string;
  link: string;
  count: number;
  items: Array<Record<string, unknown>>;
  note?: string;
  /** When the reader last opened this module; null if never. */
  seen_at?: string | null;
  /** Items newer than that mark. "Has something for you" means this, not "has items". */
  new_count?: number;
  has_new?: boolean;
}

/** An approval card as the Waiting band decides it — the fields `/api/mp-home` carries on the row. */
interface ApprovalItem {
  id: string;
  title: string;
  action_key: string;
  created_at: string;
  risk_level: string;
  impact_note: string | null;
  expires_at: string | null;
  requested_by_type: string;
  requested_by_id: string;
}

/** New since the reader last looked — never opened counts as new, an empty module never does. */
const hasNew = (m: HomeModule): boolean => (typeof m.has_new === "boolean" ? m.has_new : m.items.length > 0);

const sinceWhen = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

interface HomeResponse {
  /** Mail that reached the firm's inbox carrying no trigger anyone could route. */
  unrouted_emails?: number;
  modules: HomeModule[];
  enabled_modules: string[];
  available_modules: string[];
  one_thing_to_watch: { headline: string; because: string; link: string } | null;
  questions: Array<{ question: string; module: string | null }>;
  generated_at: string;
}

interface PreferenceResponse {
  preference: { version_no: number; modules_json: string; briefing_json: string; created_at: string } | null;
  history: Array<{ id: string; version_no: number; created_at: string; set_by: string }>;
}

const MODULE_LABELS: Record<string, string> = {
  approvals: "Waiting on your decision",
  intelligence: "Market signals",
  portfolio_risk: "Portfolio risk",
  allocation_constraints: "Allocation constraints",
  meetings: "Upcoming meetings",
  ic_priorities: "IC / deal priorities",
  lp_signals: "LP / fundraising signals",
  reconciliation: "Reconciliation exceptions",
  ai_spend: "AI spend today",
  what_changed: "What changed",
  my_work: "My open work",
  employees: "AI workforce",
  health: "What is broken",
};


/**
 * An employee's face, at whatever size the surface needs.
 *
 * Portraits are AI-generated images of people who do not exist, and the alt text says so — a
 * screen-reader user is told what a sighted user can only infer. A missing or failed file falls
 * back to initials rather than a broken image, which is the failure mode that would otherwise show
 * up on the busiest page in the product.
 */
function Face({ name, role, size = 36 }: { name: string; role: string; size?: number }) {
  const src = portraitFor(name);
  const initials = name.slice(0, 2).toUpperCase();
  if (!src) return <span className="face" style={{ width: size, height: size }}>{initials}</span>;
  return (
    <img
      className="face"
      style={{ width: size, height: size }}
      src={src}
      alt={portraitAlt(name, role)}
      width={size}
      height={size}
      loading="lazy"
      onError={(e) => {
        (e.currentTarget as HTMLImageElement).style.display = "none";
      }}
    />
  );
}

/** Render one row per module type. Deliberately explicit: each surface has its own shape. */
function summarize(moduleKey: string, item: Record<string, unknown>): string {
  const s = (k: string) => (item[k] === null || item[k] === undefined ? "" : String(item[k]));
  switch (moduleKey) {
    case "approvals":
      return `${s("title")} — ${s("action_key")}`;
    case "intelligence":
      return s("title");
    case "portfolio_risk":
      return `${s("severity")} · ${s("canonical_name") || s("company_id")} — ${s("alert_type")}${s("metric_key") ? ` (${s("metric_key")})` : ""}`;
    case "allocation_constraints":
      return `${s("severity")} · ${s("kind")} — ${s("detail")}`;
    case "meetings":
      return `${s("scheduled_at")} — ${s("title")} (${s("meeting_type")})`;
    case "ic_priorities":
      return `${s("status")} · ${s("canonical_name") || s("company_id")} — ${s("title")}`;
    case "lp_signals":
      return `${s("stage")} · ${s("legal_name")}${s("target_commitment") ? ` — target ${s("target_commitment")}` : ""}`;
    case "reconciliation":
      return `${s("exception_kind")} · ${s("record_kind")}/${s("record_key")} field ${s("field")}`;
    case "ai_spend": {
      /*
       * WAS `${cost_mode}/${privacy_mode}` — two columns that no longer decide anything, printed as
       * the firm's spending posture. The owner read "NORMAL/FRONTIER" on a morning the router was
       * in fact economising, and reasonably concluded the opposite. The lever and the gradient
       * position are what route; privacy keeps its own word so it cannot be read as a spend mode.
       *
       * And a stopped run now carries its cause and its clock. "2 blocked run(s)" with neither is
       * the exact thing she has said twice she cannot act on — the two she saw had stopped eleven
       * hours earlier and been fixed by a deploy in between, and the card could not say so.
       */
      const posture = s("gradient_applies") === "true" ? `${s("spend_lever")} · ${s("gradient_position")}` : s("spend_lever");
      const stopped = Number(item["blocked_runs_today"] ?? 0);
      const head = `$${s("spent_usd")} of $${s("daily_cap_usd")} cap · ${posture} · privacy ${s("privacy_mode")}`;
      if (stopped === 0) return `${head} · nothing stopped today`;
      return `${head} · ${stopped} run(s) stopped, last at ${s("blocked_last_at")} — ${s("blocked_reason")}${
        item["blocked_is_hers_to_fix"] === true ? " (you can change this on the Cockpit)" : ""
      }`;
    }
    case "what_changed":
      return `${s("event_type")} — ${s("object_type")}/${s("object_id")} at ${s("created_at")}`;
    case "my_work":
      return `${s("priority")} · ${s("title")} — ${s("state")}${s("next_action") ? ` · next: ${s("next_action")}` : ""}`;
    default:
      return JSON.stringify(item);
  }
}

function ModuleSettings({ home, onSaved }: { home: HomeResponse; onSaved: () => void }) {
  const prefs = useApi<PreferenceResponse>("/api/mp-home/preferences");
  const [selected, setSelected] = useState<string[]>(home.enabled_modules);
  const [message, setMessage] = useState<string | null>(null);
  // Mounted only when the foot's "Choose what Home shows" opens it, so it opens OPEN: a second
  // "Configure" press to reach the toggles was the clunk the design removed (§3.7).
  const [open, setOpen] = useState(true);

  useEffect(() => {
    setSelected(home.enabled_modules);
  }, [home.enabled_modules]);

  return (
    <section className="card" data-testid="home-settings">
      <header className="module-card-head">
        <h4>Home layout</h4>
        <button type="button" className="link-button" data-testid="home-settings-done" onClick={() => setOpen((o) => !o)}>
          {open ? "Done" : "Configure"}
        </button>
      </header>
      {open && (
        <>
          <div className="module-toggles">
            {home.available_modules.map((key) => (
              <label key={key} className="module-toggle">
                <input
                  type="checkbox"
                  data-testid={`module-toggle-${key}`}
                  checked={selected.includes(key)}
                  onChange={(e) =>
                    setSelected((cur) => (e.target.checked ? [...cur, key] : cur.filter((k) => k !== key)))
                  }
                />{" "}
                {MODULE_LABELS[key] ?? key}
              </label>
            ))}
          </div>
          <button
            type="button"
            data-testid="home-settings-save"
            onClick={async () => {
              const res = await api<{ version_no: number }>("/api/mp-home/preferences", {
                method: "POST",
                body: { modules: selected, briefing: {} },
              });
              setMessage(
                res.status === 201
                  ? `Saved as version ${res.data?.version_no}. Previous versions are kept.`
                  : `Save failed (HTTP ${res.status}).`,
              );
              prefs.reload();
              onSaved();
            }}
          >
            Save layout
          </button>
          {message && <p className="notice" data-testid="home-settings-message">{message}</p>}
          {prefs.data?.history && prefs.data.history.length > 0 && (
            <p className="muted small">
              {prefs.data.history.length} saved version(s); the newest applies. Preferences are append-only.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function HomePage({ me, onNavigate }: { me: MeResponse; onNavigate: (key: string) => void }) {
  /*
   * HOME, REBUILT (design/HOME_DESIGN.md, approved 19 Sep 2026). The owner: "the Home page UX is
   * annoying, not intuitive and clunky. The show / put away is stupid and clunky and should be some
   * kind of filter that is easy to return to home state. The open things below have to be opened
   * one by one and can't all be dismissed. And obviously the brief section and its UX is wrong —
   * we need to see completion state and progress."
   *
   * At 7 AM on her phone it answers WHAT IS WAITING ON ME and WHAT ARRIVED OVERNIGHT above the
   * fold at 390px. One masthead answer from one count; one filter rail instead of four toggles;
   * Waiting with inline Approve / Reject / Open and select-many for quieting; Arrived with Mark all
   * read and select-many; the brief as one band with its named states; Quiet as one line; Ask,
   * Home layout and Setup on a foot line. Every hook sits above every early return.
   */
  const home = useApi<HomeResponse>("/api/mp-home");
  const previews = usePreviewApprovals();
  const jobs = useApi<{ jobs: JobHealth[] }>("/api/jobs");
  const providers = useApi<{ providers: Array<{ enabled: number; kill_switched: number }> }>("/api/ai/providers");
  const silenced = useApi<{ silenced: Array<{ item_key: string; signature: string }> }>("/api/attention/silenced");
  const connections = useApi<{ connections: Array<{ status: string }> }>("/api/me/connections");
  const brief = useApi<BriefStatusResponse>("/api/daily-intelligence/status");
  const [remembered] = useState<HomeFilter>(() => readHomeFilter(me.id));
  const [chosen, setChosen] = useState<HomeFilter | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [waitingSelect, setWaitingSelect] = useState<Set<string> | null>(null);
  const [arrivedSelect, setArrivedSelect] = useState<Set<string> | null>(null);
  const [arrivedRows, setArrivedRows] = useState<Array<{ id: string; acknowledged_at: string | null }>>([]);
  const [arrivedReload, setArrivedReload] = useState(0);
  const [undo, setUndo] = useState<{ ids: string[]; what: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [decided, setDecided] = useState<Record<string, string>>({});

  // Mark the visit AFTER the first read, so "what changed" is a diff against the previous visit.
  useEffect(() => {
    if (home.status === 200) void api("/api/mp-home/seen", { method: "POST" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home.status]);
  // The rail answers Esc with All — the one-tap return, from the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setChosen("all"); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (home.loading && !home.data) return <p data-testid="home-loading">Loading your command surface…</p>;
  if (home.status !== 200 || !home.data) {
    return <p data-testid="home-error">Could not load the command surface (HTTP {home.status ?? "?"}).</p>;
  }
  const data = home.data;

  // ── The counts every band and the masthead share ──
  const waiting = data.modules.find((m) => m.key === "approvals") ?? null;
  const deliveries = data.modules.filter((m) => m.key !== "approvals");
  const waitingItems = (waiting?.items ?? []) as unknown as ApprovalItem[];
  const freshDeliveries = deliveries.filter(hasNew);
  const quietDeliveries = deliveries.filter((m) => !hasNew(m));
  const chiefOfStaff = (() => { const mine = chiefOfStaffFor(me.fullName); return { name: mine, role: roleFor(mine) ?? "Chief of Staff" }; })();

  const attention = operatorAttention({
    ...(jobs.data ? { jobs: jobs.data.jobs } : {}),
    ...(typeof data.unrouted_emails === "number" ? { unroutedEmails: data.unrouted_emails } : {}),
    ...(providers.data ? { aiProviderConfigured: providers.data.providers.some((x) => x.enabled === 1 && x.kill_switched === 0) } : {}),
  });
  const silencedKeys = new Set((silenced.data?.silenced ?? []).map((r) => attentionSignature(r.item_key, r.signature)));
  /*
   * THE VIEWER'S OWN BRIEF IS SAID ONCE. Its health fault used to be a blocker here AND the brief
   * band's failed state under it (audit #7). The brief band owns it; the blocker for the OTHER
   * partner's brief stays, because that is news.
   */
  const myBriefKey = `daily_brief_${me.id}`;
  const visibleAttention = attention.filter((a) => !silencedKeys.has(attentionSignature(a.key, a.headline)) && !a.key.includes(myBriefKey));
  const silencedCount = attention.length - visibleAttention.length;
  const undecided = waitingItems.filter((c) => !decided[c.id]);
  const counts = {
    decisions: undecided.length,
    blockers: visibleAttention.length,
    firstBlocker: visibleAttention[0]?.headline ?? null,
    previews: previews.previews.length,
    fresh: arrivedRows.filter((r) => !r.acknowledged_at).length + freshDeliveries.length,
    quiet: new Set(quietDeliveries.map((m) => deliveryFor(m.key)?.by ?? m.title)).size,
    brief: brief.data?.line ?? null,
  };
  const waitingCount = needsHer(counts);
  const arrivedCount = counts.fresh;
  const quietCount = counts.quiet;
  const filter = effectiveFilter(chosen ?? remembered, { waiting: waitingCount, arrived: arrivedCount, quiet: quietCount });
  const bands = bandsFor(filter);
  const pick = (f: HomeFilter) => { setChosen(f); writeHomeFilter(me.id, f); };

  async function silenceMany(items: Array<{ key: string; signature: string }>, kind: "ACKNOWLEDGED" | "DISMISSED") {
    if (items.length === 0) return;
    const res = await api<{ ok?: boolean; error?: string; detail?: string }>("/api/attention/dismiss-many", { method: "POST", body: { items, kind } });
    setNotice(res.status === 200 ? (kind === "ACKNOWLEDGED" ? `Quiet for a week: ${items.length}.` : `Stopped for good: ${items.length}.`) : `Could not quiet them: ${res.data?.detail ?? res.data?.error ?? res.status}`);
    setWaitingSelect(null);
    silenced.reload();
  }
  async function markMany(ids: string[], kind: "acknowledge" | "dismiss") {
    if (ids.length === 0) return;
    const res = await api<{ done?: string[]; missing?: string[]; note?: string | null }>(`/api/deliverables/${kind}-many`, { method: "POST", body: { ids } });
    if (res.status === 200 || res.status === 207) {
      setNotice(kind === "acknowledge" ? `Marked ${res.data?.done?.length ?? ids.length} as read.${res.data?.note ? ` ${res.data.note}` : ""}` : `Put ${res.data?.done?.length ?? ids.length} away.${res.data?.note ? ` ${res.data.note}` : ""}`);
      setUndo(kind === "dismiss" ? { ids: res.data?.done ?? ids, what: "put away" } : null);
    } else setNotice(`Could not do that (HTTP ${res.status}).`);
    setArrivedSelect(null);
    setArrivedReload((n) => n + 1);
  }
  async function undoPutAway() {
    if (!undo) return;
    for (const id of undo.ids) await api(`/api/deliverables/${id}/dismiss?restore=1`, { method: "POST", body: {} });
    setNotice(`Back on the page: ${undo.ids.length}.`);
    setUndo(null);
    setArrivedReload((n) => n + 1);
  }
  async function decide(card: ApprovalItem, decision: "approved" | "rejected") {
    setDeciding(card.id);
    const res = await api<{ error?: string; detail?: string; state?: string }>(`/api/approvals/${card.id}/decide`, { method: "POST", body: { decision, ...(decision === "rejected" && rejectNote.trim() ? { note: rejectNote.trim() } : {}) } });
    setDeciding(null);
    const at = new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (res.status === 200) {
      setDecided((d) => ({ ...d, [card.id]: `${decision} ${at}` }));
      setRejecting(null);
      setRejectNote("");
      setNotice(decision === "approved" ? `Approved at ${at}. It runs now.` : `Rejected at ${at}.`);
      // The row stays, wearing its `approved 7:04 AM` badge, and leaves on the next read
      // (design/HOME_DESIGN.md §3.3) — `undecided` already keeps it out of the count. A reload
      // here made the badge a flicker: the card was gone before she saw what she had done.
    } else {
      setNotice(res.status === 409 ? `Not ${decision} — it is no longer pending (somebody decided it first).` : `Not ${decision}: ${res.data?.detail ?? res.data?.error ?? `HTTP ${res.status}`}`);
      home.reload();
    }
  }

  const answer = answerLineFor(counts);
  const second = secondLineFor(counts);
  const connected = (connections.data?.connections ?? []).filter((c) => c.status === "CONNECTED").length;
  const connTotal = connections.data?.connections.length ?? 0;
  const quietNames = Array.from(new Set(quietDeliveries.map((m) => deliveryFor(m.key)?.by ?? m.title)));
  const chip = (key: HomeFilter, label: string, n: number | null) => (
    <button
      type="button"
      className="rail-chip"
      role="tab"
      aria-pressed={filter === key}
      aria-selected={filter === key}
      aria-label={n === null ? label : `${label}, ${n}`}
      data-testid={`home-rail-${key}`}
      onClick={() => pick(key)}
    >
      {label}{n !== null && <span className="rail-count" aria-hidden="true">{n}</span>}
    </button>
  );

  return (
    <section data-testid="home-page">
      {/* ══ RANK 0 · THE MASTHEAD — one count, in words ══════════════════════════════════════ */}
      <header className="masthead" data-testid="home-masthead">
        <p className="masthead-date" data-testid="home-greeting">
          {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
          {" · "}
          {greetingFor(new Date().getHours())}, {me.fullName.split(" ")[0]}
        </p>
        <h2 data-testid="home-answer">{answer}</h2>
        <p className="masthead-second" data-testid="home-team-count">{second}</p>
      </header>

      {/* ══ THE RAIL — one filter instead of four toggles; ← Home is the one-tap return ═══════ */}
      <nav className="rail" aria-label="Show on Home" role="tablist" data-testid="home-rail" data-filter={filter}>
        {filter !== "all" && (
          <button type="button" className="rail-chip rail-home" data-testid="home-rail-home" onClick={() => pick("all")}>← Home</button>
        )}
        {chip("all", "All", null)}
        {chip("waiting", "Waiting on me", waitingCount)}
        {chip("arrived", "Arrived", arrivedCount)}
        {chip("quiet", "Quiet", quietCount)}
      </nav>

      {notice && (
        <p className="notice" role="status" data-testid="home-notice">
          {notice}
          {undo && <> <button type="button" className="link-button" data-testid="home-undo" onClick={() => void undoPutAway()}>Undo</button></>}
        </p>
      )}

      {/* ══ WAITING ON YOU — always renders; one line when empty ═════════════════════════════ */}
      {bands.waiting && (
        <section className="band" data-testid="home-waiting" aria-labelledby="home-waiting-head">
          <div className="band-head">
            <h3 id="home-waiting-head">Waiting on you</h3>
            {waitingCount > 0 && <span className="count-pill" data-testid="home-waiting-pill">{waitingCount}</span>}
            {waitingCount > 0 && visibleAttention.length > 0 && (
              <button type="button" className="band-act" data-testid="home-waiting-select" aria-pressed={waitingSelect !== null} onClick={() => setWaitingSelect(waitingSelect ? null : new Set())}>
                {waitingSelect ? "Cancel" : "Select…"}
              </button>
            )}
            {/* `band-when-echo`: this line says what the masthead's detail already said, ninety
                pixels up — on a phone it is hidden so the first row stays whole above the fold. */}
            <span className="band-when band-when-echo" data-testid="home-waiting-when">
              {waitingCount === 0
                ? "no decision is blocked on your signature"
                : undecided.length + previews.previews.length === 0
                  ? "nothing needs a signature — these are blockers"
                  : `${undecided.length + previews.previews.length === 1 ? "one decision is" : `${undecided.length + previews.previews.length} decisions are`} blocked on your signature`}
            </span>
          </div>

          {waitingSelect && (
            <div className="select-bar" role="toolbar" aria-label="Selected blockers" data-testid="home-waiting-select-bar">
              <span className="muted small">{waitingSelect.size} selected</span>
              <button type="button" className="btn-strong" disabled={waitingSelect.size === 0} data-testid="home-waiting-quiet-selected"
                onClick={() => void silenceMany(visibleAttention.filter((a) => waitingSelect.has(a.key)).map((a) => ({ key: a.key, signature: a.headline })), "ACKNOWLEDGED")}>
                I know — quiet selected for a week
              </button>
              <button type="button" className="btn-ghost" disabled={waitingSelect.size === 0} data-testid="home-waiting-stop-selected"
                onClick={() => void silenceMany(visibleAttention.filter((a) => waitingSelect.has(a.key)).map((a) => ({ key: a.key, signature: a.headline })), "DISMISSED")}>
                Stop telling me
              </button>
              <span className="muted small" id="home-approvals-one-at-a-time">Decided one at a time — a human-reserved action is never approved in a batch.</span>
            </div>
          )}

          {/* FIRST IN THE BAND: a preview decays if she does not answer it; its Approve and send is the page's one primary. */}
          <PreviewApprovals previews={previews.previews} onDecided={previews.reload} />

          {waitingCount === 0 && previews.previews.length === 0 ? (
            <p className="muted small" data-testid="home-waiting-empty">Nothing is blocked on you{silencedCount > 0 ? ` — ${silencedCount} ${silencedCount === 1 ? "item is" : "items are"} silenced` : ""}.</p>
          ) : (
            <ul className="deal-list" data-testid="home-waiting-list">
              {waitingItems.map((c, i) => {
                const outcome = decided[c.id];
                const risk = c.risk_level === "RESERVED" ? "badge badge-bad" : c.risk_level === "HIGH" || c.risk_level === "MEDIUM" ? "badge badge-gate" : "badge";
                return (
                  <li key={c.id} className="deal-row deal-row-3" data-testid={`home-waiting-card-${c.id}`}>
                    <div>
                      {waitingSelect && (
                        <label className="check row-select">
                          <input type="checkbox" disabled aria-describedby="home-approvals-one-at-a-time" aria-label={`Approvals are decided one at a time: ${c.title}`} />
                        </label>
                      )}
                      <span className={risk}>{c.risk_level === "RESERVED" ? "Human-reserved" : c.risk_level === "UNCLASSIFIED" ? "Approval" : c.risk_level.charAt(0) + c.risk_level.slice(1).toLowerCase()}</span>{" "}
                      <strong>{c.title}</strong>
                      <div className="muted small">
                        {actionName(c.action_key)}{c.impact_note ? ` — ${c.impact_note}` : ""}
                      </div>
                      <div className="muted small">
                        {c.requested_by_type === "AI" ? "An employee" : c.requested_by_type === "SYSTEM" ? "The system" : "A partner"} raised it · {new Date(c.created_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                        {c.expires_at ? ` · expires ${new Date(c.expires_at).toLocaleDateString()}` : ""}
                      </div>
                      {rejecting === c.id && (
                        <div className="form-row" data-testid={`home-reject-form-${c.id}`}>
                          <input aria-label="Why it is rejected (optional)" placeholder="Why, in a line (optional)" value={rejectNote} autoFocus onChange={(e) => setRejectNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setRejecting(null); }} />
                          <button type="button" className="btn-danger" disabled={deciding === c.id} data-testid={`home-reject-confirm-${c.id}`} onClick={() => void decide(c, "rejected")}>{deciding === c.id ? "Rejecting…" : "Reject it"}</button>
                          <button type="button" data-testid={`home-reject-cancel-${c.id}`} onClick={() => setRejecting(null)}>Never mind</button>
                        </div>
                      )}
                    </div>
                    {/* No "waiting on you" badge on a row inside the band headed "Waiting on you": the
                        band says it once. The cell appears when the row has been decided. */}
                    {outcome && <span className="readiness"><span className="badge badge-ok" data-testid={`home-decided-${c.id}`}>{outcome}</span></span>}
                    <div className="deal-actions">
                      {!outcome && (
                        <>
                          <button type="button" className="btn-strong" disabled={deciding === c.id} aria-busy={deciding === c.id} data-testid={`home-approve-${c.id}`} onClick={() => void decide(c, "approved")}>{deciding === c.id ? "Approving…" : "Approve"}</button>
                          <button type="button" className="btn-danger" aria-expanded={rejecting === c.id} data-testid={`home-reject-${c.id}`} onClick={() => setRejecting(rejecting === c.id ? null : c.id)}>Reject</button>
                        </>
                      )}
                      <button type="button" data-testid={`home-waiting-open-${i}`} onClick={() => onNavigate("approvals")}>Open</button>
                    </div>
                  </li>
                );
              })}
              {visibleAttention.map((a) => (
                <li key={a.key} className="deal-row deal-row-3 blocker" data-testid={`home-attention-${a.key}`}>
                  <div>
                    {waitingSelect && (
                      <label className="check row-select">
                        <input type="checkbox" data-testid={`home-attention-select-${a.key}`} aria-label={`Select ${a.headline}`} checked={waitingSelect.has(a.key)}
                          onChange={(e) => setWaitingSelect((s) => { const n = new Set(s ?? []); if (e.target.checked) n.add(a.key); else n.delete(a.key); return n; })} />
                      </label>
                    )}
                    <span className={a.severity === "BLOCKING" ? "badge badge-bad" : a.severity === "DEGRADED" ? "badge badge-gate" : "badge"}>
                      {a.severity === "BLOCKING" ? "Blocked" : a.severity === "DEGRADED" ? "Degraded" : "Setup"}
                    </span>{" "}
                    <strong>{a.headline}</strong>
                    <div className="muted small">{a.action}</div>
                  </div>
                  <span className="readiness"><span className="badge">not a signature</span></span>
                  <div className="deal-actions">
                    <button type="button" onClick={() => onNavigate(a.link)}>Open</button>
                    <button type="button" className="btn-ghost" data-testid={`home-attention-ack-${a.key}`} title="Seen, still true. Quiet for a week."
                      onClick={() => void silenceMany([{ key: a.key, signature: a.headline }], "ACKNOWLEDGED")}>
                      I know — quiet for a week
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {silencedCount > 0 && waitingCount > 0 && (
            <p className="muted small">
              {silencedCount} silenced — acknowledged ones return after a week, dismissed ones do not.{" "}
              <button type="button" className="link-button" data-testid="home-attention-unsilence" onClick={async () => { await api("/api/attention/silenced/clear", { method: "POST", body: {} }); silenced.reload(); }}>Bring them back</button>
            </p>
          )}
        </section>
      )}

      {/* ══ ARRIVED — everything for her except the brief, which is the band below ═══════════ */}
      {bands.arrived && (
        <section className="band" data-testid="home-deliverables" aria-labelledby="home-arrived-head">
          <div className="band-head">
            <h3 id="home-arrived-head">Arrived</h3>
            {arrivedCount > 0 && <span className="count-pill" data-testid="home-arrived-pill">{arrivedCount}</span>}
            {arrivedRows.some((r) => !r.acknowledged_at) && (
              <button type="button" className="band-act btn-ghost" data-testid="home-mark-all-read" onClick={() => void markMany(arrivedRows.filter((r) => !r.acknowledged_at).map((r) => r.id), "acknowledge")}>
                Mark all read
              </button>
            )}
            {arrivedRows.length > 0 && (
              <button type="button" className="band-act" data-testid="home-arrived-select" aria-pressed={arrivedSelect !== null} onClick={() => setArrivedSelect(arrivedSelect ? null : new Set())}>
                {arrivedSelect ? "Cancel" : "Select…"}
              </button>
            )}
            <span className="band-when" data-testid="home-deliveries-count">
              {arrivedCount === 0 ? "nothing new since you last looked" : `${arrivedCount} since you last looked`}
            </span>
          </div>
          {arrivedSelect && (
            <div className="select-bar" role="toolbar" aria-label="Selected arrivals" data-testid="home-arrived-select-bar">
              <span className="muted small">{arrivedSelect.size} selected</span>
              <button type="button" className="btn-strong" disabled={arrivedSelect.size === 0} data-testid="home-arrived-read-selected" onClick={() => void markMany(Array.from(arrivedSelect), "acknowledge")}>Mark read</button>
              <button type="button" className="btn-ghost" disabled={arrivedSelect.size === 0} data-testid="home-arrived-put-away-selected" onClick={() => void markMany(Array.from(arrivedSelect), "dismiss")}>Put away</button>
            </div>
          )}
          <DeliverableList
            limit={6}
            onNavigate={onNavigate}
            mine
            meId={me.id}
            excludeKind="daily_brief"
            selectable={arrivedSelect !== null}
            selected={arrivedSelect ?? undefined}
            onSelect={(id, on) => setArrivedSelect((s) => { const n = new Set(s ?? []); if (on) n.add(id); else n.delete(id); return n; })}
            reloadKey={arrivedReload}
            onRows={setArrivedRows}
            emptyNote="Nothing arrived since you last looked. Research packets, meeting preps and a colleague's findings land here."
          />
          {freshDeliveries.length > 0 && (
            <ul className="deal-list" data-testid="home-fresh-modules">
              {freshDeliveries.map((m) => {
                const delivery = deliveryFor(m.key);
                return (
                  <li key={m.key} className="deal-row deal-row-2" data-testid={`home-module-${m.key}`} data-fresh="new">
                    <div>
                      {delivery && <Face name={delivery.by} role={roleFor(delivery.by) ?? ""} size={28} />}
                      <strong>{delivery?.by ?? m.title}</strong>
                      <div className="muted small">
                        {delivery?.headline ?? m.title}
                        {typeof m.new_count === "number" && m.seen_at && (
                          <span data-testid={`home-module-new-${m.key}`}> · {m.new_count} new since {sinceWhen(m.seen_at)}</span>
                        )}
                      </div>
                      <ul className="module-items">{m.items.slice(0, 2).map((item, i) => <li key={String(item.id ?? i)}>{summarize(m.key, item)}</li>)}</ul>
                    </div>
                    <button type="button" data-testid={`home-open-${m.key}`} onClick={() => void api(`/api/mp-home/modules/${encodeURIComponent(m.key)}/seen`, { method: "POST", body: {} }).then(() => onNavigate(m.link))}>Open</button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* ══ TODAY'S BRIEF — on every filter; the one thing built on request ══════════════════ */}
      <section className="band" data-testid="home-brief-delivery" aria-labelledby="home-brief-head">
        <div className="band-head">
          <h3 id="home-brief-head">Today's brief</h3>
          <span className="band-when"><strong>{chiefOfStaff.name}</strong> · {chiefOfStaff.role} · on demand, on claude-sonnet-5</span>
        </div>
        <DailyBriefPanel compact viewerId={me.id} preparedBy={chiefOfStaff.name} />
      </section>

      {/* ══ QUIET — one line, and the rows only under the Quiet chip ═════════════════════════ */}
      {bands.quiet && quietNames.length > 0 && (
        <section className="band" data-testid="home-quiet" aria-labelledby="home-quiet-head">
          <div className="band-head">
            <h3 id="home-quiet-head">Quiet</h3>
            <span className="band-when">{quietNames.length} {quietNames.length === 1 ? "colleague has" : "colleagues have"} nothing new</span>
          </div>
          {filter !== "quiet" ? (
            <p className="quiet-roll" data-testid="home-quiet-roll">
              {quietNames.join(", ").replace(/, ([^,]*)$/, " and $1")} — <b>nothing new since you last looked</b>.{" "}
              <button type="button" className="link-button" data-testid="home-quiet-roll-toggle" onClick={() => pick("quiet")}>Filter by Quiet to see each</button>
            </p>
          ) : (
            <ul className="deal-list" data-testid="home-quiet-list">
              {quietDeliveries.map((m) => {
                const delivery = deliveryFor(m.key);
                return (
                  <li key={m.key} className="deal-row deal-row-2 deal-row-out" data-testid={`home-module-${m.key}`} data-fresh={m.items.length === 0 ? "empty" : "quiet"}>
                    <div>
                      {delivery && <Face name={delivery.by} role={roleFor(delivery.by) ?? ""} size={28} />}
                      <strong>{delivery?.by ?? m.title}</strong>
                      <div className="muted small" data-testid={m.items.length === 0 ? `home-module-empty-${m.key}` : `home-module-quiet-${m.key}`}>
                        {m.items.length === 0 ? (delivery?.whenEmpty ?? m.note ?? "Nothing to report.") : `nothing new since ${m.seen_at ? sinceWhen(m.seen_at) : "you last looked"}`}
                      </div>
                    </div>
                    <button type="button" data-testid={`home-open-${m.key}`} onClick={() => void api(`/api/mp-home/modules/${encodeURIComponent(m.key)}/seen`, { method: "POST", body: {} }).then(() => onNavigate(m.link))}>Open {m.title}</button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      {/* ══ THE FOOT — Ask, Home layout, Setup: findable, never above the answer ═════════════ */}
      <p className="rail-note" data-testid="home-foot">
        <button type="button" className="link-button" data-testid="home-ask-open" onClick={() => onNavigate("intent")}>Ask for anything →</button>
        {" · "}
        <button type="button" className="link-button" data-testid="home-settings-toggle" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((o) => !o)}>Choose what Home shows</button>
        {" · "}
        <button type="button" className="link-button" data-testid="home-setup-toggle" aria-expanded={setupOpen} onClick={() => setSetupOpen((o) => !o)}>
          Setup — {connections.data ? `${connected} of ${connTotal} connected` : "checking"}
        </button>
        {" · "}
        <button type="button" className="link-button" data-testid="home-private-link" onClick={() => onNavigate("private")}>Private layer</button>
      </p>
      {settingsOpen && <ModuleSettings home={data} onSaved={home.reload} />}
      {setupOpen && <ConnectPanel me={me} />}
    </section>
  );
}
