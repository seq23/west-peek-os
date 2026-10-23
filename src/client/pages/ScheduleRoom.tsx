import { useState } from "react";
import { api } from "../lib/api";
import { PARTNERS } from "@shared/registry/partners";

/**
 * "SCHEDULE THIS ROOM" (owner approved the v8 mock-up, 23 Oct 2026). A kept Room is banked, not
 * booked: its sponsors stay PARKED and nobody works them. Giving it a date and a place is the step
 * that puts it on the calendar AND makes its sponsors live (roomPacket.ts `scheduleRoom`). It asks
 * first, says what will happen in plain words, and Cancel changes nothing.
 */

/** Sponsor words, said the way a partner would say them. One list for every page that shows a sponsor. */
export const SPONSOR_STAGES = [
  { key: "IDENTIFIED", label: "On the list" },
  { key: "RESEARCHING", label: "Being researched" },
  { key: "DRAFTED", label: "Approach drafted" },
  { key: "SENT", label: "Approach sent" },
  { key: "IN_CONVERSATION", label: "In conversation" },
  { key: "COMMITTED", label: "Committed" },
  { key: "DECLINED", label: "Said no" },
  { key: "PARKED", label: "Parked until the Room has a date" },
] as const;

export const CATEGORIES = [
  { key: "CLOUD", label: "Cloud" },
  { key: "FINTECH_SPEND", label: "Spend and fintech" },
  { key: "EQUITY_CAPTABLE", label: "Cap table and equity" },
  { key: "LEGAL", label: "Legal" },
  { key: "PAYROLL_HR", label: "Payroll and HR" },
  { key: "BANKING", label: "Banking" },
  { key: "HOSPITALITY", label: "Hospitality" },
  { key: "RECRUITING", label: "Recruiting" },
  { key: "OTHER", label: "Something else" },
] as const;

export const TIERS = [
  { key: "PRESENTING", label: "Presenting" },
  { key: "SUPPORTING", label: "Supporting" },
  { key: "IN_KIND", label: "In kind" },
] as const;

export const stageLabel = (key: string): string => SPONSOR_STAGES.find((s) => s.key === key)?.label ?? "Not recorded";
export const categoryLabel = (key: string): string => CATEGORIES.find((c) => c.key === key)?.label ?? "Something else";
export const tierLabel = (key: string): string => TIERS.find((t) => t.key === key)?.label ?? "Supporting";

export const usd = (n: number | null | undefined): string =>
  n === null || n === undefined ? "—" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`;

/**
 * WHO DECIDED, IN WORDS. The record stores a firm-user id ("fu_…"); the screen says "you" for the
 * person reading it and the partner's first name otherwise — never the id (owner, 23 Oct 2026).
 */
export function whoWord(firmUserId: string | null | undefined, meId: string | null | undefined): string {
  if (!firmUserId) return "a partner";
  if (meId && firmUserId === meId) return "you";
  const p = PARTNERS.find((x) => x.firmUserId === firmUserId);
  if (p) return p.firstName;
  return /^fu_|^aie_/.test(firmUserId) ? "a partner" : firmUserId;
}

export function ScheduleRoomButton(props: { packetId: string; title: string; parkedSponsors: number; onDone: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState("");
  const [place, setPlace] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setMsg("Choose the date first.");
      return;
    }
    setBusy(true);
    const res = await api<{ detail?: string }>(`/api/rooms/packets/${props.packetId}/schedule`, {
      method: "POST",
      body: { starts_at: `${date}T23:00:00.000Z`, location: place.trim() || null },
    });
    setBusy(false);
    if (res.status === 201) {
      setOpen(false);
      setMsg(`${props.title} is scheduled. ${props.parkedSponsors > 0 ? `Its ${props.parkedSponsors} sponsor${props.parkedSponsors === 1 ? " is" : "s are"} live now; nobody is contacted until you approve an approach.` : ""}`);
      props.onDone();
    } else setMsg(res.data?.detail ?? "That did not save. Try again.");
  };

  return (
    <div className="schedule-room" data-testid={`schedule-room-${props.packetId}`}>
      {!open ? (
        <button type="button" className="btn-strong" data-testid={`schedule-open-${props.packetId}`} onClick={() => setOpen(true)}>
          Schedule this Room
        </button>
      ) : (
        <div className="notice" role="group" aria-label={`Schedule ${props.title}`}>
          <p className="small">
            Give {props.title} a date and a place. It goes on the calendar
            {props.parkedSponsors > 0
              ? `, and its ${props.parkedSponsors} parked sponsor${props.parkedSponsors === 1 ? "" : "s"} become live: they go on the list to be worked. Nobody is contacted until you approve an approach.`
              : "."}
          </p>
          <div className="form-row">
            <label>
              Date
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} data-testid={`schedule-date-${props.packetId}`} />
            </label>
            <label>
              Place (optional)
              <input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={300} placeholder="e.g. the venue you called" data-testid={`schedule-place-${props.packetId}`} />
            </label>
            <button type="button" disabled={busy} onClick={() => void save()} data-testid={`schedule-confirm-${props.packetId}`}>
              {busy ? "Scheduling…" : "Yes, schedule it"}
            </button>{" "}
            <button type="button" className="link-button" onClick={() => setOpen(false)}>Cancel, change nothing</button>
          </div>
        </div>
      )}
      {msg && <p className="notice small" role="status" data-testid={`schedule-message-${props.packetId}`}>{msg}</p>}
    </div>
  );
}
