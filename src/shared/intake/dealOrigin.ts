import { PARTNER_EMAILS } from "../registry/partners";

/**
 * WHAT IS A DEAL, AND HOW DID IT REACH US — the two calls the email door makes before anything is
 * opened in the funnel (owner, 26 Oct 2026).
 *
 * 1 · AN ADMIN OR WEBSITE EMAIL IS NEVER A DEAL. "Sensori photo swap on westpeek.ventures" — a
 *     partner asking Porter to change a photo on the firm's own site — arrived oversize, took the
 *     deck path, and became an investment opportunity named after the request. The subject is what
 *     says what a message is about; a partner's signature puts the firm's domain in every BODY, so
 *     only the subject (and the name about to be opened) is read.
 *
 * 2 · A PERSON'S WARM INTRO IS A COMMUNITY INTRO. Every company the firm has looked at reached it
 *     through someone in its community. An emailed deal a partner forwards reached that partner
 *     personally; one whose message introduces a founder ("introducing", "connect you with") came
 *     through the person introducing them. Both are COMMUNITY_INTRO. Only a message nobody vouched
 *     for — a founder writing to the intake address cold — stays INBOUND.
 */

const ADMIN_OR_WEBSITE =
  /\b(?:(?:on|to|for|from) (?:the|our) (?:web\s?site|site|landing page)|web\s?site (?:change|update|fix|edit|copy|photo)|site (?:change|update|fix|edit|copy)|(?:photo|picture|image|headshot|logo) swap|swap (?:the|a|our|his|her) (?:photo|picture|image|headshot|logo)|update (?:the|our) (?:site|page|bio|form)|invoice|receipt|password reset|unsubscribe|calendar invite|westpeek\.ventures|joinwestpeek\.com)\b/i;

export function isAdminOrWebsiteSubject(subject: string): boolean {
  return ADMIN_OR_WEBSITE.test(subject ?? "");
}

const WARM_INTRO = /\b(?:introduc(?:e|ing|tion)|intro(?:ducing)?\s+(?:you|to)|connect(?:ing)? you (?:two|with|to)|meet [A-Z][a-z]+|wanted you (?:two )?to meet|referred (?:me|by)|recommended (?:I|that I) reach out|suggested I (?:reach out|email))\b/i;

export function emailDealOrigin(input: { from: string; text: string }): "COMMUNITY_INTRO" | "INBOUND" {
  const from = (input.from ?? "").trim().toLowerCase().replace(/^.*<|>.*$/g, "");
  if ((PARTNER_EMAILS as readonly string[]).includes(from)) return "COMMUNITY_INTRO";
  if (WARM_INTRO.test(input.text ?? "")) return "COMMUNITY_INTRO";
  return "INBOUND";
}
