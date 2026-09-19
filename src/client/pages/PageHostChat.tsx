import { useState } from "react";
import { api, useApi } from "../lib/api";
import { MarkdownLite } from "../components/MarkdownLite";

/**
 * The box where you ask the person who runs this page.
 *
 * Operator, item 14: an AI chat panel on every page, top right.
 *
 * IT EXPANDS THE CARD. It is not a panel, a sidebar or a bubble. Operator, on the first attempt —
 * which floated a button to the right edge and opened a 22rem column inside the card: "i am afraid u
 * ruined the UI... each 1:1 chat panel should just expand the host card as is". She was right. A
 * second container inside a card is two boxes where the page had one, and seventeen pages carrying
 * that is seventeen pages made worse.
 *
 * So the card keeps its exact shape and grows downward. Closed, the only new pixels are one quiet
 * line in the bottom corner. Open, a rule appears and the conversation continues the card — same
 * width, same padding, no border of its own, nothing to look at that is not the conversation.
 *
 * THE LINE SAYS WHETHER THERE IS ANYTHING THERE. "Ask Wyatt" on a page you have never asked about,
 * and the count once there is a thread — so a partner can tell at a glance that last month's answer
 * is still underneath, rather than having to open every card to find out.
 *
 * THE THREAD PERSISTS PER PAGE. Reopening it on Follow-on next week shows what you asked about
 * Follow-on, not a blank box — the questions a partner asks about a surface are usually the same
 * three, and having last month's answer already there is most of the value.
 *
 * A FAILED OR REFUSED TURN IS SHOWN AS A TURN, never as a toast that disappears. If the host is
 * switched off, or the provider fell over, that is part of the conversation and stays in it. The
 * pattern is University's and Research's, deliberately identical — three chat surfaces that each
 * invented their own error handling would leave two of them wrong.
 *
 * A HOST'S TURN IS PAINTED AS MARKDOWN, not dropped into a `<p>`. Owner, 19 Sep 2026, on Walter's
 * answer to "how does this page work": "I can't understand anything he said — it's all jumbled."
 * The answer had been composed as a numbered list with the controls in bold and this component
 * flattened it into one paragraph, so the structure the reader needed was written and then thrown
 * away on the way to the screen. `MarkdownLite` keeps the list a list. The partner's own turns stay
 * plain — they typed a sentence, not a document.
 */

interface Turn {
  id: string;
  turn_no: number;
  role: string;
  body: string;
  state: string;
  detail: string | null;
  created_at: string;
}

export function PageHostChat({ navKey, hostName }: { navKey: string; hostName: string }): JSX.Element {
  const [open, setOpen] = useState(false);
  // Nothing is fetched until it is opened. Seventeen hosted pages firing a thread request each on
  // load would spend a round trip per page for a box most visits never open.
  const thread = useApi<{ turns: Turn[] }>(open ? `/api/pages/${navKey}/thread` : null, [navKey, open]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const turns = thread.data?.turns ?? [];

  async function send() {
    const text = message.trim();
    if (text.length < 2) return;
    setBusy(true);
    // The reply is read back off the thread rather than spliced in from the response, so what is on
    // screen is what was actually recorded. A message that was written but not stored would
    // otherwise sit there looking sent.
    await api(`/api/pages/${navKey}/reply`, { method: "POST", body: { message: text } });
    setBusy(false);
    setMessage("");
    thread.reload();
  }

  // Kept once opened, so closing and reopening does not re-fetch a thread that has not changed.
  const said = turns.filter((t) => t.role !== "SYSTEM").length;

  return (
    <div className="host-chat" data-testid={`page-chat-${navKey}`}>
      <button
        type="button"
        className="host-chat-toggle"
        aria-expanded={open}
        data-testid={`page-chat-toggle-${navKey}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="host-chat-chevron" aria-hidden="true" />
        {open ? `Done asking ${hostName}` : said > 0 ? `Ask ${hostName} · ${said} earlier` : `Ask ${hostName} about this page`}
      </button>

      {open && (
        <div className="host-chat-body">
          <div className="host-chat-thread" data-testid={`page-chat-thread-${navKey}`}>
            {turns.length === 0 && !thread.loading && (
              <p className="muted small">
                {hostName} runs this page. Ask what something here means, or what you should do next.
              </p>
            )}
            {turns.map((t) => (
              <div
                key={t.id}
                className={`host-chat-turn ${t.state === "OK" ? (t.role === "PARTNER" ? "host-chat-you" : "host-chat-them") : "host-chat-broke"}`}
                data-testid={`page-chat-turn-${t.id}`}
                data-role={t.role}
              >
                <span className="host-chat-who">{t.role === "PARTNER" ? "You" : t.role === "HOST" ? hostName : "West Peek OS"}</span>
                {t.role === "HOST" && t.state === "OK" ? (
                  <MarkdownLite text={t.body} className="host-chat-md" />
                ) : (
                  <p>{t.body}</p>
                )}
              </div>
            ))}
          </div>

          <div className="host-chat-ask">
            <input
              data-testid={`page-chat-input-${navKey}`}
              aria-label={`Ask ${hostName} about this page`}
              value={message}
              disabled={busy}
              placeholder="Type your question"
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !busy) void send();
              }}
            />
            <button
              type="button"
              className="btn-strong"
              disabled={busy || message.trim().length < 2}
              data-testid={`page-chat-send-${navKey}`}
              onClick={() => void send()}
            >
              {busy ? "Asking…" : "Ask"}
            </button>
          </div>

          {/* Said once, because a partner who believes the box can act will wait for something that
              is never going to happen. */}
          <p className="muted small">{hostName} can explain and advise. Pressing the controls is yours.</p>
        </div>
      )}
    </div>
  );
}
