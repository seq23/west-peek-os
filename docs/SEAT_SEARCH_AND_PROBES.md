# Seat web search, and the three probes to run on the Mac (1 Oct 2026)

This is the runbook for what shipped in migration `0246` and what only the owner's Mac can settle.
Nothing below changes the repo. Everything marked **UNPROVEN** is labelled that way in
`IMPLEMENTATION_LEDGER.md` until the output has been read.

## 0 · Nothing changes until the claimer on the Mac is updated

The Worker will only hand a search call to a seat whose claimer says it can search. The claimer on the
Mac is the old version (agent version `1`, no capabilities), so after the deploy **behaviour is exactly as
before**: no seat is search-capable, and Parker's November Room still needs the spend lever on `MODERATE`.

To turn it on, on the Mac:

1. Update the checkout (`git pull` on `main`) and restart the claimer however it is run (the same way it
   was started before — this repo does not record the launchd label).
2. `node scripts/claimer/subscription-seat-claimer.mjs --doctor` must print `declares: web_search
   (agent version 2)`, list the seats, and exit 0.
3. `node scripts/claimer/subscription-seat-claimer.mjs --self-test` must pass (20 cases).

Then the Cockpit's seat status will show the seat as awake, and a search call at `FREE_ONLY` is served by it.

## 1 · Time a real search (UNMEASURED today)

The router waits up to **180 s** for a seat's search (`SEARCH_CLAIM_WAIT_MS`); the claimer kills a search
run at **240 s** (`SEARCH_RUN_TIMEOUT_MS`). Both are guesses — the first probe recorded no end time. Run the
real Parker prompt with `time` and adjust the two constants to what you see:

```bash
time codex exec --skip-git-repo-check --sandbox read-only --json -c web_search=live "$(cat ~/parker_prompt.txt)" > ~/codex_probe.jsonl 2> ~/codex_probe.err
```

## 2 · Claude Code's search leg (UNPROVEN — its plan was out of usage until 2 Oct, 8am Chicago)

After the reset, once:

```bash
claude -p "$(cat ~/parker_prompt.txt)" --allowedTools WebSearch,WebFetch --output-format stream-json --verbose > ~/claude_probe.jsonl
```

Look for `"name":"WebSearch"` tool calls in the stream and `web_search_requests` above 0 in the final usage.
"Permission to use WebSearch has been denied" would match an old upstream report (anthropics/claude-code#21091).
Until this is read, Codex is the only proven search seat; the claimer already declares both, and the Worker's
proof rule protects against a seat that does not actually search.

## 3 · Can a seat read a picture or a PDF? (phase 4 — probe only)

```bash
node scripts/probes/seat-attachments-probe.mjs
```

Prints `PROVEN / FAILED / UNTESTED` for each seat and file type. **Routing is not changed by this.** Seats are
still never offered an image or a document, and attachments still have no way to reach the Mac (the queue
carries text). Both would be built only after this reports PROVEN for a seat and type you want, and after
the privacy and size consequences of moving files through the queue are decided.

## 4 · The first supervised Codex repo job (phase 6)

```bash
node scripts/probes/codex-repo-job-probe.mjs
node scripts/probes/codex-repo-job-probe.mjs --remote https://github.com/seq23/west-peek-os.git   # also READ the real remote from inside the sandbox
```

Uses a throwaway repository and linked worktree under a temp directory, runs Codex with the exact flag set
the repo-work fallback uses, and checks from git — not from what the model says — that the file was written,
the commit landed (the `.git/worktrees` write), and the push reached a local remote. `--remote` is read-only.
It does **not** test an authenticated push to GitHub or pull-request creation; the first real Codex-served
job should still be watched.

## 5 · What "both seats spent" now looks like

When Claude Code reports a spent plan and the phase falls to Codex, and Codex reports the same, the phase
fails with a sentence naming **both** notices and their reset times (for example "resets Oct 2 at 8am"),
and a Codex run that printed a notice and exited 0 is not taken as finished work. It is a failure to be
retried after a reset, not a defect in the job.
