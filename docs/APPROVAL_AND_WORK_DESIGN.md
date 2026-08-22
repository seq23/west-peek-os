# Work cards, approvals, and standing authority

**Decided 22 Aug 2026.** The operator asked for this to be designed rather than put to her:
*"u decide how this all goes and put on your expert hat."* This document is the reasoning; the ADR
records the architectural half and the migrations implement it.

---

## The framing, which decides everything else

**This is delegated authority. It is not "dismissing approvals."**

Every fund already solves this problem and none of them call it dismissal. An LPA gives the GP
authority to act within stated limits without going back to the LPs. A board delegates spending
authority up to a threshold. A trading desk gives each trader a daily limit. In each case the same
three things are true: the delegation has a **scope**, a **limit**, and an **expiry**, and it is
revocable.

That framing is load-bearing because it tells you immediately what is safe and what is not:

- A delegation always carries all three bounds. Missing any one is exactly how a reasonable
  arrangement becomes a dangerous one.
- **Judgment cannot be delegated.** You can delegate "spend up to $5,000 on cloud hosting". You
  cannot delegate "decide whether we invest." The first is authority; the second is the job.

Everything below follows from those two sentences.

---

## What the queue is actually for

The purpose of an approval is to put a **decision that is genuinely yours** in front of you at the
moment it can still change the outcome. Every card that is not that makes the queue worse, because
attention is the scarce resource and a long queue is read by skimming.

So the first question is never "should this be approved?" It is **"is this a decision, or is it
paperwork wearing a decision's clothes?"**

Production today holds **17 approval cards, all of them from commissioning**, and 4 work cards. So
this is a design being written before the problem arrives rather than after — which is the only time
it can be written honestly, because nobody is yet annoyed enough to want the wrong fix.

---

## The classification

Three questions, asked in order. They are deliberately about consequence rather than about how
important the thing feels.

1. **Is it reversible?**
2. **Does it leave the building** — reach a person, a system, or a market outside this firm?
3. **Does it move money or bind the firm** to something?

### Tier 1 · Never approved

*Reversible, internal, and costs nothing material.* No card, ever, for anybody — human or AI.

Opening a work card. Moving a card between states. Drafting anything at all. Reading, searching,
researching. Recording a fact with its provenance. Proposing or recommending.

The mistake almost every system of this kind makes is asking about these, because they *feel* like
actions. A draft commits nothing. A proposal commits nothing. **A card here is pure interruption,
and it is the main way an approval queue becomes something people stop reading.**

This is also why `work_card.create` is, and stays, an ordinary internal action available to any
actor including an AI employee. Opening a card only says *this needs doing*. The governance bites on
what the card then does.

### Tier 2 · Always approved, and never delegable

*Irreversible, or external, or it moves money, or it binds the firm.*

The 53 human-reserved actions and the 4 external effects. Investment decisions, valuations, LP
commitments, legal conclusions, anything that sends mail or posts to an outside system.

**Standing authority can never cover a Tier 2 action. This is the rule that makes the rest of the
design safe**, and it is enforced in `authorize()` rather than in the interface, because an
interface rule is a suggestion. These actions are reserved precisely because the judgment is the
work; a standing "stop asking me" here is the fund abdicating the thing it exists to do.

It is also what protects the operator's own stated line — no AI employee emails anyone yet. A
standing grant that could reach `effect.email.send` would quietly undo that.

### Tier 3 · Approved, and delegable within bounds

What is left: internal actions that are consequential but not reserved. The answer is almost always
yes, and the friction is the real cost.

This is the only tier where standing authority applies, and it is where the operator's request lives.

---

## Standing authority: the three bounds

A grant is refused unless it carries all three.

| Bound | Means | Why |
|---|---|---|
| **Scope** | One action key, optionally narrowed to a single object | "Approve this kind of thing" is a policy; "approve everything" is an abdication |
| **Limit** | A maximum number of uses | Bounds the damage of a wrong grant without needing anybody to notice it was wrong |
| **Expiry** | End of this task, end of today, or end of this week | Returns the authority to you by default |

### Why expiry-by-default is the actual safety feature

A standing grant with no expiry becomes permanent through neglect. Nobody revokes it, because
revoking requires first remembering that it exists — and the whole reason it was granted is to stop
thinking about the thing.

Expiry inverts that. The default is that authority comes back to you, and *continuing* it takes a
deliberate act. Nothing has to be remembered for the system to become safe again. That is how a
trading limit works, and it is why they are set per day rather than per trader.

**"Until this task is done" is the best of the three and is the default offering.** Its lifetime is
bounded by something real — the work card closing — rather than by a clock that keeps running while
you are asleep. When the work is finished the authority is gone, without anybody deciding it should
be.

### What is deliberately not built

- **No "approve everything today" button.** That is not delegation, it is abdication, and it is the
  single control most likely to turn a bad day into an unrecoverable one.
