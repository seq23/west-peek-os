/**
 * THE LEARNING CLUB'S TITLE-SPONSOR SHORTLIST AND WHAT WE DO NOT PITCH (owner, 23 Oct 2026; the
 * approved Rooms mock-up, v8). The shortlist is read from the title-sponsor research page
 * (TITLE_SPONSOR_RESEARCH_URL): brands with the money and a reason to present a whole room alone, which
 * Wynn works before his own picks. The way in is a ROLE, never a person's name or address: a named
 * contact comes only from a published page or from the owner, through "Needs a way in".
 *
 * NOT PITCHING is the research page's red-flag list (section 6), as the owner ruled on it. Prediction markets (Kalshi, Polymarket), Robinhood and full-body
 * scans are ALLOWED (her call, 23 Oct 2026) and must never appear on it; tests/roomsPages.test.ts
 * holds that. Betting is enforced in code by `sponsorMixProblems` in ./learningClub.ts.
 */

export const TITLE_SPONSOR_RESEARCH_URL = "https://claude.ai/artifact/7632jc1TJSg7wbMzMrYkbA";
export const TITLE_SPONSOR_RESEARCH_COUNT = 38;

export interface TitleSponsor {
  brand: string;
  /** Which club(s), and the way in: a role or a team, never a person. */
  fit: string;
  odds: "High" | "Medium";
}

export const TITLE_SPONSORS_TO_PITCH_FIRST: readonly TitleSponsor[] = [
  { brand: "Anthropic", fit: "March title · January backup (AI Tools for Your Work) · way in: its NYC brand events lead; pitch a “Claude Founder Night”, since NYC is the one city without its Founder House", odds: "High" },
  { brand: "Google for Startups / Cloud", fit: "March title, the Chelsea space in kind · way in: the NYC “Build with Gemini” workshop team", odds: "High" },
  { brand: "ElevenLabs", fit: "February backup (Find Your Voice) · it has an NYC role whose job is dinners and meetups", odds: "High" },
  { brand: "Neko Health", fit: "January title · its first US clinic opened in SoHo on 24 Sep", odds: "Medium" },
  { brand: "Oura", fit: "January title · ran its own SoHo pop-up in June 2026", odds: "Medium" },
  { brand: "Notion · Vercel", fit: "March title backups · both run NYC agent rooms", odds: "Medium" },
];

/** Anthropic and Google are never on the same night as another AI lab. */
export const TITLE_SPONSOR_RULE = "Anthropic and Google are never on the same night as another AI lab.";

export interface NotPitching { what: string; why: string }

export const NOT_PITCHING: readonly NotPitching[] = [
  { what: "Sportsbooks and casinos (DraftKings, FanDuel)", why: "Gambling. Out, and never beside a trading or investing brand." },
  { what: "Peptide sellers", why: "FDA warning letters to \u201cresearch use only\u201d peptide sellers, Dec 2024 and Dec 2025. Peptides stay a doctor-led segment of The Longevity Reset." },
  { what: "GLP-1 telehealth (Hims & Hers, Ro)", why: "The FDA's crackdown on compounded GLP-1s, Sep 2025 to Mar 2026." },
  { what: "Supplements as a paid tier on The Longevity Reset", why: "Health-claim exposure next to the doctor segment." },
  { what: "Whoop as The Longevity Reset's title", why: "FDA warning letter on its Blood Pressure Insights feature, 14 Jul 2025." },
  { what: "The Friend pendant", why: "The NYC subway-ad backlash, and little money left." },
  { what: "Alcohol on a health night", why: "A 21+ door that jars with The Longevity Reset. In kind only, and never on a health night." },
];

/** Allowed, by the owner's decision of 23 Oct 2026. Shown so nobody re-adds them to the list above. */
export const ALLOWED_BY_OWNER = "Prediction markets (Kalshi, Polymarket), Robinhood and full-body scans are allowed: your call, 23 Oct 2026.";
