import { useId, useState } from "react";

/**
 * The contextual-help primitive (P26 §3).
 *
 * One accordion, used on every operational page, answering the same seven questions in the same
 * order. The order is the point: an operator who has read one of these knows where to look in all
 * the others, and a page author cannot quietly omit "why is this blocked" because the shape of the
 * component asks for it.
 *
 * Two deliberate choices:
 *
 *   COLLAPSED BY DEFAULT — an operator who already knows the page should not have to scroll past
 *   an explanation of it. Help that cannot be dismissed becomes furniture people stop reading.
 *
 *   NATIVE DISCLOSURE SEMANTICS — a real <button aria-expanded> controlling a real region, not a
 *   div with a click handler. Keyboard and screen-reader behaviour comes from the platform rather
 *   than from us remembering to re-implement it.
 *
 * This component states what the product DOES. It must never be used to describe an integration as
 * working when the readiness surface says otherwise; where behaviour depends on configuration, say
 * so in `blocked` and let the page render the real state.
 */
export interface HowThisWorksProps {
  /** Plain-language name of the surface. Not the internal route key. */
  title: string;
  /** 1 · What this page is. */
  what: string;
  /** 2 · When the operator should use it. */
  when: string;
  /** 3 · What the operator normally does here. */
  operatorDoes: string[];
  /** 4 · What AI can do here. */
  aiDoes: string[];
  /** 5 · What requires the operator (never automated away). */
  requiresOperator: string[];
  /** 6 · What happens next. */
  next: string;
  /** 7 · Why something may be blocked. */
  blocked: string[];
  /** Stable hook for tests and deep links, e.g. "approvals". */
  testId: string;
}

export function HowThisWorks(props: HowThisWorksProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const regionId = useId();

  return (
    <section className="hint" data-testid={`how-this-works-${props.testId}`}>
      <button
        type="button"
        className="hint-toggle"
        aria-expanded={open}
        aria-controls={regionId}
        data-testid={`how-this-works-toggle-${props.testId}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span>How this works — {props.title}</span>
        <span className="hint-mark" aria-hidden="true">
          {open ? "−" : "+"}
        </span>
      </button>

      <div id={regionId} className="hint-body" hidden={!open} data-testid={`how-this-works-body-${props.testId}`}>
        <dl className="hint-list">
          <dt>What this is</dt>
          <dd>{props.what}</dd>

          <dt>When to use it</dt>
          <dd>{props.when}</dd>

          <dt>What you normally do here</dt>
          <dd>
            <ul>
              {props.operatorDoes.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </dd>

          <dt>What AI can do here</dt>
          <dd>
            {props.aiDoes.length === 0 ? (
              <span className="hint-none">Nothing on this page is automated.</span>
            ) : (
              <ul>
                {props.aiDoes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </dd>

          <dt>What needs a Managing Partner</dt>
          <dd>
            {props.requiresOperator.length === 0 ? (
              <span className="hint-none">Nothing here requires an approval.</span>
            ) : (
              <ul>
                {props.requiresOperator.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </dd>

          <dt>What happens next</dt>
          <dd>{props.next}</dd>

          <dt>Why something may be blocked</dt>
          <dd>
            <ul>
              {props.blocked.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </dd>
        </dl>
      </div>
    </section>
  );
}
