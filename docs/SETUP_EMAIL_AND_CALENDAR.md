# Turning on email and calendar

Two separate jobs with very different amounts left in them. Read the status line under each
heading before you start — one is nearly done, the other is not.

Everything here is done by a person, not by the OS, because each step needs either a credential
only you can create or a decision only you can make.

---

## Part 1 — Email

**Status: the plumbing is built, deployed and switched off. Three steps left, about fifteen
minutes.**

West Peek OS sends email through **Cloudflare Email Sending**, using a Worker *binding* rather
than an API key. That matters for one practical reason: there is no key to create, store or
rotate, and no third party in the path. The binding is already live on the production Worker —
you can see it as `env.EMAIL` — it simply refuses to send until the steps below are done.

Nothing here makes the OS start emailing people on its own. Every outbound message still needs a
human to approve that specific message first. These steps only decide whether an approved message
actually leaves the building or gets recorded and held.

### Step 1 — Let your API token manage Email Sending

Right now the token cannot. This is what the failure looks like:

```
$ npx wrangler email sending list
✘ Unauthorized [code: 2036]
```

The token works fine for everything else — it lists all 50+ zones without complaint — so this is
one missing permission, not a broken token.

1. Go to **dash.cloudflare.com → My Profile → API Tokens**
2. Find the token you use for West Peek OS and click **Edit**
3. Under **Permissions**, add:
   - `Account` · **Email Sending** · **Edit**
4. **Save**

> If you would rather not touch the token, skip to Step 2 and do it in the dashboard instead. The
> token only matters if you want to run the command-line version.

### Step 2 — Onboard the domain

Cloudflare will only send from a domain that has been explicitly onboarded. `westpeek.ventures`
is already an active zone on your account (id `36e5558b605f26547dce4ec9eddc39cf`), which is why
this is quick.

**Command line:**

```bash
npx wrangler email sending enable westpeek.ventures
```

**Or in the dashboard:** select the `westpeek.ventures` zone → **Email** → **Email Sending** →
follow the enable flow.

Because the domain's DNS is already on Cloudflare, the **SPF, DKIM and DMARC records are created
for you automatically**. You do not need to add DNS records by hand, and you should not — a
hand-written SPF record that conflicts with the generated one is the most common way to land in
spam folders.

Confirm it worked:

```bash
npx wrangler email sending list
```

`westpeek.ventures` should be listed. If it is not, nothing below will work.

### Step 3 — Turn sending on

Two settings. They are deliberately separate from the domain being ready, because a domain being
*capable* of sending is not a decision to *start* sending.

Add both to `[env.production.vars]` in `wrangler.toml`:

```toml
[env.production.vars]
WP_OS_EMAIL_FROM = "os@westpeek.ventures"
WP_OS_EMAIL_SEND = "enabled"
```

Then deploy:

```bash
npm run deploy:production
```

Notes worth knowing:

- These are **not secrets** — they are configuration, and keeping them in `wrangler.toml` means
  the switch is visible in the repo and in code review rather than hidden in a dashboard.
- `WP_OS_EMAIL_SEND` must be the literal string `enabled`. `true`, `yes` and `1` all leave it off.
  That is intentional: it should be impossible to switch on by accident.
- The address must be on the onboarded domain. The Worker is additionally restricted to sending
  **only** as `os@westpeek.ventures` (`allowed_sender_addresses` in `wrangler.toml`), so if you
  want a different address, change it in both places.

### Step 4 — Check it

Approve any outbound email in the OS. The receipt will tell you which of three things happened:

| What the receipt says | What it means |
|---|---|
| `Sent to … via Cloudflare from os@westpeek.ventures (msg-id)` | It went out. The id is checkable against Cloudflare's own log. |
| `Approved and recorded, NOT sent — …` | One of the switches is still off. The message names which. |
| The effect is marked `FAILED` | Cloudflare rejected it. Usually the domain is not onboarded. |

A rejected send never leaves an "executed" receipt behind, so the audit trail cannot claim a
message went out when it did not.

### If you would rather use Resend

The Resend transport still exists and still works. Set `RESEND_API_KEY` plus the same
`WP_OS_EMAIL_SEND=enabled`, and leave the Cloudflare settings alone. If both are configured,
Cloudflare is used — it needs no credential and adds no third party.

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
