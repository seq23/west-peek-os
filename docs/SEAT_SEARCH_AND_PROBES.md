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

## 3 · Can a seat read a picture or a PDF? (phase 4 — probe, and now the transport it switches on)

```bash
node scripts/probes/seat-attachments-probe.mjs
```

Prints `PROVEN / FAILED / UNTESTED` for each seat and file type, **and writes what it proved to
`~/.west-peek-os/seat-attachments-proof.json`** (mode 0600). That file is the only thing that ever makes a seat
eligible for a file:

- the claimer re-reads it every cycle and declares `read_image:<seat>` / `read_document:<seat>` for exactly what is
  PROVEN, fresh (under 30 days) and true — nothing else, and no restart;
- the Worker (0249) offers a call that carries a picture or a PDF to a seat only when the awake device declared the
  capability for **every** kind the call carries; a seat without it is never parked the file and the call goes to
  the lanes that can see, as before;
- UNTESTED (a plan out of usage) changes nothing; FAILED withdraws an earlier proof; re-run after a CLI update.

How the bytes move: the Worker stores each file in R2 under `seat-attachments/<run id>/…` (max 5 files, 8 MB each,
16 MB in all; PNG/JPEG/GIF/WebP and PDF only), the queue row names them, the claimer that **holds** the run fetches
each from `GET /api/subscription-seats/attachment` into a private temp directory, runs the seat there, and deletes
the directory. The Worker deletes the R2 objects the moment the run ends, and the every-minute sweep deletes any
that were missed. A device that is not the holder, an unclaimed run and an ended run all get 404.

Codex gets pictures with `-i` and documents by path; Claude Code reads both by path with the Read tool — the same
invocation the probe proves, from one module (`scripts/lib/seat-attachments.mjs`).

**Not proven by any test:** that the live CLIs read a file this way on your Mac (this probe is the proof), and how a
large deck behaves against the queue's timings.

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

When Claude Code reports a spent plan and the phase falls to Codex, and Codex reports the same, the phase is **a
wait, not a failure**. The claimer reports `waits_seconds` — the time until the *earlier* of the two resets, read
from the notices' own words (an hour when neither says, never more than a week). The Worker then holds the card to
that moment: no attempt is charged, the card is not blocked, nobody is emailed, and the Work page shows
**"Waiting for reset"** with the time. The sweep leaves it alone until then and parks the same phase again by itself;
a plan still spent at that moment simply holds it again. A person pressing "Try it again now" starts it immediately.
A phase that failed any other way is still an attempt.

Applies to Porter's repo jobs (the web-property change phases). A Codex run that printed a notice and exited 0 is
still not taken as finished work.