- **No silent "remember this choice" checkbox.** Standing authority is a thing the firm has granted.
  It is named, attributed, on the event spine, and listed somewhere you can see and revoke it. A
  checkbox that quietly creates permanent authority is how a governance system stops being one.
- **No grant without a reason.** The reason is what makes it reviewable later, and typing it is the
  half-second that makes somebody ask whether they mean it.

---

## Work-card volume: two different problems, deliberately separated

The operator asked whether there is "a threshold that makes sense for cutting off work cards."
There are two questions inside that and conflating them produces the wrong control.

### Duplicates are a correctness rule, always on, not a threshold

The same employee opening the same card twice is never intended. It is a retry, a re-read of the
same inbox, or a job that ran twice. So it is not a threshold at all — it is uniqueness: **at most
one open card per (machine, object, owner).**

The second attempt must **join the existing card rather than fail.** An employee told "denied,
duplicate" will simply reword the title and file it anyway, which converts a clean duplicate into a
dirty one. Adding to the existing card keeps the pipeline honest.

This must not be implemented with `INSERT OR IGNORE`, which would swallow the collision silently —
the failure this repo has already shipped twice.

### Volume is a health signal, not a permission

An employee opening forty cards in an hour is not exercising judgment the firm needs to review. **It
is looping.** So the right response is to stop that employee and tell both partners — not to queue
forty approvals, which delivers the flood to the operator rather than stopping it.

That distinction is the whole point. A permission gate on volume would make the runaway *her*
problem; a health signal makes it the system's problem and merely informs her.

**The numbers, and why they are not delicate.** A working AI employee on a real queue opens
something like 5–15 cards a day. A loop produces hundreds in an hour. The gap between those is two
orders of magnitude, so the threshold does not need to be tuned — it needs to sit in the canyon
between them:

- **20 cards per employee per rolling hour** trips the circuit. Roughly a day's honest work arriving
  in an hour, which is the earliest point at which "this is not normal" is certainly true.
- **60 open cards held by one employee** is a standing ceiling. Nobody works sixty things.

Both stop that employee's card-opening and escalate through `healthEscalation.ts`, which already
only reports what persists, tells both partners once, and announces recovery.

### A long approval queue is a bug report, not a to-do list

The inversion worth building. Research on alert fatigue is consistent and unkind: review quality
collapses long before volume feels overwhelming, and people begin batch-approving while believing
they are still reading.

For two partners sharing one queue, **more than 10 cards pending at once means the classification is
wrong**, not that the partners are behind. Diagnostics therefore reports a persistently long queue
as a finding *about the design* — naming which action keys are generating the volume, so the fix is
to reclassify them rather than to work harder.

---

## What this changes for the operator, concretely

On an approval card she now gets, alongside Approve:

> **Approve, and don't ask again —** *until this task is done* · *for the rest of today* · *for the
> rest of this week*

with a required one-line reason. Tier 2 cards do not offer it at all, and the card says why in a
sentence rather than hiding the control.

Everything granted is listed in one place with who granted it, why, how many uses remain, when it
expires, and a revoke button. Revocation is immediate and needs no reason — stopping is always safe,
which is the same rule that already governs pausing an employee.

---

## The duty roster: how it works, and what you can change

**The default is code, deterministic, and deliberately not decided by a model.** `dutyRoster.ts`
divides the day into four shifts — Morning 5–12, Midday 12–17, Evening 17–22, Overnight 22–5 — and
names who is on each, with a written reason per person ("Willow: the compliance check that should
notice a problem at 3am"). `shiftForHour()` maps the clock to a shift. Everyone not on duty is shown
as **benched**, never hidden: silence from a named colleague is information.

Its own docstring says why a model does not decide this: *"who should be on duty at 2pm looks like a
judgement call and is not"* — it is a mapping from time of day to the work that happens then, and a
partner must be able to **predict it, disagree with it, and change it.** A model would make it
unpredictable and unarguable, which are the two properties a rota must not have.

**Employment is not duty.** Everyone on the roster is employed (migration 0136). Duty decides who is
being leaned on right now. Conflating them meant hiring somebody to hear from them and firing them to
get quiet.

### What the operator can change

Requested 22 Aug 2026: *"i want a default flow and one that i can change in the admin section — i
should be able to adj hours for an employee."*

**The database stores only DIFFERENCES from the code default.** Not a copy of the roster: the module
warns that a second roster is a second source of truth, and a table that duplicated it would drift
from the registry within a month. Storing only overrides means the default keeps working with its
written reasons intact, a newly seated employee inherits a sensible shift with no action, the page
can distinguish *this is the default* from *you changed this*, and **reverting is deleting a row**
rather than restoring a remembered value.

Two kinds, both per employee, in strict precedence:

1. **Custom hours** — an explicit local from/to for one person, superseding the shift model entirely.
2. **On or off for a given shift** — the common case.
3. **The code default** — everything not overridden.

Every override records who set it, when, and why. A rota that changed for reasons nobody wrote down
cannot be reviewed later, which is the same rule that governs every other authority change here.
