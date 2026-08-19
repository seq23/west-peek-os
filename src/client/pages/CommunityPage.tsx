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

export function CommunityPage(): JSX.Element {
  const state = useApi<{ members: MemberRow[]; counts: Record<string, number> }>("/api/community/members");
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("MEMBER");
  const [status, setStatus] = useState<string>("ACTIVE");
  const [segment, setSegment] = useState<string>("UNSEGMENTED");
  const [engagement, setEngagement] = useState<string>("UNKNOWN");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const members = state.data?.members ?? [];
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
      <h2>Community</h2>
      <p className="muted">
        How the community is behaving — segments, engagement, and what that suggests for the firm.
      </p>

      {/* INTRODUCTIONS LIVES HERE NOW, and first, because it is the only thing on this page anybody
          has to ACT on. It had a tab of its own next to Approvals and Notifications, which put a
          surface that is empty most months — deliberately, because the matcher is tuned to be rare
          — alongside the things that always have something waiting. Community is who the members
          are; introductions is what the firm does about them. One subject, one page. */}
      <IntroductionsPage />

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
        {members.length === 0 ? (
          <p className="state-empty" data-testid="community-empty">No members recorded yet.</p>
        ) : (
          <ul className="card-list small" data-testid="community-list">
            {members.map((m) => (
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
