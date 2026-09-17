import { useApi } from "../lib/api";

/**
 * The candidates behind one week's hire note — as information, not as a queue (17 Sep 2026).
 *
 * ─── WHAT THIS PANEL USED TO BE, AND WHY IT IS NOT THAT ANY MORE ───────────────────────────────
 *
 * Until today each row carried two buttons: CONTACTED (he wrote to them; never shown again) and
 * PASSED (not the one; never shown again), with "Put back" to undo either. The reasoning at the
 * time was that it "works end to end with nothing to parse: one row, one status, one click".
 *
 * Operator, on the note that asks for those clicks: "i really dont think we should give him extra
 * work if he likes one he will reach out with the sample draft intro language walker creates."
 *
 * The buttons were not the real problem. The real problem was that the WEEKLY NOTE'S USEFULNESS
 * DEPENDED ON THEM: a name he did not mark came back, so a partner who never opened this panel got
 * a note that slowly filled with people he had already dealt with. That is a feature that has
 * quietly assigned its own upkeep to the person it was built for.
 *
 * So the state is gone and the information is kept. This shows who is behind the note, with the
 * pages, so he can open one. Steering happens where he was always going to do it anyway — by
 * replying to the email in plain words, which is matched to the search automatically and read by a
 * reasoning model before the next run.
 *
 * Only rendered for the `productions_hire_search` kind, and the route answers only to Scooter — for
 * anybody else the list is a 404 and this panel says so rather than rendering an empty list that
 * looks like "no candidates".
 */

interface Candidate {
  id: string;
  url: string;
  name: string;
  title: string;
  company: string;
  city: string;
  evidence_url: string | null;
  fit_score: number;
  first_seen: string;
  week: string;
  status: string;
}

export function HireCandidatePanel({ deliverableId }: { deliverableId: string }): JSX.Element {
  const list = useApi<{ candidates: Candidate[] }>(
    `/api/productions/candidates?deliverable=${encodeURIComponent(deliverableId)}`,
  );

  if (list.status === 404) {
    return (
      <p className="muted small" data-testid={`hire-candidates-private-${deliverableId}`}>
        The candidate list answers only to the partner this note was for.
      </p>
    );
  }
  const rows = list.data?.candidates ?? [];
  if (!list.loading && rows.length === 0) {
    return (
      <p className="state-empty" data-testid={`hire-candidates-empty-${deliverableId}`}>
        No candidate rows are behind this note.
      </p>
    );
  }

  return (
    <div className="hire-candidates" data-testid={`hire-candidates-${deliverableId}`}>
      <p className="muted small" data-testid="hire-candidates-no-upkeep">
        Nothing to mark here. Open whoever you want to; if you want to steer next week&rsquo;s search,
        reply to Walker&rsquo;s email in plain words. Nothing is sent to a candidate from here.
      </p>
      <ul className="hire-candidate-list">
        {rows.map((c) => (
          <li key={c.id} className="hire-candidate" data-testid={`hire-candidate-${c.id}`}>
            <div className="hire-candidate-head">
              <a href={c.url} target="_blank" rel="noreferrer noopener" className="hire-candidate-name">
                {c.name}
              </a>
              <span className="muted small">
                {c.title}
                {c.company ? `, ${c.company}` : ""}
                {c.city ? ` · ${c.city}` : ""} · fit {c.fit_score}/10
              </span>
              {/* First seen, not a status: what a reader wants is whether this is a new name or one
                  that has been on the table a while, and the date says that without anybody having
                  to keep it up to date. */}
              <span className="badge badge-quiet" data-testid={`hire-candidate-first-seen-${c.id}`}>
                first seen {c.first_seen.slice(0, 10)}
              </span>
            </div>
            {c.evidence_url && (
              <div className="form-row hire-candidate-actions">
                <a href={c.evidence_url} target="_blank" rel="noreferrer noopener" className="link-button small">
                  The page that answered
                </a>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
