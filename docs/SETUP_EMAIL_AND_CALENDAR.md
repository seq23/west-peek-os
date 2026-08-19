# Turning on email and calendar

Two separate jobs with very different amounts left in them. Read the status line under each
heading before you start — one is nearly done, the other is not.

Everything here is done by a person, not by the OS, because each step needs either a credential
only you can create or a decision only you can make.

---

## Part 1 — Email

**Status: the plumbing is built and switched off. Three steps left, about twenty minutes, no
recurring cost.**

### Why not Cloudflare

The original plan was Cloudflare Email Sending, because it is a Worker binding — no API key to
create, store or rotate, and no third party in the path. That plan is dead for now:

> Email Sending is currently only available with the Workers Paid plan.

The transport is written and tested and the binding is commented out of `wrangler.toml` with the
reason attached. If you ever go to Workers Paid, uncomment it, run
`wrangler email sending enable westpeek.ventures`, and it takes over automatically.

Leaving the binding deployed would have been actively harmful, not merely useless: the executor
prefers Cloudflare whenever the binding is present, so an unusable binding would have captured
every send and failed it while Resend sat configured and unused.

### What we use instead

**Resend**, which has been in this repo since the outbound channel was first built. Its free tier
is **3,000 emails a month and 100 a day, with one custom domain** — far beyond what this fund
sends. The transport is on the egress allowlist and covered by tests.

Nothing below makes the OS start emailing people on its own. Every outbound message still needs a
human to approve that specific message. These steps only decide whether an approved message leaves
the building or gets recorded and held.

### Step 1 — Create a Resend account and verify the domain

1. Sign up at **resend.com** (free plan, no card).
2. **Domains → Add Domain** → `westpeek.ventures`.
3. Resend shows you DNS records to add — an SPF/`MX` pair and a DKIM `TXT`.
4. Add them in Cloudflare: the `westpeek.ventures` zone → **DNS** → **Add record**, copying each
   exactly.
   - **Set each one to DNS only (grey cloud), not proxied.** A proxied mail record does not work,
     and this is the single most common way this step fails.
5. Back in Resend, click **Verify**. It usually completes in a few minutes.

Verification is what lets you send *as* `westpeek.ventures`. Without it you can only send from
Resend's own test domain, which is fine for a smoke test and not fine for LPs.

### Step 2 — Create an API key

**API Keys → Create API Key.** Give it **Sending access** only, not full access — this key lives in
a Worker and should not be able to reconfigure your domains.

Copy it once; Resend will not show it again.

### Step 3 — Give it to the Worker and turn sending on

The key is a secret and goes into Worker secret storage:

```bash
npx wrangler secret put RESEND_API_KEY --env production
```

The other two are configuration, not secrets, so they go in `wrangler.toml` where the switch is
visible in the repo and in review:

```toml
[env.production.vars]
WP_OS_EMAIL_FROM = "os@westpeek.ventures"
WP_OS_EMAIL_SEND = "enabled"
```

Then deploy:

```bash
npm run deploy:production
```

Two things worth knowing:

- `WP_OS_EMAIL_SEND` must be the literal string `enabled`. `true`, `yes` and `1` all leave it off.
  That is intentional — it should be impossible to switch on by accident.
- The address must be on the verified domain. `os@westpeek.ventures` needs no mailbox behind it to
  send; give it one only if you want replies to land somewhere.

### Step 4 — Check it

Approve any outbound email in the OS. The receipt tells you which of three things happened:

| What the receipt says | What it means |
|---|---|
| `Delivered to … via Resend` | It went out. |
| `Approved and recorded, NOT sent — …` | A switch is still off. The message names which. |
| The effect is marked `FAILED` | Resend rejected it. Usually the domain is not verified yet. |

A rejected send never leaves an "executed" receipt behind, so the audit trail cannot claim a
message went out when it did not.

### On cost

Resend free covers this comfortably. If volume ever passes 3,000 a month, Resend's paid tier and
Cloudflare's Workers Paid plan are within a few dollars of each other — at that point the binding
is the better choice, because it removes a credential and a vendor.

---

## Part 2 — Calendar

**Status: this one is not close. The credentials below are a real prerequisite, but setting them
does not produce a working calendar — the connection flow itself still has to be built.**

Please read that twice, because the OS currently makes it look nearer than it is. There is a
readiness check that goes green when the two Google credentials are present, and a Home surface
that reports whether each partner is connected. What does **not** exist yet is the part in
between: the redirect to Google, the consent handoff, the token exchange, the refresh, and the
sync itself. Setting the credentials will flip the indicator to "connectable" and pressing
Connect will still not do anything.

