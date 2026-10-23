import { useApi } from "../lib/api";

/**
 * PARTNERS — every brand that said yes, on every Rooms event (owner, 22 Oct 2026). ONE component
 * over ONE server read (`GET /api/rooms/partners`), which covers the Learning Club's deals and a
 * general Room's sponsors alike. Calm: the money first, in words; then one plain list per event.
 * Green means money is agreed or paid; a "New yes" badge marks a yes from the last 7 days.
 */

interface PanelPartner {
  id: string;
  brand: string;
  role: "Partner" | "Presenting" | "In kind";
  amountUsd: number;
  stage: "SAID_YES" | "CALL" | "AGREED" | "PAID";
  stageWords: string;
  yesAt: string;
  isNew: boolean;
  threadUrl: string | null;
}
interface PanelEvent {
  source: "TLC" | "ROOMS";
  eventId: string;
  title: string;
  when: string | null;
  partners: PanelPartner[];
  committedUsd: number;
  progressWords: string;
  progressPct: number | null;
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const STEPS = ["said yes", "call", "agreed", "paid"];

export function PartnersPanel(props: { source: "TLC" | "ROOMS" }): JSX.Element {
  const res = useApi<{ events: PanelEvent[] }>("/api/rooms/partners");
  if (res.loading) return <p className="state-empty">Reading the partners…</p>;
  if (res.status === 403) return <></>;
  if (!res.data) return <p className="state-empty">The partners could not be read just now. Reload the page to try again.</p>;
  const events = res.data.events.filter((e) => e.source === props.source && (props.source === "TLC" || e.partners.length > 0));
  if (events.length === 0) {
    return <p className="state-empty" data-testid={`partners-empty-${props.source}`}>No brand has said yes yet.</p>;
  }
  return (
    <div data-testid={`partners-${props.source}`}>
      <p className="muted small">Stages, in order: {STEPS.join(" → ")}. Green means the money is agreed or paid.</p>
      <ul className="card-list">
        {events.map((e) => (
          <li key={`${e.source}-${e.eventId}`} data-testid={`partners-event-${e.eventId}`}>
            <strong>{e.title}</strong>
            {e.when && <span className="muted"> · {e.when.slice(0, 10)}</span>}
            <div>
              {e.progressPct !== null && (
                <progress max={100} value={e.progressPct} aria-label={`${e.title}: ${e.progressWords}`} />
              )}{" "}
              <span data-testid={`partners-progress-${e.eventId}`}>{e.progressWords}</span>
            </div>
            {e.partners.length === 0 ? (
              <div className="muted small">No brand has said yes for this one yet.</div>
            ) : (
              <ul>
                {e.partners.map((p) => (
                  <li key={p.id} data-testid={`partner-${p.id}`}>
                    <strong>{p.brand}</strong> · {p.role} · {usd(p.amountUsd)} ·{" "}
                    <span className={`badge ${p.stage === "AGREED" || p.stage === "PAID" ? "badge-ok" : "badge-quiet"}`}>{p.stageWords}</span>
                    {p.isNew && <> <span className="badge badge-attention">New yes</span></>}
                    <span className="muted small"> · {p.yesAt.slice(0, 10)}</span>
                    {p.threadUrl && (
                      <>
                        {" "}· <a href={p.threadUrl}>Open the conversation</a>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
