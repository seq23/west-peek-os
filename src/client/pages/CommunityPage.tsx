import { useApi } from "../lib/api";
import { readableDate } from "../lib/dates";
import { HowThisWorks } from "./HowThisWorks";
import { AllocationRing } from "./AllocationRing";
import { typeWord } from "@shared/community/typeWords";
import { heroCounts, placedSlices, warmCount, warmthSlices } from "@shared/community/populationShape";

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
 * THE CHART PASS, 27 Sep 2026 ("hero row + two rings"). Seven tiles with a meter each showed the
 * categories side by side, and the biggest — 4,571 people Network OS has not placed — read as the
 * community's headline. Now four numbers say what matters, and two rings answer the two questions
 * a ring is good at: of the people the firm can place, what kinds; of everyone, how many are warm.
 * Both rings are the ONE ring (AllocationRing) — this page draws nothing itself.
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

interface NewestContact {
  external_id: string;
  full_name: string | null;
  company: string | null;
  city: string | null;
  person_type: string | null;
  relationship_owner: string | null;
  created_at: string | null;
}

/** Counts, never dollars: the ring's default writes money. */
const count = (n: number): string => n.toLocaleString();

/** One headline number: the count in the accent, the word, and one line on what it means. */
function HeroTile({ testid, value, label, meaning }: { testid: string; value: number; label: string; meaning: string }): JSX.Element {
  return (
    <div className="cohort cohort-hero" data-testid={testid}>
      <span className="cohort-count">{count(value)}</span>
      <span className="cohort-label">{label}</span>
      <span className="cohort-meaning">{meaning}</span>
    </div>
  );
}

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

  const hero = heroCounts(p);
  const placed = placedSlices(p.by_type);
  const warmth = warmthSlices(p.touch_recency);
  const warm = warmCount(p.touch_recency);

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
          {/* THE HERO ROW. Four numbers, each answering a question the firm actually asks of its
              community, in the order it asks them: how many, how many it can name a role for, how
              many are warm, how many are prospects. The counts are derived once in populationShape
              so a tile and a ring can never disagree. */}
          <div className="cohort-grid community-hero" data-testid="community-hero">
            <HeroTile testid="hero-people" value={hero.people} label="people" meaning="read from Network OS" />
            <HeroTile testid="hero-placeable" value={hero.placeable} label="the firm can place" meaning="have a role the firm can name" />
            <HeroTile testid="hero-warm" value={hero.warm} label="warm" meaning="heard from us in the last year" />
            <HeroTile
              testid="hero-prospects"
              value={hero.prospects}
              label="deal-flow prospects"
              meaning={`${count(hero.notAsked)} not yet asked`}
            />
          </div>

          {/* TWO RINGS, side by side, both hosted on the one ring. A ring reads part-of-a-whole,
              which is exactly the two questions here; magnitudes between the rings are not compared,
              which is why the tech-adjacent thousands sit in a sentence and not a slice. */}
          <div className="community-rings">
            <section className="ring-host" data-testid="community-cohorts">
              <div className="home-section-head">
                <h4>Who the firm can place</h4>
              </div>
              <AllocationRing
                slices={placed.slices}
                total={placed.placed}
                caption="placed"
                testid="community-placed"
                format={count}
                ariaLabel={`${count(placed.placed)} people the firm can place, by kind`}
              />
              {/* THE HONEST LINE. Everyone the ring leaves out is said here, in numbers, so the ring
                  cannot be read as "the whole community". The word is Network OS's own, humanised. */}
              {placed.unplaced
                .filter((s) => s.count > 0)
                .map((s) => (
                  <p key={s.key} className="tech-adjacent-line" data-testid={`community-unplaced-${s.key}`}>
                    + {count(s.count)} {typeWord(s.key).toLowerCase()} members not yet placed — the survey fills this in.
                  </p>
                ))}
            </section>

            {/* The number that actually changes a decision. A community is not a headcount — it is
                how many of those people have heard from the firm lately. The ring's total is
                everyone (its geometry needs the sum of its slices); the warm count is the heading's.
                Today that is a full grey ring with 0 warm, and that is the truth, not a bug. */}
            <section className="ring-host" data-testid="community-recency">
              {/* The ring's centre is its total and the one ring offers no second centre number, so
                  the count that matters — how many are warm — is the heading's, beside the title. */}
              <div className="home-section-head">
                <h4>How warm it is</h4>
                <span className="ring-head-count" data-testid="community-warm-count">
                  {count(warm)} warm of {count(warmth.total)}
                </span>
              </div>
              <AllocationRing
                slices={warmth.slices}
                total={warmth.total}
                caption="people"
                testid="community-warmth"
                format={count}
                ariaLabel={`${count(warm)} of ${count(warmth.total)} people are warm — heard from the firm in the last year`}
              />
            </section>
          </div>

          <p className="small">
            The firm has formed a view on <strong>{count(p.firm_has_a_view_on)}</strong> of these people.
          </p>
        </>
      )}

      {/* WHEN THIS WAS TRUE. A shape read off a sync is only as fresh as the sync; the date says so,
          and a read that did not land says why, next to the numbers it failed to refresh. */}
      <p className="muted small" data-testid="community-source">
        {p.source.last_sync_at ? (
          <>
            Last read from Network OS <time dateTime={p.source.last_sync_at}>{readableDate(p.source.last_sync_at)}</time>.
          </>
        ) : (
          "Not yet read from Network OS."
        )}
        {p.source.last_status !== "OK" && p.source.last_status !== "IN_PROGRESS" && p.total > 0 && (
          <> The last read did not land — {p.source.failure_reason ?? p.source.last_status}.</>
        )}{" "}
        Network OS owns who these people are. This reads the shape of them and never keeps a copy.
      </p>
    </section>
  );
}

