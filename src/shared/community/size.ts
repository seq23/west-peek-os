/**
 * THE COMMUNITY SIZE: the one place any outreach, pitch, deck or prompt gets the number from.
 *
 * Source: the `west-peek` brain ("about 5,000", her confirmed figure, 22 Oct 2026; never "5,000+" or
 * "more than 5,000") and the risk brain (R-PRF-04 / R-EVT-03: community numbers to brands are
 * approximate and say so). The only measured count is the Network OS pull, 4,712 contacts on
 * 16 Sep 2026 (Community page, `communityOs.ts`), so "more than 5,000" overstated it to every brand
 * that read it (found 2 Nov 2026). "About 5,000" is true of 4,712; a floor at 5,000 is not.
 *
 * Stored text reads this too: `trueCommunityWords` is applied to Wynn's standing rules as they are
 * read and to every queued (unsent) brand email before it goes, so a row written with the old
 * words cannot carry them into a future send. Sent mail is history and is never rewritten.
 */
export const COMMUNITY_SIZE = 5000;
/** In a sentence: "a community of about 5,000 founders…". */
export const COMMUNITY_ABOUT = "about 5,000";
/** Where space is tight (the wheel in the PDF, a slide line): "~5,000". */
export const COMMUNITY_SHORT = "~5,000";

const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d{4,})`;
const FLOOR = String.raw`(?:more than|over|upwards of|at least|north of|in excess of|greater than)`;
const PEOPLE = String.raw`(?:[-\s]+(?:strong\s+)?(?:person|people|members?|founders?|operators?|investors?|creatives?|builders?|specialists?))`;
/** A head-count claim about the community: the number, how it is qualified, and the words it sits in. */
const CLAIM = new RegExp(
  String.raw`(?:(community(?:\s+of|:)\s+)(${FLOOR}\s+)?${NUM}(\+)?|(${FLOOR}\s+)?${NUM}(\+)?(?=${PEOPLE}))`,
  "gi",
);

/**
 * Every community head-count claim in `text` that says more than the source of truth: a number above
 * COMMUNITY_SIZE, or a floor at it ("more than 5,000", "5,000+", "over 5,000"). Money ("$5,000") and
 * counts of something else ("5,000+ visitors") are not community claims.
 */
export function overstatedCommunityClaims(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CLAIM)) {
    const at = m.index ?? 0;
    if (text[at - 1] === "$") continue;
    const floor = m[2] ?? m[5];
    const num = m[3] ?? m[6] ?? "0";
    const plus = m[4] ?? m[7];
    const n = Number(num.replace(/,/g, ""));
    if (n > COMMUNITY_SIZE || (n === COMMUNITY_SIZE && (floor || plus))) out.push(m[0].trim());
  }
  return out;
}

/** The same text with every overstated community count said the true way ("about 5,000"). */
export function trueCommunityWords(text: string): string {
  return text.replace(CLAIM, (whole, lead: string | undefined, floor, num, plus, floor2, num2, plus2, offset: number, all: string) => {
    if (all[offset - 1] === "$") return whole;
    const n = Number(String(num ?? num2).replace(/,/g, ""));
    if (!(n > COMMUNITY_SIZE || (n === COMMUNITY_SIZE && (floor || plus || floor2 || plus2)))) return whole;
    return `${lead ?? ""}${COMMUNITY_ABOUT}`;
  });
}

/**
 * WHAT A BRAND IS TOLD ABOUT THE COMMUNITY (owner, 6 Nov 2026: "do not overpromise on our community: just say we have
 * built a large community approaching 5000 people at its height … we can curate the room from our vast network … no
 * guarantees"). Brand-facing words never state a present size: the community GREW TO NEARLY 5,000 AT ITS HEIGHT, and
 * each room is curated from that network. COMMUNITY_ABOUT above stays for the firm's own and LP materials.
 */
export const BRAND_COMMUNITY_SHORT = "nearly 5,000 at its height";
export const BRAND_COMMUNITY_LINE = "We built a community that grew to nearly 5,000 founders, operators and creatives at its height, and we curate each room from that network.";
const PRESENT_SIZE = /\bcommunity of (?:about |around |roughly |~)?5,000((?:\s+[a-z]+,)*(?:\s+[a-z]+\s+and)?(?:\s+[a-z]+)?)/gi;

/** A present-tense community size in brand text ("community of about 5,000"): her 6 Nov rule says "grew to nearly 5,000 at its height". */
export const presentCommunitySize = (text: string): string[] => [...text.matchAll(PRESENT_SIZE)].map((m) => m[0].trim());

/**
 * Stored or queued brand text said the 6 Nov way: overstated counts first (trueCommunityWords), then the old drip proof
 * line and any "community of about 5,000 <who>" become "community that grew to nearly 5,000 <who> at its height".
 */
export function brandCommunityWords(text: string): string {
  return trueCommunityWords(text)
    .replace(/Our community of (?:about |~)?5,000 founders, operators and creatives meets in person through West Peek Rooms, our event series in New York\./g,
      `${BRAND_COMMUNITY_LINE} We meet in person through West Peek Rooms, our event series in New York.`)
    .replace(PRESENT_SIZE, (_m, who: string) => `community that grew to nearly 5,000${who} at its height`);
}
