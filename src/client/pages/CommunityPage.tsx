import { useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";
import { typeWord } from "@shared/community/typeWords";

/**
 * Community OS — the firm's read on the community as a population (P33, canon §14, §12A.4).
 *
 * NOT a membership roster. Network OS owns who is a member (§12A.2); this page owns the read on
 * them — the shape of the population. The distinction is stated on screen because the first
 * version of this page got it wrong, and a page that looks like a CRM invites people to treat it
 * as one.
 *
 * ONE ROSTER, 27 Sep 2026. Until then this page also carried an "Add or update a member" form, a
 * "Members" list and a "Who is in the room" mix, all of which read and wrote the LOCAL `com_member`
 * table — a second roster that Network OS never saw, kept beside a header that said a local roster
 * was wrong. They are gone. Someone new is CAPTURED (the Capture tab), and West Peek OS proposes
 * them to Network OS; nothing on this page adds a person anywhere. The `com_member` table and its
 * routes stay for the gathering and council code that reads them; this page no longer calls them.
 *
 * Introductions used to render here as an embedded section. It was retired from this page on
 * 27 Sep 2026 while the operator decides whether introductions belong in Network OS natively; the
 * page, matcher and routes are untouched and unlisted.
 *
 * Not Relationship OS either: that reasons about one relationship and its next move. This reasons
 * about the population.
 */

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
              <div key={s.key} className="cohort cohort-metered" data-testid={`cohort-${s.key}`}>
                <span className="cohort-count">{s.count.toLocaleString()}</span>
                <span className="cohort-label">{typeWord(s.key)}</span>
                {/* The share, drawn as well as stated. A 0.9% slice is a sliver, and it is drawn as a
                    sliver — the floor keeps it visible, not honest-looking-bigger. */}
                <span className="cohort-meter" aria-hidden="true">
                  <span className="cohort-meter-fill" style={{ width: `${Math.max(1.5, s.pct)}%` }} />
                </span>
                <span className="cohort-pct">{s.pct}% of the community</span>
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

        A BAND WITH A BUTTON, not a grey notice. On 27 Sep 2026 this sat as the third block down
        in the same grey `.notice` every caution on the product wears, with the link buried
        mid-sentence, and the operator could not find it. The one accent marks it now, and the
        link is the only orange button on the page.

        THE SECOND LINE IS THE ONLY DOOR FOR A NEW PERSON. The member form that used to sit lower
        on this page wrote to a local table and told nobody; Capture proposes the person to
        Network OS, which is where they are meant to end up.
      */}
      <aside className="boundary-band" data-testid="community-network-os">
        <div className="boundary-band-copy">
          <p className="boundary-band-text">
            <strong>The people themselves live in Network OS.</strong> That is where they are added and
            edited; this page is West Peek's read on them and never the other way round. It is a
            separate sign-in, so it opens alongside this rather than replacing it.
          </p>
          <p className="boundary-band-text">
            Met someone new?{" "}
            <a className="link-button" href="#/capture" data-testid="community-capture-link">
              Capture them
            </a>{" "}
            and West Peek OS proposes them to Network OS.
          </p>
        </div>
        <a
          className="btn-primary"
          href="https://network.joinwestpeek.com"
          target="_blank"
          rel="noreferrer noopener"
          data-testid="community-network-os-link"
        >
          Open Network OS ↗
        </a>
      </aside>

      <PopulationPanel />

      <HowThisWorks
        title="Community"
        testId="community"
        what="The firm’s read on the community as a population — how many people it holds, what kinds of people they are, and how many of them have heard from the firm lately."
        when="Before convening a room, planning programming, or asking whether the community is warm enough to lean on."
        operatorDoes={[
          "Read the shape and the warmth.",
          "Open Network OS to look at, add or edit the people themselves.",
          "Capture someone new — West Peek OS proposes them to Network OS.",
        ]}
        aiDoes={["Nothing on this page. The community is read from Network OS on its own schedule."]}
        requiresOperator={["Contacting a member is an external effect and needs an approval card."]}
        next="Network OS owns who is a member; this layer reads them. Relationship OS handles one relationship at a time — the warm path, the next move. Community OS reads the population. Cohort analytics and programming come later."
        blocked={[
          "Nothing here adds, edits or removes a person. That happens in Network OS, or through Capture, which proposes them there.",
          "An empty shape means the sync has not landed, and the panel says so — it does not mean the community is empty.",
        ]}
      />
    </div>
  );
}
