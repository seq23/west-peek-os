import { useEffect, useState } from "react";
import { api, useApi, type MeResponse } from "../lib/api";
import { operatorAttention, type JobHealth } from "@shared/setup/operatorAttention";
import { attentionSignature } from "@shared/setup/attentionKey";
import { deliveryFor, greetingFor, roleFor } from "@shared/home/deliveries";
import { answerLine as answerLineFor, secondLine as secondLineFor } from "@shared/home/answerLine";
import { DeliverableList } from "./DeliverableList";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";
import { DailyBriefPanel } from "./DailyBriefPanel";
import { readBriefCollapsed, writeBriefCollapsed } from "../lib/briefCollapse";
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
function DeliveryCard({ module, onNavigate, onOpened }: { module: HomeModule; onNavigate: (key: string) => void; onOpened: (key: string) => Promise<void> }) {
  const delivery = deliveryFor(module.key);
  const role = delivery ? roleFor(delivery.by) : null;
  const empty = module.items.length === 0;
  const fresh = hasNew(module);
  /*
   * THREE STATES, NOT TWO. Empty: the colleague has nothing. Quiet: they have things, you have seen
   * them, nothing has arrived since — greyed, and it says since when. New: something arrived after
   * you last looked. Only the third is "has something for you"; the other two used to look the same
   * as it did, which is why Open never quieted a module (operator, 15 Sep 2026).
   */
  const quiet = !empty && !fresh;

  return (
    <li
      className={empty || quiet ? "delivery delivery-quiet" : "delivery"}
      data-testid={`home-module-${module.key}`}
      data-fresh={fresh ? "new" : quiet ? "quiet" : "empty"}
    >
      {delivery && <Face name={delivery.by} role={role ?? ""} size={fresh ? 36 : 28} />}

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
        ) : quiet ? (
          <div className="muted small" data-testid={`home-module-quiet-${module.key}`}>
            nothing new since {module.seen_at ? sinceWhen(module.seen_at) : "you last looked"}
            {" · "}
            <button type="button" className="link-button" data-testid={`home-open-${module.key}`} onClick={() => void onOpened(module.key).then(() => onNavigate(module.link))}>
              Open anyway
            </button>
          </div>
        ) : (
          <>
            <div className="delivery-headline">
              {delivery?.headline ?? module.title}
              {typeof module.new_count === "number" && module.seen_at && (
                <span className="muted small" data-testid={`home-module-new-${module.key}`}>
                  {" "}· {module.new_count} new since {sinceWhen(module.seen_at)}
                </span>
              )}
            </div>
            <ul className="module-items">
              {module.items.slice(0, 2).map((item, i) => (
                <li key={String(item.id ?? i)}>{summarize(module.key, item)}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      {fresh && (
        <button type="button" data-testid={`home-open-${module.key}`} onClick={() => void onOpened(module.key).then(() => onNavigate(module.link))}>
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
        <h4>Private layer</h4>
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
        <h4>Home layout</h4>
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
  // Read once, for THIS viewer. Two partners share the application and, on a shared laptop, the
  // store; the id in the key is what stops one of them folding the other's brief away.
  const [briefCollapsed, setBriefCollapsed] = useState(() => readBriefCollapsed(me.id));
  /* EVERY HOOK ABOVE EVERY EARLY RETURN — see the note below; these two are here for that reason
     and not because they belong at the top of the component. */
  const [showQuiet, setShowQuiet] = useState(false);
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const home = useApi<HomeResponse>("/api/mp-home");
  // §8 — the four operator questions Home's modules do not answer: what is blocked, is scheduled
  // work healthy, is AI failing, is setup incomplete. Derived from live endpoints only.
  const jobs = useApi<{ jobs: JobHealth[] }>("/api/jobs");
  const providers = useApi<{ providers: Array<{ enabled: number; kill_switched: number }> }>("/api/ai/providers");
  /*
   * EVERY HOOK ABOVE EVERY EARLY RETURN. This one was written next to the code that uses it, which
   * sits below `if (home.loading) return …` — so the first render ran three hooks and the second
   * ran four, React threw "rendered more hooks than during the previous render", and Home went
   * blank. Typecheck cannot see it; only opening the page can.
   *
   * Silencing is matched on the item's key AND the words it was showing, so an item whose headline
   * changes comes back — see the attention service. Nothing is filtered while this is still
   * loading: hiding an alert on the strength of data you do not have yet is the wrong way round.
   */
  const silenced = useApi<{ silenced: Array<{ item_key: string; signature: string }> }>("/api/attention/silenced");

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
  const waitingItems = waiting?.items ?? [];
  /* NEW gets a card; everyone else gets a name in the roll. The three-way sort this replaced —
     new, then quiet, then empty — put nine cards on the page to report silence nine times. */
  const freshDeliveries = deliveries.filter(hasNew);
  const quietDeliveries = deliveries.filter((m) => !hasNew(m));
  // Open leaves the mark BEFORE navigating, so the module is quiet the next time Home is read.
  const markOpened = async (key: string): Promise<void> => {
    await api(`/api/mp-home/modules/${encodeURIComponent(key)}/seen`, { method: "POST", body: {} });
  };

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
    ...(typeof home.data?.unrouted_emails === "number" ? { unroutedEmails: home.data.unrouted_emails } : {}),
    ...(providers.data
      ? {
          aiProviderConfigured: providers.data.providers.some(
            (x) => x.enabled === 1 && x.kill_switched === 0,
          ),
        }
      : {}),
  });

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

  /*
   * RANK 0. Everything below is already on this page somewhere; the change is that it is now said
   * ONCE, at the top, in the largest type, instead of five times at five weights. The sentences
   * themselves are in `@shared/home/answerLine` so the grammar is testable.
   */
  const freshCount = freshDeliveries.length + (waiting && hasNew(waiting) ? 1 : 0);
  const needsHer = waitingItems.length + visibleAttention.length;
  const counts = {
    decisions: waitingItems.length,
    blockers: visibleAttention.length,
    firstBlocker: visibleAttention[0]?.headline ?? null,
    fresh: freshCount,
    quiet: quietDeliveries.length,
  };
  const answerLine = answerLineFor(counts);
  const secondLine = secondLineFor(counts);

  /* The roll names PEOPLE, because that is what makes silence answerable — you can go and ask
     Winter why there is nothing. A module with no colleague behind it falls back to its own
     title rather than being dropped from the count. */
  const quietNames = quietDeliveries
    .map((m) => deliveryFor(m.key)?.by ?? m.title)
    .join(", ")
    .replace(/, ([^,]*)$/, " and $1");

  return (
    <section data-testid="home-page">
      {/* SETUP SITS ABOVE THE ANSWER, folded to one line. It was a full screen of settings between
          the partner and the briefing they came for, every morning — so it now states what is on
          and what is not, and opens only when asked. Above rather than below because a status strip
          is a header, not an interruption: read it or ignore it before the day starts.

          Its height is RESERVED (see `.connect-strip` in styles.css): `/api/me/connections` answers
          at roughly 2.5s and the strip then inserts at the very top of Home, pushing the whole page
          down. That was Home's one measurable layout shift. */}
      <ConnectPanel me={me} />

      {/* ══ RANK 0 · THE ANSWER LINE ═══════════════════════════════════════════════════════════
          The largest type on the page states the page's ANSWER, not a greeting. "What needs me
          right now" was previously spelled out across five separate places at five different
          weights; a partner on her second hundred visit reads one line and knows.

          The greeting and the date are the eyebrow ABOVE it, in one column. They used to be the
          headline, with the actual status floated to the far right in grey — the two halves of one
          sentence, as far apart as the layout allowed. */}
      <header className="home-masthead" data-testid="home-masthead">
        <p className="home-date" data-testid="home-greeting">
          {new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
          {" · "}
          {greetingFor(new Date().getHours())}, {me.fullName.split(" ")[0]}
        </p>

        {/* h2, not h1: the shell already sets the page title, and a second h1 competed with the
            wordmark. The stylesheet's heading scale targets THIS tag — it targeted `h1` until
            17 Sep 2026 and therefore targeted nothing, which is why the headings on this page had
            no weight. `scripts/validate/heading-scale-applies.mjs` now fails the build if a
            heading-scale selector stops matching what the page emits. */}
        <h2 data-testid="home-answer">{answerLine}</h2>

        <p className="home-answer-second" data-testid="home-team-count">{secondLine}</p>

        {/* ASK, DEMOTED FROM THE ONLY TINTED CARD ON THE PAGE to one docked affordance under the
            answer. Operator direction (17 Aug 2026) was that Ask must be findable on Home, and it
            still is — but a tint is the strongest signal this page has, and spending it on an
            invitation meant the decision actually waiting on her was the plainest thing on screen.
            The tint is now spent on a decision and nowhere else. */}
        <div className="ask-dock" data-testid="home-ask">
          <button type="button" className="ask-open" data-testid="home-ask-open" onClick={() => onNavigate("intent")}>
            <span className="ask-label">Ask for anything</span>
          </button>
          <span className="ask-note">
            Describe what you need in your own words — “what changed in the portfolio this week?” ·
            “prep me for the Acme call”. Ask shows you the plan first and does nothing consequential
            without your approval.
          </span>
        </div>
      </header>

      {/* ══ BAND ONE · WAITING ON YOU ══════════════════════════════════════════════════════════
          Decisions blocked on her signature, then anything blocking the firm. Two separate
          sections until now — "Waiting on you (0)" and "Needs your attention" — which meant the
          page could carry two headed, near-identical blocks between her and the thing she came for.

          IT DOES NOT RENDER WHEN IT IS EMPTY. A full section that exists to say "nothing" is the
          single worst use of the top of this page; the answer line above has already said so, in
          the one slot she actually reads. */}
      {(waitingItems.length > 0 || visibleAttention.length > 0 || silencedCount > 0) && (
        <section className="home-band" data-testid="home-waiting">
          <div className="home-band-head">
            <h3>Waiting on you</h3>
            {needsHer > 0 && <span className="count-pill">{needsHer}</span>}
            <span className="home-band-when">
              {waitingItems.length === 0
                ? "no decision is blocked on your signature"
                : waitingItems.length === 1
                  ? "one decision is blocked on your signature"
                  : `${waitingItems.length} decisions are blocked on your signature`}
            </span>
          </div>

          {waitingItems.length > 0 && (
            <ul className="card-list waiting-list">
              {waitingItems.slice(0, 5).map((item, i) => (
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

          {/* §8 — what is blocked: a dead-lettered job or an unconfigured provider makes everything
              below it unreliable. It keeps its own semantic colour; orange never carries safety
              meaning on this page. */}
          <div data-testid="home-attention">
            {visibleAttention.length === 0 && silencedCount > 0 && (
              <p className="muted small">
                Nothing outstanding. {silencedCount} {silencedCount === 1 ? "item is" : "items are"} silenced.
              </p>
            )}
            {visibleAttention.length > 0 && (
              <ul className="card-list small blocker-list">
                {visibleAttention.map((a) => (
                  <li key={a.key} className="blocker" data-testid={`home-attention-${a.key}`}>
                    <span
                      className={
                        a.severity === "BLOCKING" || a.severity === "DEGRADED"
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
                    {/* TWO DIFFERENT ACTS, and until 21 Aug 2026 they were the same one: both wrote
                        the same row and both lapsed after a week, which the operator noticed and
                        asked to be fixed. "I know" means seen, still true, living with it — quiet
                        for a week. "Stop telling me" is permanent. Both are keyed to the exact
                        wording, so the same problem described differently is said again. */}
                    <button
                      type="button"
                      className="link-button"
                      data-testid={`home-attention-ack-${a.key}`}
                      title="Seen, still true. Quiet for a week."
                      onClick={() => void silence(a.key, a.headline, "ACKNOWLEDGED")}
                    >
                      I know
                    </button>{" "}
                    <button
                      type="button"
                      className="link-button"
                      data-testid={`home-attention-dismiss-${a.key}`}
                      title="Permanent. This exact item will not come back."
                      onClick={() => void silence(a.key, a.headline, "DISMISSED")}
                    >
                      Stop telling me, for good
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {silencedCount > 0 && (
              <p className="muted small">
                {silencedCount} silenced — acknowledged ones return after a week, dismissed ones do not.{" "}
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
          </div>
        </section>
      )}

      {/* ══ BAND TWO · SINCE YOU LAST LOOKED ═══════════════════════════════════════════════════
        ONE SECTION, NOT THREE. Operator, 22 Aug 2026: "why is prepared for you and from your team
        different?" The distinction WAS real and it was the wrong cut — two headings splitting one
        question, *what is new for me*, along an implementation seam rather than anything a partner
        would think. Ordered by how finished the thing is: the brief that arrived this morning, then
        everything else produced for you, then the colleagues who have something but no document.
      */}
      <section className="home-band" data-testid="home-deliverables">
        <div className="home-band-head">
          <h3>Since you last looked</h3>
          {freshCount > 0 && <span className="count-pill">{freshCount}</span>}
          <span className="home-band-when" data-testid="home-deliveries-count">
            {freshCount === 0
              ? "nothing new since you last looked"
              : `${freshCount} ${freshCount === 1 ? "has" : "have"} something new`}
          </span>
        </div>

        <section className="card brief-delivery" data-testid="home-brief-delivery">
          <header className="brief-byline">
            <Face name={chiefOfStaff.name} role={chiefOfStaff.role} size={40} />
            <div className="brief-byline-who">
              {/* SAYS WHAT IS TRUE, not what usually is. Home does not hold the brief (the panel
                  below fetches it), so the line is written to be honest either way: whose briefing
                  it is, not a claim that it arrived. */}
              <div className="brief-byline-line">
                <strong>{chiefOfStaff.name}</strong> — your morning briefing
              </div>
              <div className="muted small">
                {chiefOfStaff.role} ·{" "}
                {new Date(data.generated_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
              </div>
            </div>
          </header>
          {/*
            A SUMMARY CARD *AND* A COLLAPSE, which are two different controls and both are hers.

            `compact` is the summary: the one-minute version — the numbered summary, the traffic
            lights and the market read — with the remaining ten sections behind "Read the full
            report". The designer argued that should be the whole answer and the collapse should
            go; she overruled that on 18 Sep 2026 ("just make the exec brief collapsable and run
            it"), so BOTH stand. Short by default, foldable away entirely, depth on request.

            The collapse is the mechanism that shipped in PR #92 and is not duplicated here: the
            state is owned by Home and remembered per viewer in `client/lib/briefCollapse.ts`,
            keyed on `firm_user.id`, because two partners share this application and, on a shared
            laptop, the store. A collapsed panel still says the date and whether today's brief
            arrived — hiding whether the thing ran is worse than not showing it at all.
          */}
          <DailyBriefPanel
            compact
            collapsed={briefCollapsed}
            onToggleCollapsed={(next) => {
              setBriefCollapsed(next);
              writeBriefCollapsed(me.id, next);
            }}
          />
        </section>

        <DeliverableList
          limit={4}
          onNavigate={onNavigate}
          // "Prepared for you" means for YOU. It used to list both partners' briefs, and because
          // the other partner's is often generated later in the day it sat on top, signed by their
          // chief of staff — under a heading promising these were yours.
          mine
          meId={me.id}
          emptyNote="Nothing else has been prepared for you yet. Research packets and the weekly review arrive here once somebody produces one."
        />

        {/* Anyone with something NEW gets a card. Nobody else does. */}
        {freshDeliveries.length > 0 && (
          <ul className="delivery-list">
            {freshDeliveries.map((m) => (
              <DeliveryCard key={m.key} module={m} onNavigate={onNavigate} onOpened={markOpened} />
            ))}
          </ul>
        )}

        {/* NINE QUIET COLLEAGUES ARE ONE LINE, NOT NINE CARDS. Silence from a named colleague is
            still information and is still reported — it is just no longer the largest visual mass
            on a page whose job is to show what needs her. Each of them is one click away. */}
        {quietDeliveries.length > 0 && (
          <>
            <p className="quiet-roll" data-testid="home-quiet-roll">
              <span>
                {quietNames} — <b>nothing new since you last looked</b>.
              </span>
              <button
                type="button"
                className="link-button"
                data-testid="home-quiet-roll-toggle"
                aria-expanded={showQuiet}
                onClick={() => setShowQuiet((q) => !q)}
              >
                {showQuiet ? "Hide them" : "Show each"}
              </button>
            </p>
            {showQuiet && (
              <ul className="delivery-list">
                {quietDeliveries.map((m) => (
                  <DeliveryCard key={m.key} module={m} onNavigate={onNavigate} onOpened={markOpened} />
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      {/* ══ BAND THREE · THE REST ══════════════════════════════════════════════════════════════
          Configuration and reference. Nothing here changes on its own, and nothing here is read
          more than once in two hundred visits — so it is a shelf of closed drawers rather than
          three more open cards competing with the brief. */}
      <section className="home-band" data-testid="home-rest">
        <div className="home-band-head">
          <h3>The rest</h3>
          <span className="home-band-when">configuration and reference — nothing here changes on its own</span>
        </div>

        <section className="card" data-testid="home-questions">
          <header className="module-card-head">
            <h4>What this page answers</h4>
            <button
              type="button"
              className="link-button"
              data-testid="home-questions-toggle"
              aria-expanded={questionsOpen}
              onClick={() => setQuestionsOpen((o) => !o)}
            >
              {questionsOpen ? "Hide" : "Open"}
            </button>
          </header>
          <p className="muted small">the ten questions, and which module answers each</p>
          {questionsOpen && (
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
          )}
        </section>

        <ModuleSettings home={data} onSaved={home.reload} />
        <PersonalIntelligencePanel />
      </section>
    </section>
  );
}
