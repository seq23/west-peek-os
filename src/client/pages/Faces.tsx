import { useRef } from "react";

/**
 * A faces strip — one object, several faces (design/DEALS_SECTION_DESIGN.md §2, artboard A).
 *
 * `.ic-tabs` carried an orange underline and no focus rule, no `aria-selected`, no keyboard order
 * (§1.1 #6). This is the replacement: `role=tablist` over `role=tab` buttons with a roving
 * tabindex, arrow keys and Home/End moving between faces, Enter/Space selecting, and a `.badge`
 * on a face that says what it holds — live · draft · empty — so a reader never opens a face to
 * find out it was blank.
 *
 * The strip scrolls inside itself on a phone (`.faces` is the declared inner scroller); the
 * document never scrolls sideways.
 */
export interface Face {
  key: string;
  label: string;
  /** What the face holds, in a word or two. Omitted when the face is simply the face. */
  badge?: { text: string; tone?: "ok" | "gate" | "bad" | "attention" };
  /** Rendered as `data-state` for the strip's error/success states (artboard A, block G). */
  state?: "error" | "success";
}

export function Faces({
  label,
  faces,
  active,
  onPick,
  idPrefix,
  testId,
}: {
  label: string;
  faces: readonly Face[];
  active: string;
  onPick: (key: string) => void;
  /** ids for `aria-controls` / `aria-labelledby`; the panel is `${idPrefix}-panel-${key}`. */
  idPrefix: string;
  testId?: string;
}): JSX.Element {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusAt(i: number) {
    const n = faces.length;
    const j = ((i % n) + n) % n;
    refs.current[j]?.focus();
    onPick(faces[j]!.key);
  }

  return (
    <div className="faces" role="tablist" aria-label={label} data-testid={testId}>
      {faces.map((f, i) => {
        const selected = f.key === active;
        return (
          <button
            key={f.key}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${f.key}`}
            className="face-tab"
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${f.key}`}
            tabIndex={selected ? 0 : -1}
            data-state={f.state}
            data-testid={testId ? `${testId}-${f.key}` : undefined}
            onClick={() => onPick(f.key)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") { e.preventDefault(); focusAt(i + 1); }
              else if (e.key === "ArrowLeft") { e.preventDefault(); focusAt(i - 1); }
              else if (e.key === "Home") { e.preventDefault(); focusAt(0); }
              else if (e.key === "End") { e.preventDefault(); focusAt(faces.length - 1); }
            }}
          >
            {f.label}
            {f.badge && (
              <span className={f.badge.tone ? `badge badge-${f.badge.tone}` : "badge"}>{f.badge.text}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a face opens. Hidden faces stay out of the tree so their controls are never reachable blind. */
export function FacePanel({
  idPrefix,
  face,
  active,
  children,
  testId,
}: {
  idPrefix: string;
  face: string;
  active: string;
  children: React.ReactNode;
  testId?: string;
}): JSX.Element | null {
  if (face !== active) return null;
  return (
    <div role="tabpanel" id={`${idPrefix}-panel-${face}`} aria-labelledby={`${idPrefix}-tab-${face}`} data-testid={testId}>
      {children}
    </div>
  );
}