/**
 * The last twenty-five people added in Network OS — "so we can see some names" (27 Sep 2026).
 *
 * A WINDOW, NOT A ROSTER. It is capped at 25 by the endpoint, read off the synced snapshot and
 * stored nowhere new. There is NO per-row link, on purpose: Network OS has no per-contact URL, so
 * a link here would have nowhere honest to go. The band's button is the door to the people.
 */
function NewestPanel(): JSX.Element {
  const res = useApi<{ newest: NewestContact[]; cap: number }>("/api/community/newest?limit=25");
  const rows = res.data?.newest;

  return (
    <section className="card" data-testid="community-newest">
      <h3>Newest in the community</h3>
      <p className="muted small">the last 25 added in Network OS</p>

      {res.loading && !rows && <p className="state-message">Reading the newest people…</p>}
      {!res.loading && !rows && <p className="state-message">The newest people could not be read just now.</p>}

      {rows && rows.length === 0 && (
        <p className="state-empty" data-testid="community-newest-empty">
          Nothing has been read from Network OS yet. Once the sync lands, the newest people appear here on their own.
        </p>
      )}

      {rows && rows.length > 0 && (
        <ul className="newest-list">
          {rows.map((c) => (
            <li key={c.external_id} className="newest-row" data-testid={`newest-${c.external_id}`}>
              <span className="newest-name">{c.full_name?.trim() || "Unnamed contact"}</span>
              <span className="newest-meta">
                {[c.company, typeWord(c.person_type ?? "unknown"), c.relationship_owner]
                  .map((v) => v?.trim())
                  .filter(Boolean)
                  .join(" · ")}
                {" · added "}
                <time dateTime={c.created_at ?? undefined}>{readableDate(c.created_at)}</time>
              </span>
            </li>
          ))}
        </ul>
      )}
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

        A BAND WITH TWO DOORS, not a grey notice. On 27 Sep 2026 this sat as the third block down
        in the same grey `.notice` every caution on the product wears, with the link buried
        mid-sentence, and the operator could not find it. Then it had one button and a link in a
        sentence, and the operator said "it says nothing about the capture tab as an option". So:
        one paragraph, two doors. Capture is the ink button, Network OS the orange one — the only
        orange button on the page, because it is the one that leaves it.

        CAPTURE IS THE ONLY DOOR FOR A NEW PERSON. The member form that used to sit lower on this
        page wrote to a local table and told nobody; a capture goes to Network OS's review queue,
        which is where a new person is meant to end up.
      */}
      <aside className="boundary-band" data-testid="community-network-os">
        <div className="boundary-band-copy">
          <p className="boundary-band-text">
            <strong>The people live in Network OS.</strong> They are added and edited there; this page is
            West Peek's read on them, never the other way round. Met someone new? Capture them here and
            they go to Network OS's review queue. Network OS is a separate sign-in, so it opens
            alongside this page.
          </p>
        </div>
        <div className="boundary-band-doors">
          <a className="btn-strong" href="#/capture" data-testid="community-capture-link">
            Capture someone
          </a>
          <a
            className="btn-primary"
            href="https://network.joinwestpeek.com"
            target="_blank"
            rel="noreferrer noopener"
            data-testid="community-network-os-link"
          >
            Open Network OS ↗
          </a>
        </div>
      </aside>

      <PopulationPanel />

      <NewestPanel />

      <HowThisWorks
        title="Community"
        testId="community"
        what="The firm’s read on the community as a population — how many people it holds, how many of them the firm can place, how warm they are, and who arrived most recently."
        when="Before convening a room, planning programming, or asking whether the community is warm enough to lean on."
        operatorDoes={[
          "Read the four numbers, the two rings and the newest names.",
          "Open Network OS to look at, add or edit the people themselves.",
          "Capture someone new — they go to Network OS's review queue.",
        ]}
        aiDoes={["Nothing on this page. The community is read from Network OS on its own schedule."]}
        requiresOperator={["Contacting a member is an external effect and needs an approval card."]}
        next="Network OS owns who is a member; this layer reads them. Relationship OS handles one relationship at a time — the warm path, the next move. Community OS reads the population. Cohort analytics and programming come later."
        blocked={[
          "Nothing here adds, edits or removes a person. That happens in Network OS, or through Capture, which sends them to Network OS's review queue.",
          "An empty shape means the sync has not landed, and the panel says so — it does not mean the community is empty.",
          "The tech-adjacent thousands are not in the placed ring: Network OS has not placed them yet, and the line under the ring says how many.",
        ]}
      />
    </div>
  );
}
