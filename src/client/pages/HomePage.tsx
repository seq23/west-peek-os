import { useEffect, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { operatorAttention, type JobHealth } from "@shared/setup/operatorAttention";
import { attentionSignature } from "@shared/setup/attentionKey";
import { deliveryFor, greetingFor, roleFor } from "@shared/home/deliveries";
import { DeliverableList } from "./DeliverableList";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";
import { DailyBriefPanel } from "./DailyBriefPanel";
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
}

interface HomeResponse {
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

interface PersonalProfile {
  profile: { enabled: number; calculation_state: string; calculation_source: string } | null;
  calculation_note: string;
}

interface PersonalEntry {
  id: string;
  entry_date: string;
  kind: string;
  headline: string;
  body: string;
  calculation_state: string;
  source_note: string;
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

/**
 * One delivery: the same records the module always held, now from somebody.
 *
 * The byline is the whole change. "Portfolio risk: 0" is a number; "Winter — no open alerts on
 * anything you own" is a colleague telling you something, and it is answerable, because you can go
 * and ask her. Attribution names whose AREA this is — these panels are assembled from records by a
 * query, not written — and the one genuinely authored thing on this page is the brief, which says
 * so itself.
 *
 * An empty delivery keeps its byline and says what silence means. Twelve panels reading "Nothing
 * here." is what made this product feel broken when it was merely unloaded.
 */
function DeliveryCard({ module, onNavigate }: { module: HomeModule; onNavigate: (key: string) => void }) {
  const delivery = deliveryFor(module.key);
  const role = delivery ? roleFor(delivery.by) : null;
  const empty = module.items.length === 0;

  return (
    <li
      className={empty ? "delivery delivery-quiet" : "delivery"}
      data-testid={`home-module-${module.key}`}
    >
      {delivery && <Face name={delivery.by} role={role ?? ""} size={empty ? 28 : 36} />}

      <div className="delivery-what">
        {delivery && (
          <div className="delivery-who" data-testid={`home-delivery-by-${module.key}`}>
            <strong>{delivery.by}</strong>
            {role && <span className="muted small"> {role}</span>}
          </div>
        )}

        {empty ? (
          <div className="muted small" data-testid={`home-module-empty-${module.key}`}>
            {delivery?.whenEmpty ?? module.note ?? "Nothing to report."}
          </div>
        ) : (
          <>
            <div className="delivery-headline">{delivery?.headline ?? module.title}</div>
            <ul className="module-items">
              {module.items.slice(0, 2).map((item, i) => (
                <li key={String(item.id ?? i)}>{summarize(module.key, item)}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      {!empty && (
        <button type="button" data-testid={`home-open-${module.key}`} onClick={() => onNavigate(module.link)}>
          Open
        </button>
      )}
    </li>
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
    case "ai_spend":
      return `$${s("spent_usd")} of $${s("daily_cap_usd")} cap · ${s("cost_mode")}/${s("privacy_mode")} · ${s("blocked_runs_today")} blocked run(s)`;
    case "what_changed":
      return `${s("event_type")} — ${s("object_type")}/${s("object_id")} at ${s("created_at")}`;
    case "my_work":
      return `${s("priority")} · ${s("title")} — ${s("state")}${s("next_action") ? ` · next: ${s("next_action")}` : ""}`;
    default:
      return JSON.stringify(item);
  }
}

function PersonalIntelligencePanel() {
  const [open, setOpen] = useState(false);
  const profile = useApi<PersonalProfile>(open ? "/api/personal-intelligence/profile" : null);
  const entries = useApi<{ entries: PersonalEntry[]; disclaimer: string }>(open ? "/api/personal-intelligence/entries" : null);
  const [message, setMessage] = useState<string | null>(null);
  const [headline, setHeadline] = useState("");
  const [kind, setKind] = useState("TIMING_WINDOW");

  const enabled = profile.data?.profile?.enabled === 1;

  return (
    <section className="card private-panel" data-testid="personal-intelligence">
      <header className="module-card-head">
        <h3>Private layer</h3>
        <button type="button" className="link-button" data-testid="personal-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Show"}
        </button>
      </header>
      <p className="muted small">
        Personal timing overlays, visible only to you. Not institutional truth, never firm evidence, and never a
        justification for an investment, LP, or compliance decision.
      </p>
      {open && (
        <>
          {profile.loading && <p>Loading…</p>}
          {profile.data && (
            <p className="muted small" data-testid="personal-calculation-note">
              {profile.data.calculation_note}
            </p>
          )}
          {!enabled ? (
            <button
              type="button"
              data-testid="personal-enable"
              onClick={async () => {
                const res = await api("/api/personal-intelligence/profile", {
                  method: "POST",
                  body: { enabled: true, config: { overlays: ["TRANSIT", "LUNAR", "TIMING_WINDOW"] }, calculation_source: "NONE" },
                });
                setMessage(res.status === 201 ? "Private layer enabled for you only." : `Could not enable (HTTP ${res.status}).`);
                profile.reload();
              }}
            >
              Enable my private layer
            </button>
          ) : (
            <form
              className="form-row"
              data-testid="personal-entry-form"
              onSubmit={async (e) => {
                e.preventDefault();
                const res = await api<{ error?: string }>("/api/personal-intelligence/entries", {
                  method: "POST",
                  body: {
                    entry_date: new Date().toISOString().slice(0, 10),
                    kind,
                    headline,
                    body: "",
                  },
                });
                setMessage(res.status === 201 ? "Recorded (manual entry)." : `Refused: ${res.data?.error ?? res.status}`);
                setHeadline("");
                entries.reload();
              }}
            >
              <select data-testid="personal-kind" aria-label="Kind of entry" value={kind} onChange={(e) => setKind(e.target.value)}>
                {["TRANSIT", "LUNAR", "TIMING_WINDOW", "NOTE"].map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
              <input
                data-testid="personal-headline" aria-label="Headline"
                value={headline}
                onChange={(e) => setHeadline(e.target.value)}
                placeholder="What are you watching for yourself?"
              />
              <button type="submit" className="btn-strong" data-testid="personal-submit">
                Record
              </button>
            </form>
          )}
          {message && <p className="notice" data-testid="personal-message">{message}</p>}
          <ul className="card-list" data-testid="personal-entries">
            {(entries.data?.entries ?? []).map((e) => (
              <li key={e.id}>
                <strong>{e.entry_date}</strong> · {e.kind} — {e.headline} <code>{e.calculation_state}</code>
              </li>
            ))}
            {open && !entries.loading && (entries.data?.entries ?? []).length === 0 && <li className="state-empty">No entries.</li>}
          </ul>
        </>
      )}
    </section>
  );
}

function ModuleSettings({ home, onSaved }: { home: HomeResponse; onSaved: () => void }) {
  const prefs = useApi<PreferenceResponse>("/api/mp-home/preferences");
  const [selected, setSelected] = useState<string[]>(home.enabled_modules);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setSelected(home.enabled_modules);
  }, [home.enabled_modules]);

  return (
    <section className="card" data-testid="home-settings">
      <header className="module-card-head">
        <h3>Home layout</h3>
        <button type="button" className="link-button" data-testid="home-settings-toggle" onClick={() => setOpen((o) => !o)}>
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
  const home = useApi<HomeResponse>("/api/mp-home");
  // §8 — the four operator questions Home's modules do not answer: what is blocked, is scheduled
  // work healthy, is AI failing, is setup incomplete. Derived from live endpoints only.
  const jobs = useApi<{ jobs: JobHealth[] }>("/api/jobs");
  const providers = useApi<{ providers: Array<{ enabled: number; kill_switched: number }> }>("/api/ai/providers");

  // Mark the visit AFTER the first read, so "what changed" is a diff against the
  // previous visit rather than against this one.
  useEffect(() => {
    if (home.status === 200) void api("/api/mp-home/seen", { method: "POST" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home.status]);

  // Only the FIRST load blanks the page. A refresh after saving preferences keeps the
  // rendered surface (and the settings panel's own state) in place.
  if (home.loading && !home.data) return <p data-testid="home-loading">Loading your command surface…</p>;
  if (home.status !== 200 || !home.data) {
    return <p data-testid="home-error">Could not load the command surface (HTTP {home.status ?? "?"}).</p>;
  }

  const data = home.data;

  // Approvals are pulled out of the grid; everything else is a delivery.
  const waiting = data.modules.find((m) => m.key === "approvals") ?? null;
  const deliveries = data.modules.filter((m) => m.key !== "approvals");

  /**
   * Who signs the morning off. The reader's own Chief of Staff — Wren for Sequoia, Walker for
   * Scooter — because a delivery from "the system" is the anonymity this page exists to fix.
   * Matched on first name so a retitle in the roster reaches the byline; falls back to the
   * firm-wide chief rather than leaving the page unsigned.
   */
  const chiefOfStaff = (() => {
    const mine = chiefOfStaffFor(me.fullName);
    return { name: mine, role: roleFor(mine) ?? "Chief of Staff" };
  })();

  // `undefined` where a source has not answered, so the strip stays silent rather than guessing.
  const attention = operatorAttention({
    ...(jobs.data ? { jobs: jobs.data.jobs } : {}),
    ...(providers.data
      ? {
          aiProviderConfigured: providers.data.providers.some(
            (x) => x.enabled === 1 && x.kill_switched === 0,
          ),
        }
      : {}),
  });

  /*
   * Silencing is matched on the item's key AND the words it was showing. An item whose headline
   * changes has become a different thing to be told about, so it comes back — see the attention
   * service for the reasoning. Nothing is filtered while the silence list is still loading, because
   * hiding an alert on the strength of data you do not have yet is the wrong way round.
   */
  const silenced = useApi<{ silenced: Array<{ item_key: string; signature: string }> }>("/api/attention/silenced");
  const silencedKeys = new Set((silenced.data?.silenced ?? []).map((r) => attentionSignature(r.item_key, r.signature)));
  const visibleAttention = attention.filter((a) => !silencedKeys.has(attentionSignature(a.key, a.headline)));
  const silencedCount = attention.length - visibleAttention.length;

  async function silence(key: string, signature: string, kind: "ACKNOWLEDGED" | "DISMISSED") {
    await api(`/api/attention/${encodeURIComponent(key)}/dismiss`, { method: "POST", body: { signature, kind } });
    silenced.reload();
  }

  async function unsilence() {
    await api("/api/attention/silenced/clear", { method: "POST", body: {} });
    silenced.reload();
  }

  return (
    <section data-testid="home-page">
      {/* SETUP SITS ABOVE THE DATE, folded to one line. It was a full screen of settings between
          the partner and the briefing they came for, every morning — so it now states what is on
          and what is not, and opens only when asked. Above rather than below because a status strip
          is a header, not an interruption: read it or ignore it before the day starts. */}
      <ConnectPanel me={me} />

      {/* A delivery has a moment. "This morning" means something; "your dashboard" does not — so
          the page is dated, addressed, and signed by whoever brought it. The hour comes from the
          browser because a Worker runs in UTC and the partner does not. */}
      <header className="home-masthead" data-testid="home-masthead">
        <div>
          <div className="home-date">
            {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </div>
          <h1 data-testid="home-greeting">
            {greetingFor(new Date().getHours())}, {me.fullName.split(" ")[0]}
          </h1>
        </div>
        {/* The byline used to live here, floating in the corner, nowhere near the thing it
            described. It now sits ON the briefing, the way a byline sits on an article. */}
        <div className="home-signed">
          <div className="muted small">
            {deliveries.filter((m) => m.items.length > 0).length + (waiting && waiting.items.length > 0 ? 1 : 0)} of your
            team have something for you
          </div>
        </div>
      </header>

      {/* ASK — its own highlighted band on Home, added on operator direction (17 Aug 2026): "it can
          be on the home page in its own section that is highlighted so users know its there for
          them when they need."

          Deliberately NOT a module card. The module grid is a list of places to go; this is an
          offer, and making it look like the other cards is how it becomes invisible again. It also
          stays in the nav — Home is where you are reminded it exists, the nav is where you reach
          for it once you already know.

          The examples are real capabilities, not placeholder prompts: showing something Ask cannot
          do would teach the operator to distrust it on the first try. */}
      <section className="card ask-band" data-testid="home-ask">
        <h2>Ask</h2>
        <p>
          Describe what you need in your own words. Ask works out which part of the firm owns it,
          shows you the plan, and does nothing consequential without your approval.
        </p>
        <div className="ask-examples">
          <button type="button" className="btn-strong" data-testid="home-ask-open" onClick={() => onNavigate("intent")}>
            Ask for something
          </button>
          <span className="muted small">
            e.g. “what changed in the portfolio this week?” · “prep me for the Acme call” ·
            “who should introduce me to a design partner?”
          </span>
        </div>
      </section>

      {/* §8 — what is blocked, first: a dead-lettered job or an unconfigured provider makes
          everything below it unreliable. Absent when there is genuinely nothing wrong — an empty
          command surface is a correct answer.

          "One thing to watch" used to sit below this and was removed on operator direction
          (17 Aug 2026): it restated what the modules already showed, so it cost a screenful of
          Home to tell the operator something they were about to read anyway. The derivation
          survives on the API as one_thing_to_watch for anything that still wants it. */}
      {(visibleAttention.length > 0 || silencedCount > 0) && (
        <section className="card" data-testid="home-attention">
          <h2>Needs your attention</h2>
          {visibleAttention.length === 0 && (
            <p className="muted small">
              Nothing outstanding. {silencedCount} {silencedCount === 1 ? "item is" : "items are"} silenced.
            </p>
          )}
          <ul className="card-list small">
            {visibleAttention.map((a) => (
              <li key={a.key} data-testid={`home-attention-${a.key}`}>
                <span
                  className={
                    a.severity === "BLOCKING"
                      ? "help-tag help-tag-warn"
                      : a.severity === "DEGRADED"
                        ? "help-tag help-tag-warn"
                        : "help-tag help-tag-muted"
                  }
                >
                  {a.severity === "BLOCKING" ? "Blocked" : a.severity === "DEGRADED" ? "Degraded" : "Setup"}
                </span>{" "}
                <strong>{a.headline}</strong> {a.action}{" "}
                <button type="button" className="link-button" onClick={() => onNavigate(a.link)}>
                  Open
                </button>{" "}
                {/* Two different things, and the labels say which is which. "I know" leaves it on
                    the record as seen and still true; "Stop telling me" is the one that means the
                    alert was not useful. Either way it comes back if the situation changes, and
                    both lapse after a week — see the attention service for why. */}
                <button
                  type="button"
                  className="link-button"
                  data-testid={`home-attention-ack-${a.key}`}
                  onClick={() => void silence(a.key, a.headline, "ACKNOWLEDGED")}
                >
                  I know
                </button>{" "}
                <button
                  type="button"
                  className="link-button"
                  data-testid={`home-attention-dismiss-${a.key}`}
                  onClick={() => void silence(a.key, a.headline, "DISMISSED")}
                >
                  Stop telling me
                </button>
              </li>
            ))}
          </ul>
          {silencedCount > 0 && (
            <p className="muted small">
              {silencedCount} silenced for up to a week.{" "}
              <button
                type="button"
                className="link-button"
                data-testid="home-attention-unsilence"
                onClick={() => void unsilence()}
              >
                Bring them back
              </button>
            </p>
          )}
        </section>
      )}

      {/* The brief, at the top, because it is the thing that ARRIVED. It used to render on the
          Sources page while a list of ranked sweep items sat here called "Daily Brief" — two
          things named almost identically and neither where you would look. */}
      {/* Above the brief, because it is the reason the brief cannot yet see your day. Collapses to
          a single line once both are connected. */}

      <section className="card brief-delivery" data-testid="home-brief-delivery">
        <header className="brief-byline">
          <Face name={chiefOfStaff.name} role={chiefOfStaff.role} size={40} />
          <div className="brief-byline-who">
            {/* SAYS WHAT IS TRUE, not what usually is. This read "Wren delivered your morning
                briefing" unconditionally, directly above a panel saying "No brief for today yet"
                — so the page claimed a delivery and then denied it in the next breath. Home does
                not hold the brief (the panel below fetches it), so the line is written to be
                honest either way: whose briefing it is, not a claim that it arrived. */}
            <div className="brief-byline-line">
              <strong>{chiefOfStaff.name}</strong> — your morning briefing
            </div>
            <div className="muted small">
              {chiefOfStaff.role} ·{" "}
              {new Date(data.generated_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
            </div>
          </div>
        </header>
        <DailyBriefPanel compact />
      </section>

      {/* Waiting on you: lifted out of the grid because it is the only group where something is
          blocked on the reader rather than the other way round. A decision waiting three days
          should not be one card among twelve. */}
      {waiting && (
        <section data-testid="home-waiting">
          <div className="home-section-head">
            <h2>Waiting on you</h2>
            <span className="count-pill">{waiting.count}</span>
          </div>
          {waiting.items.length === 0 ? (
            <p className="muted small" data-testid="home-waiting-empty">
              {deliveryFor("approvals")?.whenEmpty ?? "Nothing is blocked on you."}
            </p>
          ) : (
            <ul className="card-list waiting-list">
              {waiting.items.slice(0, 5).map((item, i) => (
                <li key={String(item.id ?? i)}>
                  <span>{summarize("approvals", item)}</span>
                  <button
                    type="button"
                    className="btn-strong"
                    data-testid={`home-waiting-open-${i}`}
                    onClick={() => onNavigate("approvals")}
                  >
                    Decide
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/*
        WRITTEN THINGS FIRST. The modules below are areas of the firm with something in them — a
        count, a list, a signal. A deliverable is different in kind: somebody sat down and produced
        a document for you, and it should not queue behind a panel reporting that there are three
        portfolio alerts.

        Filed and exportable from here, so the answer to "can I send this to Scooter" is on the page
        you were already reading rather than three clicks into an archive.
      */}
      <section data-testid="home-deliverables">
        <div className="home-section-head">
          <h2>Prepared for you</h2>
          <span className="muted small">briefs, reviews and research — yours to keep</span>
        </div>
        <DeliverableList
          limit={4}
          onNavigate={onNavigate}
          emptyNote="Nothing has been prepared for you yet. Research packets, briefs and the weekly review all arrive here once somebody produces one."
        />
      </section>

      <section data-testid="home-deliveries">
        <div className="home-section-head">
          <h2>From your team</h2>
          <span className="muted small">
            {deliveries.filter((m) => m.items.length > 0).length} of {deliveries.length} have something for you
          </span>
        </div>
        {/* Anyone with something to say first; everyone else stays on the page, quieter. Silence
            from a named colleague is information — an absent card is just a gap. */}
        <ul className="delivery-list">
          {[...deliveries]
            .sort((a, b) => (b.items.length > 0 ? 1 : 0) - (a.items.length > 0 ? 1 : 0))
            .map((m) => (
              <DeliveryCard key={m.key} module={m} onNavigate={onNavigate} />
            ))}
        </ul>
      </section>

      <section className="card" data-testid="home-questions">
        <h3>The ten questions this surface answers</h3>
        <ul className="question-list">
          {data.questions.map((q) => (
            <li key={q.question} data-testid={`home-question-${q.module ?? "none"}`}>
              {q.question}{" "}
              {q.module ? (
                <code>{MODULE_LABELS[q.module] ?? q.module}</code>
              ) : (
                <span className="muted small">no module enabled for this yet</span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* The older `/api/briefings/current` card used to render here as a SECOND brief, beneath a
          module also called "Daily Brief". Three surfaces for one idea. The richer report — the one
          with sections and real citations — is now at the top of this page, and this block is gone
          rather than left as a quieter duplicate. The endpoint still exists and Sources still uses it. */}

      <ModuleSettings home={data} onSaved={home.reload} />
      <PersonalIntelligencePanel />
    </section>
  );
}
