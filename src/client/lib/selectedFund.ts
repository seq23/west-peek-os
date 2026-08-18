import { useCallback, useEffect, useState } from "react";
import { useApi } from "./api";

/**
 * Which fund the operator is currently looking at.
 *
 * WHY THIS EXISTS. Every fund-shaped surface reached for `funds[0]` — the thesis, the construction
 * policies, deal math, allocation. That is invisible while there is exactly one fund and silently
 * wrong the moment there are two: Fund II is raised alongside Fund I, not after it, so for a stretch
 * both are live and "the first one the query returned" is not an answer to which one you meant.
 * Worse, it fails quietly. You would edit the thesis and it would save — to the wrong fund.
 *
 * So the fund is an explicit, remembered choice, and the surfaces read it rather than guessing.
 *
 * THE PICKER APPEARS ONLY WHEN IT MEANS SOMETHING. With one fund there is no decision to make and
 * a chooser with a single option is furniture; the moment a second exists the switch appears and
 * the surfaces follow it. That is the whole "flip a switch and the UI changes" behaviour, and it
 * needs no migration or setting — creating Fund II is the switch.
 *
 * THE CHOICE IS PER-BROWSER, DELIBERATELY. It is a view preference, not firm state: which fund one
 * partner is reading says nothing the other needs, and storing it server-side would make two people
 * fight over one cursor. A stored id that no longer resolves — fund deleted, different machine —
 * falls back to the first fund rather than leaving the page blank.
 */

const STORAGE_KEY = "wpos.selectedFund";

export interface FundRow {
  id: string;
  name: string;
  status?: string;
}

function remembered(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // Private mode or storage disabled — the choice simply does not persist.
  }
}

function remember(id: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // Non-fatal: the selection still works for this session.
  }
}

/**
 * Which fund a remembered choice resolves to, given what actually exists.
 *
 * Pure and separate from the hook so the rule can be tested without a DOM — the rule is the part
 * that has to be right. A stored id that no longer resolves falls back to the first fund rather
 * than to null: a blank thesis page is a worse answer to "this browser remembers a fund you no
 * longer have" than showing the one you do.
 */
export function resolveFund(funds: readonly FundRow[], chosen: string | null): FundRow | null {
  return funds.find((f) => f.id === chosen) ?? funds[0] ?? null;
}

export interface SelectedFund {
  /** Every fund the firm has, newest last as the API returns them. */
  funds: FundRow[];
  /** The fund being looked at, or null while loading or before any fund exists. */
  fund: FundRow | null;
  /** True once more than one fund exists — the point at which choosing means anything. */
  hasChoice: boolean;
  loading: boolean;
  select: (id: string) => void;
  reload: () => void;
}

export function useSelectedFund(): SelectedFund {
  const funds = useApi<{ funds: FundRow[] }>("/api/funds");
  const [chosen, setChosen] = useState<string | null>(() => remembered());

  const list = funds.data?.funds ?? [];

  // A remembered id that no longer resolves must not blank the page — it usually means this
  // browser is looking at a firm it has not seen before, which is a fine thing to recover from.
  const resolved = resolveFund(list, chosen);

  useEffect(() => {
    if (resolved && resolved.id !== chosen) {
      setChosen(resolved.id);
      remember(resolved.id);
    }
  }, [resolved, chosen]);

  const select = useCallback((id: string) => {
    setChosen(id);
    remember(id);
  }, []);

  return {
    funds: list,
    fund: resolved,
    hasChoice: list.length > 1,
    loading: funds.loading && !funds.data,
    select,
    reload: funds.reload,
  };
}
