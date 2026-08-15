import { api } from "./api";

/**
 * Offline capture queue (P20, GAP-20).
 *
 * The ONE thing West Peek OS lets you do without a connection is capture a thought — and it is
 * completely explicit that a queued capture is NOT saved:
 *
 * - Queued items live in localStorage on this device only, marked as pending.
 * - Nothing is presented as recorded until the server has accepted it and returned an id.
 * - Flushing is idempotent per item: an item is removed from the queue only after a 201.
 * - Nothing else is available offline. Approvals, decisions, and reads all need the server,
 *   because a decision taken against stale institutional state is worse than no decision.
 */

const QUEUE_KEY = "wpos.offlineCaptures";

export interface QueuedCapture {
  local_id: string;
  capture_type: string;
  raw_text: string;
  source_channel: string;
  privacy_label: string;
  queued_at: string;
}

function read(): QueuedCapture[] {
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY);
    return raw ? (JSON.parse(raw) as QueuedCapture[]) : [];
  } catch {
    return [];
  }
}

function write(items: QueuedCapture[]): void {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
  } catch {
    /* storage unavailable: the queue simply does not persist, and the UI says so */
  }
}

export function queuedCaptures(): QueuedCapture[] {
  return read();
}

export function enqueueCapture(input: Omit<QueuedCapture, "local_id" | "queued_at">): QueuedCapture {
  const item: QueuedCapture = {
    ...input,
    local_id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    queued_at: new Date().toISOString(),
  };
  write([...read(), item]);
  return item;
}

export interface FlushResult {
  sent: number;
  remaining: number;
  failures: Array<{ local_id: string; reason: string }>;
}

/**
 * Send everything queued. An item leaves the queue ONLY on a 201 from the server; anything else
 * stays queued with its reason, so a capture is never silently lost or silently duplicated.
 */
export async function flushCaptures(): Promise<FlushResult> {
  const items = read();
  if (items.length === 0) return { sent: 0, remaining: 0, failures: [] };

  const failures: FlushResult["failures"] = [];
  const remaining: QueuedCapture[] = [];
  let sent = 0;

  for (const item of items) {
    try {
      const res = await api<{ id?: string; error?: string }>("/api/captures", {
        method: "POST",
        body: {
          capture_type: item.capture_type,
          raw_text: item.raw_text,
          source_channel: item.source_channel,
          privacy_label: item.privacy_label,
        },
      });
      if (res.status === 201 && res.data?.id) {
        sent += 1;
      } else {
        remaining.push(item);
        failures.push({ local_id: item.local_id, reason: res.data?.error ?? `HTTP ${res.status}` });
      }
    } catch (err) {
      remaining.push(item);
      failures.push({ local_id: item.local_id, reason: err instanceof Error ? err.message : "network unavailable" });
    }
  }

  write(remaining);
  return { sent, remaining: remaining.length, failures };
}

export function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}
