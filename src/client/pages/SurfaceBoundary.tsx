import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * ONE PAGE'S FAULT IS ONE PAGE'S FAULT — never the shell's.
 *
 * WHAT WENT WRONG, 19 Sep 2026, CI on `main` (run 35457328146, the p42 sign-out journey): she
 * signed in, Home mounted, and she pressed Sign out before Home's children had sent their first
 * reads. Those reads then went out without an identity, came back 401 with `{error}` bodies, and
 * four children read `data.connections.length`, `data.firm.themes`, `run.button.enabled` and
 * `data.deliverables.map` off them. One threw; React 18 unmounts the WHOLE tree on an uncaught
 * render error, so `#root` went empty — no identity line, no Sign out, and the signed-out page
 * could never appear. A coin flip on a slow runner, reproduced deterministically by routing any
 * one of those reads to a 401 (`e2e/p42-session.spec.ts`).
 *
 * Two fixes, both structural. `useApi` now hands `data` only for a 2xx, so a refusal is never
 * mistaken for the shape a page expects. And this boundary sits around the surface: if a page
 * still throws, the page says so in its own place and the shell — the identity, Sign out, the nav
 * — stays. Keyed on the route by the caller, so moving to another page clears the fault.
 */
export class SurfaceBoundary extends Component<{ label: string; children: ReactNode }, { fault: string | null }> {
  override state = { fault: null as string | null };

  static getDerivedStateFromError(error: unknown): { fault: string } {
    return { fault: error instanceof Error ? error.message : String(error) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    // The console is where a developer looks; the page is where she looks. Both get it.
    console.error("surface fault", this.props.label, error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.fault) {
      return (
        <section className="notice notice-bad" role="alert" data-testid="surface-fault">
          <strong>{this.props.label} hit a fault and stopped drawing.</strong> {this.state.fault}. The rest of West Peek OS is
          unaffected: the other pages work, and so does Sign out. Reload this page to try it again.
        </section>
      );
    }
    return this.props.children;
  }
}