So the honest sequence is: do Steps 1–4 when convenient, then a build step, then Step 5.

### Step 1 — Create the Google Cloud project

1. Go to **console.cloud.google.com**
2. **New Project** → name it `West Peek OS` → **Create**
3. Make sure it is selected in the project picker at the top

### Step 2 — Enable the APIs

**APIs & Services → Library**, then enable:

- **Google Calendar API** — required
- **Gmail API** — only if you also want mail read through Google rather than Cloudflare. If email
  is going through Cloudflare (Part 1), you do not need this.

### Step 3 — Configure the consent screen

**APIs & Services → OAuth consent screen**

- **User type: Internal** if `westpeek.ventures` is a Google Workspace domain. Choose this if you
  can — it skips Google's verification review entirely.
- **External** otherwise. This works, but while the app is in "Testing" you must add each partner
  as a test user, and tokens expire every 7 days, which is genuinely annoying. Publishing to
  Production removes that but triggers a review.

Fill in: app name `West Peek OS`, your support email, and `joinwestpeek.com` as the authorized
domain.

Scopes to request — ask for the narrowest that does the job:

| Scope | Why |
|---|---|
| `.../auth/calendar.readonly` | Read the diary. Enough for "what you are walking into today". |
| `.../auth/calendar.events` | Only if the OS should *create* events, not just read them. |
| `.../auth/userinfo.email` | So the OS can label which account got connected. |

Start with `calendar.readonly`. It is much easier to widen a scope later than to explain to a
reviewer why a fund needs write access to a calendar.

### Step 4 — Create the OAuth client

**APIs & Services → Credentials → Create Credentials → OAuth client ID**

- **Application type:** Web application
- **Name:** `West Peek OS`
- **Authorized redirect URI:**
  ```
  https://os.joinwestpeek.com/api/connections/google/callback
  ```

That path does not exist yet — it is the one the build step below should create. Registering it
now is fine and saves a second trip.

Copy the **Client ID** and **Client Secret**.

### The build step — what is actually missing

Before Step 5 means anything, the following has to be written:

1. **A start route** that redirects the partner to Google with the right scopes and a signed
   `state` parameter, so the callback can prove the response belongs to the person who started it.
2. **The callback route** at the URI above: exchange the code for tokens, and store them per
   `firm_user` — the schema already models this correctly, since Scooter connecting his calendar
   says nothing about yours.
3. **Refresh handling.** Google access tokens are short-lived. Without this it works for an hour
   and then quietly stops, which is worse than not working at all.
4. **The actual read**, feeding today's events into the morning brief.
5. **Disconnection**, including revoking at Google's end rather than only forgetting locally.

Points 1 and 2 also need a decision from you: Google is an external service, so the tokens and
the calendar contents have to be given a sensitivity label, and the privacy mode has to permit
them. That is a governance decision, not a coding one, which is why it is listed here rather than
buried in an implementation.

### Step 5 — Set the credentials

Once the flow exists:

```bash
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID --env production
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET --env production
```

These **are** secrets, unlike the email settings, so they go in Worker secret storage and never
into `wrangler.toml`.

One client covers both partners. Each of you still connects your own Google account separately —
the connection is per person, and the OS is explicit about that rather than showing a single
firm-level "connected" flag that would be a lie about whose diary it can see.

### Step 6 — Connect

Home → the connect control for your account → Google consent → back to the OS. Repeat for the
second partner from their own login.

---

## Quick reference

| | Email | Calendar |
|---|---|---|
| **Provider** | Cloudflare Email Sending | Google |
| **Credential** | None — it is a Worker binding | OAuth client id + secret |
| **Built?** | Yes, deployed and inert | Readiness check only; flow not built |
| **Your steps** | Token permission → onboard domain → two settings | Google project → APIs → consent → client |
| **Blocked on** | You | A build step, then you |
| **Where it shows** | Approval receipts | Home, per partner |

## The order I would do them in

1. **Email, now.** It is three steps and it unblocks LP outreach, event invitations and follow-up
   routing — all of which currently get recorded and then wait for someone to copy them into
   Gmail by hand.
2. **The Google project, whenever.** Ten minutes, and it means the credentials are sitting there
   when the flow is ready.
3. **The calendar flow, deliberately.** It is the larger piece and it needs the privacy-label
   decision made first, not discovered halfway through.
