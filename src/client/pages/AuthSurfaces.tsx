import { useState } from "react";
import { setDevUser } from "../lib/api";

/**
 * The signed-out surfaces (P42): the door in, and the door out.
 *
 * These are the only two screens someone sees before the system will tell them anything, so they
 * carry the brand rather than being a bare form on a white page. They also have to be HONEST about
 * an unusual property of this system: it shows nothing at all until it knows who is asking, which
 * looks like a broken page unless you say why.
 */

function BrandLockup({ tagline }: { tagline: string }): JSX.Element {
  return (
    <div className="auth-brand">
      <img src="/wp-mark.svg" alt="" width={44} height={44} />
      <div>
        <p className="auth-wordmark">West Peek OS</p>
        <p className="auth-tagline">{tagline}</p>
      </div>
    </div>
  );
}

/** The sign-in surface. Local mode only — production identity comes from Cloudflare Access. */
export function SignInCard({ onLogin }: { onLogin: () => void }): JSX.Element {
  const [email, setEmail] = useState("");
  return (
    <div className="auth-shell" data-testid="auth-shell">
      <section className="card auth-card" data-testid="dev-login">
        <BrandLockup tagline="The operating system for West Peek Ventures" />

        <h3>Sign in</h3>
        <p className="muted small">
          Nothing is shown until the system knows who is asking — not a blank state, a deliberate
          one. Your identity decides what you can see and what you are allowed to approve.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (email.trim()) {
              setDevUser(email.trim());
              onLogin();
            }
          }}
        >
          <div className="form-row">
            <label>
              Email
              <input
                data-testid="dev-login-email"
                type="email"
                value={email}
                placeholder="you@westpeek.ventures"
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          </div>
          <button type="submit" className="btn-strong" data-testid="dev-login-submit">
            Sign in
          </button>
        </form>

        <p className="muted small auth-foot">
          In production, sign-in is handled by Cloudflare Access before this page loads. This form
          stands in for it in local mode.
        </p>
      </section>
    </div>
  );
}

/**
 * The signed-out landing page.
 *
 * Exists because "sign out" that drops you back on a login form gives no confirmation anything
 * happened — the two screens look nearly identical, and the operator is left unsure whether they
 * actually left. This states plainly that the session is over.
 */
export function SignedOutPage({ onSignIn }: { onSignIn: () => void }): JSX.Element {
  return (
    <div className="auth-shell" data-testid="signed-out-page">
      <section className="card auth-card">
        <BrandLockup tagline="Signed out" />

        <h3>You are signed out</h3>
        <p>
          Your session has ended and this browser no longer holds an identity. Nothing about the
          firm is visible from here.
        </p>
        <p className="muted small">
          Anything you were part-way through is saved — West Peek OS keeps work on the server, not
          in the page. Sign back in and it will be where you left it.
        </p>

        <button type="button" className="btn-strong" data-testid="signed-out-signin" onClick={onSignIn}>
          Sign back in
        </button>
      </section>
    </div>
  );
}
