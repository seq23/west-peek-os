import { useState } from "react";
import { api, useApi } from "../lib/api";
import { shortMonth } from "@shared/tlc/mustPitch";

/**
 * BRANDS WE MUST PITCH (owner, 23 Oct 2026: "are we reaching out to anthropic i think that is important
 * and google?"). Her list per club, on the TLC panel; the "Needs a way in" items on the panel and on
 * Approvals. make-it-calm: plain words, one list, phone first, Remove asks first, every change says who
 * and when.
 */

interface MustPitch {
  id: string;
  month: string;
  brand: string;
  reason: string;
  added_by: string;
  added_at: string;
  removed_by: string | null;
  removed_at: string | null;
}
interface WayIn {
  brand_key: string;
  brand: string;
  state: "OPEN" | "CONTACT_ADDED" | "FOUND";
  months: string[];
  pages: string[];
  words: string;
  checked_at: string;
  changed_at: string;
  contact_name: string | null;
  contact_email: string | null;
  note: string | null;
  supplied_by: string | null;
  supplied_at: string | null;
  on_approvals: boolean;
}
interface HistoryRow {
  id: string;
  brand: string;
  month: string | null;
  action: "ADDED" | "REMOVED" | "NO_ADDRESS" | "FOUND" | "CONTACT_ADDED" | "QUEUED";
  by_who: string;
  at: string;
  detail: string | null;
}
interface MustPitchData {
  must_pitch: MustPitch[];
  removed: MustPitch[];
  way_in: WayIn[];
  history: HistoryRow[];
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthWords = (m: string): string => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? m} ${m.slice(0, 4)}`;
const day = (iso: string): string => iso.slice(0, 10);

const HISTORY_WORDS: Record<HistoryRow["action"], string> = {
  ADDED: "added",
  REMOVED: "removed",
  NO_ADDRESS: "no public address found",
  FOUND: "contact found on a public page, queued",
  CONTACT_ADDED: "contact added by hand",
  QUEUED: "queued for the emails",
};

/** On the TLC panel: the list per month, add and remove, the "Needs a way in" items, and the history. */
export function MustPitchSection(props: { months: readonly string[] }): JSX.Element {
  const mp = useApi<MustPitchData>("/api/tlc/must-pitch");
  const [month, setMonth] = useState(props.months[0] ?? "");
  const [brand, setBrand] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const data = mp.data;
  const months = [...new Set([...props.months, ...(data?.must_pitch ?? []).map((m) => m.month)])].sort();

  const add = async (): Promise<void> => {
    if (!month || brand.trim().length < 2 || reason.trim().length < 2) {
      setMessage("Pick the month, write the brand, and one line on why.");
      return;
    }
    const res = await api<{ detail?: string }>("/api/tlc/must-pitch", { method: "POST", body: { month, brand: brand.trim(), reason: reason.trim() } });
    if (res.status === 200) {
      setMessage(`Added ${brand.trim()} for ${monthWords(month)}. Wynn pitches it first, every week, until it is queued.`);
      setBrand("");
      setReason("");
      mp.reload();
    } else setMessage(res.data?.detail ?? "That did not save. Try again.");
  };
  const remove = async (row: MustPitch): Promise<void> => {
    const res = await api<{ detail?: string }>(`/api/tlc/must-pitch/${row.id}/remove`, { method: "POST", body: {} });
    setConfirming(null);
    setMessage(res.status === 200 ? `Removed ${row.brand} from ${monthWords(row.month)}. It stays in the history below.` : res.data?.detail ?? "That did not save. Try again.");
    mp.reload();
  };

  return (
    <section data-testid="tlc-must-pitch">
      <h4>Brands we must pitch</h4>
      <p className="muted small">
        Wynn pitches these first every week, on top of his own five per club. He looks for a named person in
        partnerships, events, community, a startup program or developer relations whose address is printed on a
        public page. If there is none, the brand shows under "Needs a way in" below, never dropped.
      </p>
      {message && <p className="notice" role="status">{message}</p>}
      {mp.loading ? (
        <p className="state-empty">Reading the list…</p>
      ) : !data ? (
        <p className="state-empty">The list could not be read just now. Reload the page to try again.</p>
      ) : (
        <>
          {data.way_in.filter((w) => w.state === "OPEN").length > 0 && (
            <WayInList items={data.way_in.filter((w) => w.state === "OPEN")} onChange={mp.reload} />
          )}

          {months.length === 0 && data.must_pitch.length === 0 ? (
            <p className="state-empty">No club month yet. The list opens once Parker starts a month.</p>
          ) : (
            <ul className="card-list" data-testid="tlc-must-pitch-list">
              {months.map((m) => {
                const rows = data.must_pitch.filter((r) => r.month === m);
                return (
                  <li key={m}>
                    <strong>{monthWords(m)}</strong>
                    {rows.length === 0 ? (
                      <div className="muted small">No brand on the list for this month.</div>
                    ) : (
                      <ul>
                        {rows.map((r) => {
                          const way = data.way_in.find((w) => w.brand.toLowerCase() === r.brand.toLowerCase());
                          return (
                            <li key={r.id} data-testid={`tlc-must-pitch-${r.id}`}>
                              <strong>{r.brand}</strong>: {r.reason}
                              <div className="muted small">
                                Added by {r.added_by} on {day(r.added_at)}
                                {way?.state === "OPEN" && <> · <span className="badge badge-gate">Needs a way in</span></>}
                                {way?.state === "CONTACT_ADDED" && <> · Your contact: {way.contact_name}</>}
                              </div>
                              {confirming === r.id ? (
                                <div className="notice" role="alert">
                                  <p>Take {r.brand} off the list for {monthWords(r.month)}? Wynn stops pitching it for this month. Emails already queued are not changed.</p>
                                  <button type="button" onClick={() => void remove(r)}>Yes, remove {r.brand}</button>{" "}
                                  <button type="button" className="link-button" onClick={() => setConfirming(null)}>Cancel, keep it</button>
                                </div>
                              ) : (
                                <button type="button" className="link-button" onClick={() => setConfirming(r.id)}>Remove {r.brand} from {shortMonth(r.month)}</button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="form-row" data-testid="tlc-must-pitch-add">
            <label>
              Which month
              <select value={month} onChange={(e) => setMonth(e.target.value)}>
                <option value="">Choose a month</option>
                {months.map((m) => (
                  <option key={m} value={m}>{monthWords(m)}</option>
                ))}
              </select>
            </label>
            <label>
              Brand
              <input value={brand} onChange={(e) => setBrand(e.target.value)} placeholder="e.g. Anthropic" maxLength={80} />
            </label>
            <label>
              Why, in one line
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. AI partner for this club" maxLength={200} />
            </label>
            <button type="button" onClick={() => void add()}>Add to the must-pitch list</button>
          </div>

          {(data.history.length > 0 || data.removed.length > 0) && (
            <details data-testid="tlc-must-pitch-history">
              <summary>Every change, who and when (tap to open)</summary>
              <ul className="card-list">
                {data.history.map((h) => (
                  <li key={h.id} className="small">
                    {day(h.at)} · {h.by_who}: <strong>{h.brand}</strong>
                    {h.month ? ` (${h.month.split(",").map(shortMonth).join(", ")})` : ""} {HISTORY_WORDS[h.action]}
                    {h.detail ? <span className="muted"> — {h.detail}</span> : null}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </section>
  );
}

/** One "Needs a way in" item per brand, with the form to add a contact. Shared by the TLC panel and Approvals. */
function WayInList(props: { items: WayIn[]; onChange: () => void; onApprovals?: boolean }): JSX.Element {
  return (
    <ul className="card-list" data-testid="tlc-way-in">
      {props.items.map((w) => (
        <WayInItem key={w.brand_key} item={w} onChange={props.onChange} onApprovals={props.onApprovals ?? false} />
      ))}
    </ul>
  );
}

function WayInItem(props: { item: WayIn; onChange: () => void; onApprovals: boolean }): JSX.Element {
  const w = props.item;
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const key = encodeURIComponent(w.brand_key);
  const save = async (): Promise<void> => {
    if (name.trim().length < 2 || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email.trim())) {
      setMsg("Write the person's name and their email address.");
      return;
    }
    const res = await api<{ detail?: string; queued?: string[] }>(`/api/tlc/way-in/${key}/contact`, { method: "POST", body: { contact_name: name.trim(), contact_email: email.trim(), ...(note.trim() ? { note: note.trim() } : {}) } });
    if (res.status === 200) {
      setMsg(`Saved. ${w.brand} joins the same emails as every brand, and each one still waits for your approval.`);
      setOpen(false);
      props.onChange();
    } else setMsg(res.data?.detail ?? "That did not save. Try again.");
  };
  const hide = async (): Promise<void> => {
    const res = await api(`/api/tlc/way-in/${key}/hide`, { method: "POST", body: {} });
    setMsg(res.status === 200 ? "Hidden from Approvals until something changes. It stays on the Rooms page." : "That did not save. Try again.");
    props.onChange();
  };
  return (
    <li data-testid={`tlc-way-in-${w.brand_key}`}>
      <span className="badge badge-gate">Needs a way in</span>
      <p>
        <strong>{w.brand}</strong> ({w.months.map(shortMonth).join(", ")}): no public partnerships address found.
      </p>
      <div className="small">
        Pages checked:{" "}
        {w.pages.length === 0
          ? "none answered"
          : w.pages.map((p, i) => (
              <span key={p}>
                {i > 0 && ", "}
                <a href={p} target="_blank" rel="noreferrer">{p.replace(/^https?:\/\//, "")}</a>
              </span>
            ))}
      </div>
      <div className="muted small">Checked again every Monday · last checked {day(w.checked_at)}</div>
      <p className="small">If you have a contact or an intro, add it here.</p>
      {msg && <p className="notice" role="status">{msg}</p>}
      {open ? (
        <div className="form-row">
          <label>
            Their name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
          <label>
            Their email
            <input type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={200} />
          </label>
          <label>
            A note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. intro from a friend at the company" maxLength={600} />
          </label>
          <button type="button" onClick={() => void save()}>Save this contact</button>{" "}
          <button type="button" className="link-button" onClick={() => setOpen(false)}>Cancel, change nothing</button>
        </div>
      ) : (
        <button type="button" onClick={() => setOpen(true)}>Add a contact for {w.brand}</button>
      )}
      {props.onApprovals && (
        <>
          {" "}
          <button type="button" className="link-button" onClick={() => void hide()}>Hide until something changes</button>
        </>
      )}
    </li>
  );
}

/** On Approvals: the open items she has not hidden, or that changed since she hid them. Nothing when there are none. */
export function WayInApprovals({ refreshNonce }: { refreshNonce: number }): JSX.Element | null {
  const mp = useApi<MustPitchData>("/api/tlc/must-pitch", [refreshNonce]);
  const items = (mp.data?.way_in ?? []).filter((w) => w.on_approvals);
  if (items.length === 0) return null;
  return (
    <section className="card" data-testid="approvals-way-in">
      <h3>The Learning Club: brands that need a way in</h3>
      <p className="muted small">
        Brands on your must-pitch list with no public address. Nothing is sent until there is one. <a href="#/rooms">Open Events &amp; Rooms (tap to open)</a>
      </p>
      <WayInList items={items} onChange={mp.reload} onApprovals />
    </section>
  );
}
