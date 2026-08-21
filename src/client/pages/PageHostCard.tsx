import { useApi } from "../lib/api";
import { portraitAlt, portraitFor } from "../lib/employeePortraits";
import { pageHost } from "@shared/help/pageHosts";
import { personaFor } from "@shared/registry/aiEmployeePersonas";

/**
 * Who runs this page.
 *
 * Operator direction, 21 Aug 2026: every tab in Deals, Firm and Learn needs a host employee whose
 * picture, name and title are among the first things you see, linked to the machine they are
 * responsible for.
 *
 * NOT ON ADMIN, and that is the rule rather than an omission. Deals, Firm and Learn are rooms where
 * somebody does work on the firm's behalf and where a partner reasonably asks who is on it. Admin is
 * machinery that reports on the system itself, and a colleague's face over a spend table implies a
 * judgement nobody is making. `pageHost` returns null there, and this renders nothing.
 *
 * THE STATUS IS LIVE, AND IT IS THE POINT. Home already gives INACTIVE employees cheerful bylines —
 * Winter reports "no open alerts on anything you own" and has never been hired. A face over a page
 * nobody is working answers "is anyone on this?" with a lie, which is worse than leaving it unsigned.
 * So the roster supplies who it WOULD be and the database supplies whether they are actually
 * employed, and when they are not the card says so plainly instead of smiling.
 */

interface LoungeEmployee {
  name: string;
  status: string;
}

export function PageHostCard({ navKey }: { navKey: string }) {
  const host = pageHost(navKey);
  // One request, cached by the hook per path — every hosted page reads the same roster.
  const lounge = useApi<{ employees: LoungeEmployee[] }>(host ? "/api/workforce/lounge" : null, [navKey]);

  if (!host) return null;

  const live = (lounge.data?.employees ?? []).find((e) => e.name === host.name);
  const status = live?.status ?? null;
  const working = status === "ACTIVE";
  const portrait = portraitFor(host.name);

  return (
    <section className="card professor-welcome" data-testid={`page-host-${navKey}`}>
      {portrait ? (
        <img className="professor-face" src={portrait} alt={portraitAlt(host.name, host.role)} loading="lazy" />
      ) : (
        <span className="professor-face professor-face-initial" aria-hidden="true">
          {host.name.slice(0, 1)}
        </span>
      )}
      <div>
        <p>
          <strong>{host.name}</strong> <span className="muted small">{host.role}</span>
        </p>
        <p className="small">{host.because}</p>

        {/*
          Said plainly rather than shown as a badge. "Switched off" is a fact a partner acts on —
          it means nothing on this page is being worked — and a coloured pill invites them to skim
          past it.
        */}
        {status && !working && (
          <p className="notice notice-gate small" data-testid={`page-host-idle-${navKey}`}>
            {host.name} is {status.toLowerCase()}, so nobody is working this page. Employ them on Employees to change that.
          </p>
        )}
        {!status && !lounge.loading && (
          <p className="muted small" data-testid={`page-host-unknown-${navKey}`}>
            Whether {host.name} is employed could not be read just now, so treat this page as unattended.
          </p>
        )}

        {working && personaFor(host.name)?.voice && (
          <p className="muted small">{personaFor(host.name)!.voice}</p>
        )}

        {/* The link to the back end the operator asked for: the machines this seat is responsible
            for, which is where their methods and queue live. */}
        {host.machineKeys.length > 0 && (
          <p className="muted small" data-testid={`page-host-machines-${navKey}`}>
            Responsible for {host.machineKeys.map((m) => m.split("_").join(" ")).join(", ")}.
          </p>
        )}
      </div>
    </section>
  );
}
