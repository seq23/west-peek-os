import { useState } from "react";
import { api, useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { IntroductionsPage } from "./IntroductionsPage";

/**
 * Community OS — the firm's read on the community as a population (P33, canon §14, §12A.4).
 *
 * NOT a membership roster. Network OS owns who is a member (§12A.2); this page owns segment,
 * engagement and signal — the interpretation. The distinction is stated on screen because the
 * first version of this page got it wrong, and a page that looks like a CRM invites people to
 * treat it as one.
 *
 * Not Relationship OS either: that reasons about one relationship and its next move. This reasons
 * about the population.
 */

interface MemberRow {
  id: string;
  display_name: string;
  member_type: string;
  status: string;
  joined_at: string | null;
  notes: string | null;
  segment: string;
  engagement: string;
  membership_source: string;
}

const TYPES = ["MEMBER", "FOUNDER", "OPERATOR", "INVESTOR", "ALUMNI"] as const;
const STATUSES = ["PROSPECT", "ACTIVE", "LAPSED", "REMOVED"] as const;
const SEGMENTS = ["UNSEGMENTED", "CORE", "CONTRIBUTOR", "AMBASSADOR", "SCOUT", "LAPSING", "OBSERVER"] as const;
const ENGAGEMENT = ["UNKNOWN", "HIGH", "STEADY", "FADING", "DORMANT"] as const;

/**
 * The kinds of member, in the order a partner would ask about them.
 *
 * Mirrors the member_type enum the API accepts. Listed here rather than derived from the data so a
 * kind with nobody in it still shows as zero — "we have no operators" is a finding, and a chart
 * that silently omits empty categories cannot report it.
 */
const MEMBER_KINDS = [
  { key: "FOUNDER", label: "Founders" },
  { key: "OPERATOR", label: "Operators" },
  { key: "INVESTOR", label: "Investors" },
  { key: "ALUMNI", label: "Alumni" },
  { key: "MEMBER", label: "Members" },
] as const;


interface PopulationSlice {
  key: string;
  count: number;
  pct: number;
}

interface Population {
  total: number;
  loading: { done: number; total: number } | null;
  by_type: PopulationSlice[];
  deal_flow: PopulationSlice[];
  touch_recency: PopulationSlice[];
  firm_has_a_view_on: number;
  source: { last_status: string; last_sync_at: string | null; failure_reason: string | null };
}

/** Plain words for a machine's vocabulary. `service_provider` is not a category anybody says out loud. */
const TYPE_WORDS: Record<string, string> = {
  investor: "Investors",
  founder: "Founders",
  operator: "Operators",
  lawyer: "Lawyers",
  service_provider: "Service providers",
  media: "Media",
  general: "General",
  unknown: "Not categorised",
};

const RECENCY_WORDS: Record<string, string> = {
  recent: "heard from us in the last 90 days",
  fading: "not in 3–12 months",
  cold: "not in over a year",
  never: "never recorded a touch",
};

/**
 * What the community IS — the birds-eye view.
 *
 * Operator, on this tab's purpose: "introduction and algorithmic matching and a birds eye view of
 * what our community is like." This is the third of those, and it is deliberately the first thing
 * on the page: introductions are what you DO, and this is what you are doing it to.
 *
 * IT IS A SHAPE, NOT A ROSTER. Network OS owns the five thousand names; mirroring them here would
 * be a second database that drifts and a list nobody scrolls. The categories are Network OS's own
 * `person_type`, read rather than re-invented, so the two systems can never disagree about what a
 * founder is.
 */
function PopulationPanel(): JSX.Element {
  const pop = useApi<Population>("/api/community/population");
  const p = pop.data;

  if (pop.loading && !p) return <p className="state-message">Reading the community…</p>;
  if (!p) return <p className="state-message">The community shape could not be read just now.</p>;

  const loadingNow = p.loading;
  const pctLoaded = loadingNow && loadingNow.total > 0 ? Math.round((loadingNow.done / loadingNow.total) * 100) : 0;

  return (
    <section className="card" data-testid="community-population">
      <h3>What the community looks like</h3>

      {/* A LOAD IN PROGRESS IS SAID PLAINLY, because a number that grows for hours with no
          explanation reads as a bug. Operator: "let us know when its done give us a progress bar." */}
      {loadingNow && (
        <div data-testid="community-load-progress">
          <p className="small">
            Reading your community from Network OS — <strong>{loadingNow.done.toLocaleString()}</strong> of{" "}
            {loadingNow.total.toLocaleString()} so far. It carries on by itself; nothing needs to stay open.
          </p>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuenow={pctLoaded}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Community load progress"
          >
            <div className="progress-fill" style={{ width: `${pctLoaded}%` }} />
          </div>
        </div>
      )}

      {p.total === 0 && !loadingNow && (
        <p className="state-empty" data-testid="community-population-empty">
          {p.source.last_status === "OK"
            ? "Network OS answered and had nobody to give. Once the community is loaded there, this fills in on its own."
            : `Network OS could not be read — ${p.source.failure_reason ?? p.source.last_status}. This is empty because the sync did not land, not because the community is.`}
        </p>
      )}

      {p.total > 0 && (
        <>
          <p className="small">
            <strong>{p.total.toLocaleString()}</strong> people. The firm has formed a view on{" "}
            {p.firm_has_a_view_on.toLocaleString()} of them.
          </p>

          <div className="cohort-grid" data-testid="community-cohorts">
            {p.by_type.map((s) => (
              <div key={s.key} className="cohort" data-testid={`cohort-${s.key}`}>
                <span className="cohort-count">{s.count.toLocaleString()}</span>
                <span className="cohort-label">{TYPE_WORDS[s.key] ?? s.key}</span>
                <span className="cohort-pct">{s.pct}%</span>
              </div>
            ))}
          </div>

          {/* The number that actually changes a decision. A community is not a headcount — it is
              how many of those people have heard from the firm lately. */}
          <h4>How warm it is</h4>
          <ul className="card-list small" data-testid="community-recency">
            {p.touch_recency.map((s) => (
              <li key={s.key}>
                <strong>{s.count.toLocaleString()}</strong> {RECENCY_WORDS[s.key] ?? s.key} · {s.pct}%
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="muted small">
        Network OS owns who these people are. This reads the shape of them and never keeps a copy.
      </p>
    </section>
  );
}

export function CommunityPage(): JSX.Element {
  const state = useApi<{ members: MemberRow[]; counts: Record<string, number> }>("/api/community/members");
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("MEMBER");
  const [status, setStatus] = useState<string>("ACTIVE");
  const [segment, setSegment] = useState<string>("UNSEGMENTED");
  const [engagement, setEngagement] = useState<string>("UNKNOWN");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const allMembers = state.data?.members ?? [];
  const members = allMembers;
  const listed = typeFilter ? allMembers.filter((m) => m.member_type === typeFilter) : allMembers;
  const counts = state.data?.counts ?? {};

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setMessage(null);
    const res = await api<{ error?: string; detail?: string }>("/api/community/members", {
      method: "POST",
      body: { display_name: name.trim(), member_type: type, status, segment, engagement },
    });
    if (res.status !== 201) setMessage(res.data?.detail ?? res.data?.error ?? `Could not save (HTTP ${res.status}).`);
    else setName("");
    setBusy(false);
    state.reload();
  }

  return (
    <div className="page" data-testid="community-page">
      {/* The page heading is already "Community" twice above this — once as the surface title and
          once opening the purpose line. A third was noise, and the sentence it introduced says the
          same thing the purpose line already said. */}

      {/*
        WHERE THE COMMUNITY ACTUALLY LIVES, said before anything on this page is read.
        
        Operator, 23 Aug 2026: a reader who wants a closer look has to open Network OS in another
        tab. That is not a limitation to apologise for — it is the boundary this system is built on.
        Network OS OWNS who is a member; everything here is West Peek's read on them. Saying so at
        the top stops this page being mistaken for the record, which is the mistake that would end
        with somebody editing a contact in the wrong system.
      */}
      <p className="notice" data-testid="community-network-os">
        The people themselves live in <strong>Network OS</strong>, which is where they are added and
        edited. This page is West Peek's read on them and never the other way round.{" "}
        <a href="https://network.joinwestpeek.com" target="_blank" rel="noreferrer noopener" data-testid="community-network-os-link">
          Open Network OS in another tab
        </a>{" "}
        for a closer look at anyone here — it is a separate sign-in, so it opens alongside this
        rather than replacing it.
      </p>

      <PopulationPanel />

      {/* INTRODUCTIONS LIVES HERE NOW, and first, because it is the only thing on this page anybody
          has to ACT on. It had a tab of its own next to Approvals and Notifications, which put a
          surface that is empty most months — deliberately, because the matcher is tuned to be rare
          — alongside the things that always have something waiting. Community is who the members
          are; introductions is what the firm does about them. One subject, one page. */}
      {/* EMBEDDED, so it does not bring its own "how this works" panel. Introductions moved onto
          this page and kept rendering its own, which is why Community had two — one explaining
          the page and one explaining a section of it, stacked. The prop exists for exactly this. */}
      <IntroductionsPage embedded />

      <div className="home-section-head behind-the-brief">
        <h3>The members themselves</h3>
        <span className="muted small">who they are, and how the firm reads them</span>
      </div>

      <p className="notice" data-testid="community-scope">
        Scaffolding, and an <strong>interpretation layer</strong>: Network OS owns who is a member.
        What lives here is the firm's read on them — segment, engagement, and signal. Cohort
        analytics, programming and automated signal detection are not built yet.
      </p>

      <form className="card" onSubmit={save} data-testid="community-form">
        <h3>Add or update a member</h3>
        <div className="form-row">
          <label>
            Name{" "}
            <input data-testid="community-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </label>
          <label>
            Type{" "}
            <select data-testid="community-type" value={type} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => <option key={t} value={t}>{t.toLowerCase()}</option>)}
            </select>
          </label>
          <label>
            Status{" "}
            <select data-testid="community-status" value={status} onChange={(e) => setStatus(e.target.value)}>
              {STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            Segment{" "}
            <select data-testid="community-segment" value={segment} onChange={(e) => setSegment(e.target.value)}>
              {SEGMENTS.map((v) => <option key={v} value={v}>{v.toLowerCase()}</option>)}
            </select>
          </label>
          <label>
            Engagement{" "}
            <select data-testid="community-engagement" value={engagement} onChange={(e) => setEngagement(e.target.value)}>
              {ENGAGEMENT.map((v) => <option key={v} value={v}>{v.toLowerCase()}</option>)}
            </select>
          </label>
        </div>
        <button type="submit" className="btn-strong" disabled={busy} data-testid="community-save">
          {busy ? "Saving…" : "Save member"}
        </button>
        {message && <p className="notice" data-testid="community-message">{message}</p>}
      </form>

      <section className="card">
        <h3>
          Members{" "}
          <span className="muted small" data-testid="community-counts">
            {STATUSES.filter((s) => counts[s]).map((s) => `${counts[s]} ${s.toLowerCase()}`).join(" · ") || "none yet"}
          </span>
        </h3>
        {/* Narrowed by whichever kind is selected in the mix above — the chart is a control, not a
            picture, because seeing that a third of the room is operators is only useful if you can
            then look at them. */}
        {typeFilter && (
          <p className="muted small">
            Showing {listed.length} {typeFilter.toLowerCase()}
            {listed.length === 1 ? "" : "s"}.{" "}
            <button type="button" className="link-button" onClick={() => setTypeFilter(null)}>
              show everyone
            </button>
          </p>
        )}
        {listed.length === 0 ? (
          <p className="state-empty" data-testid="community-empty">
            {allMembers.length === 0
              ? "No members recorded yet."
              : `Nobody in the room is recorded as ${typeFilter?.toLowerCase()}.`}
          </p>
        ) : (
          <ul className="card-list small" data-testid="community-list">
            {listed.map((m) => (
              <li key={m.id} data-testid={`community-member-${m.id}`}>
                <span className={m.status === "ACTIVE" ? "help-tag help-tag-good" : "help-tag help-tag-muted"}>
                  {m.status.toLowerCase()}
                </span>{" "}
                <strong>{m.display_name}</strong>{" "}
                <span className="muted small">
                  {m.member_type.toLowerCase()} · {m.segment.toLowerCase()} · {m.engagement.toLowerCase()}
                  {m.membership_source === "LOCAL_UNRESOLVED" && " · not yet matched in Network OS"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* WHO THIS COMMUNITY ACTUALLY IS.
          The page listed members as rows and left the shape of the room to be worked out by
          counting. A community is a mix, and the mix is the thing you form a view about — whether
          it is mostly founders, whether the operators who make it useful are actually there.

          A bar per kind rather than a pie: the question is "how many of each, and which is
          biggest", which lengths answer at a glance and angles do not. Numbers are stated as well
          as drawn, so nothing depends on reading a bar, and each row is a filter — seeing that a
          third of the room is operators is only useful if you can then look at them. */}
      <section data-testid="community-mix">
        <div className="home-section-head">
          <h3>Who is in the room</h3>
          <span className="muted small">
            {members.length} member{members.length === 1 ? "" : "s"} the firm has recorded
          </span>
        </div>
        {members.length === 0 ? (
          <p className="state-empty">
            Nobody recorded yet. Add the people who actually turn up — the mix is what tells you
            whether a room is worth convening.
          </p>
        ) : (
          <ul className="mix-bars" data-testid="community-mix-bars">
            {MEMBER_KINDS.map((k) => {
              const n = members.filter((m) => m.member_type === k.key).length;
              const pct = members.length === 0 ? 0 : Math.round((n / members.length) * 100);
              return (
                <li key={k.key} data-testid={`mix-${k.key}`}>
                  <button
                    type="button"
                    className={typeFilter === k.key ? "mix-row is-on" : "mix-row"}
                    aria-pressed={typeFilter === k.key}
                    onClick={() => setTypeFilter(typeFilter === k.key ? null : k.key)}
                  >
                    <span className="mix-label">{k.label}</span>
                    <span className="mix-track">
                      <span className="mix-fill" style={{ width: `${pct}%` }} />
                    </span>
                    <span className="mix-count">
                      {n} <span className="muted">{pct}%</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <HowThisWorks
        title="Community"
        testId="community"
        what="The firm’s read on the community as a population — who sits in which segment, how engaged they are, and what that suggests for sourcing, portfolio support or programming."
        when="When someone joins, lapses, or changes what they are to the firm."
        operatorDoes={["Add a member.", "Change their type or status as the relationship changes."]}
        aiDoes={["Nothing yet. No AI employee reads or writes this roster."]}
        requiresOperator={["Everything on this page. Contacting a member is an external effect and needs an approval card."]}
        next="Network OS owns who is a member; this layer interprets them. Relationship OS handles one relationship at a time — the warm path, the next move. Community OS reads the population. Cohort analytics and programming come later."
        blocked={["Saving a member needs the community.manage action in your role.", "Names are unique per firm — saving an existing name updates that member rather than creating a second one."]}
      />
    </div>
  );
}
