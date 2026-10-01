/**
 * RUNNING A SEAT IN LIVE-SEARCH MODE, AND COUNTING WHAT IT ACTUALLY DID (0246, 1 Oct 2026).
 *
 * The router parks a search call on a seat only if the claimer said it can search; the Worker records
 * the answer as REPORTED only if the claimer counted search events. This file is the half that does the
 * counting, and it is pure — text in, numbers out — so it is tested against the CLIs' real output
 * (tests/fixtures/codex-search-probe.jsonl is verbatim from the owner's Mac, 1 Oct 2026).
 *
 * WHAT COUNTS AS "IT SEARCHED".
 *   Codex   `codex exec --json -c web_search=live` writes one `item.completed` of type `web_search` per
 *           search AND per page it opens or searches inside (the probe's rows 2, 4 and 5 carry a URL in
 *           `query` with `action.type` "other"). Each is a counted event.
 *   Claude  `claude -p --output-format stream-json --verbose` writes an assistant `tool_use` block named
 *           WebSearch or WebFetch for each; the final `result` also carries
 *           `usage.server_tool_use.web_search_requests`, and the larger of the two counts is used.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: judge the answer. It says whether searches ran and what the
 * answer text is. Whether the answer is good is the caller's verifier and the evidence-URL check.
 *
 * UNPROVEN: the Claude stream shape. It is written from the CLI's documented stream-json output and
 * the shape captured when the weekly limit stopped a run (tests/fixtures/claude-weekly-limit-stream.jsonl);
 * no successful Claude search run has been captured, because the plan was out of usage until 2 Oct 8am CT.
 */

/** Arguments for `codex exec` in live-search mode. Read-only: it researches, it does not edit. */
export function codexSearchArgs(prompt) {
  return ["exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check", "-c", "web_search=live", prompt];
}

/** Arguments for `claude -p` in search mode: the two web tools pre-approved, events streamed. */
export function claudeSearchArgs(prompt) {
  return ["-p", prompt, "--allowedTools", "WebSearch,WebFetch", "--output-format", "stream-json", "--verbose"];
}

function lines(stdout) {
  return String(stdout ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter((o) => o && typeof o === "object");
}

const MAX_QUERIES = 60;

/**
 * @param {string} stdout the JSONL stream from `codex exec --json`
 * @returns {{ events: number, queries: string[], answer: string, errorText: string, terminal: "completed" | "failed" | null }}
 */
export function parseCodexSearch(stdout) {
  let events = 0;
  const queries = [];
  let answer = "";
  let errorText = "";
  /*
   * HOW THE TURN ENDED (review of #216). `turn.completed` is a finish; `turn.failed` is a failure; neither
   * means the stream was cut off. A bare `error` event is NOT terminal — Codex emits them for retries and
   * reconnects before a turn that then completes — so it only records text and decides nothing.
   */
  let terminal = null;
  for (const o of lines(stdout)) {
    if (o.type === "item.completed" && o.item?.type === "web_search") {
      events += 1;
      const q = typeof o.item.query === "string" ? o.item.query : "";
      if (q && queries.length < MAX_QUERIES) queries.push(q.slice(0, 300));
    } else if (o.type === "item.completed" && o.item?.type === "agent_message" && typeof o.item.text === "string") {
      // The ANSWER is the LAST agent message; earlier ones are the model narrating what it is about to do.
      answer = o.item.text;
    } else if (o.type === "error" && typeof o.message === "string") {
      errorText = o.message;
    } else if (o.type === "turn.completed") {
      terminal = "completed";
    } else if (o.type === "turn.failed") {
      terminal = "failed";
      errorText = String(o.error?.message ?? errorText ?? "");
    }
  }
  return { events, queries, answer: answer.trim(), errorText: errorText.trim(), terminal };
}

/**
 * @param {string} stdout the stream-json output of `claude -p … --verbose`
 * @returns {{ events: number, queries: string[], answer: string, errorText: string, terminal: "completed" | "failed" | null }}
 */
export function parseClaudeSearch(stdout) {
  let toolEvents = 0;
  let serverReported = 0;
  const queries = [];
  let answer = "";
  let errorText = "";
  let terminal = null;
  for (const o of lines(stdout)) {
    if (o.type === "assistant" && Array.isArray(o.message?.content)) {
      for (const block of o.message.content) {
        if (block?.type === "tool_use" && (block.name === "WebSearch" || block.name === "WebFetch")) {
          toolEvents += 1;
          const q = block.input?.query ?? block.input?.url;
          if (typeof q === "string" && queries.length < MAX_QUERIES) queries.push(q.slice(0, 300));
        }
      }
    } else if (o.type === "result") {
      const st = o.usage?.server_tool_use ?? {};
      serverReported = Math.max(serverReported, Number(st.web_search_requests ?? 0) + Number(st.web_fetch_requests ?? 0));
      if (o.is_error === true) {
        terminal = "failed";
        errorText = String(o.result ?? "");
      } else if (typeof o.result === "string") {
        terminal = "completed";
        answer = o.result;
      }
    }
  }
  return { events: Math.max(toolEvents, serverReported), queries, answer: answer.trim(), errorText: errorText.trim(), terminal };
}

/**
 * Turn a parsed search run into what the claimer reports. An answer with zero counted events is NOT
 * reported as an answer — it is reported as the failure it is, in words, so the card and the run can
 * say "it answered from memory" instead of presenting it as research.
 *
 * @param {{ events: number, queries: string[], answer: string, errorText: string, terminal: "completed" | "failed" | null }} parsed
 * @param {string} displayName
 */
export function searchOutcome(parsed, displayName) {
  /*
   * A TURN THAT DID NOT FINISH IS NOT AN ANSWER, WHATEVER TEXT IT LEFT BEHIND (review of #216). A Codex turn
   * that searched, wrote a narrating sentence and then failed on a quota or network error has events and
   * text and no result; counting that as a proven answer would record a half-finished message as research
   * and stop the chain from trying the next lane.
   */
  if (parsed.terminal === "failed") return { ok: false, error: `${displayName} reported an error before it finished: ${parsed.errorText.slice(0, 400) || "no reason given"}`, errorText: parsed.errorText };
  if (parsed.terminal !== "completed") {
    return { ok: false, error: `${displayName} ended without finishing its turn${parsed.errorText ? `: ${parsed.errorText.slice(0, 300)}` : ""}, so nothing it wrote was used.`, errorText: parsed.errorText };
  }
  if (!parsed.answer) return { ok: false, error: `${displayName} finished with no answer.` };
  if (parsed.events < 1) {
    return {
      ok: false,
      error: `${displayName} answered without running a single web search, so the answer was not used: a search call is believed only with searches counted in the CLI's own record.`,
    };
  }
  return { ok: true, output: parsed.answer, searchEvents: parsed.events, searchQueries: parsed.queries };
}
