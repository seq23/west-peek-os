import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NEVER_TEXT, STANDARD_TEXT, TEAM_HTML, completeWords, fallbackWords, samplesWordsSchema, approvedSamplePrices, renderSamplesPreview, requestsSamples, samplesOverridesSchema, samplesPdfName, whatChangedLine, DEFAULT_COMMUNITY_MIX, isYesToSamples, readMix, renderSamplesPdf, samplesCoverEmail, samplesProblems } from "../src/shared/tlc/samples";
import { freeSlots, isFree, nyToUtc, pickedSlot, proposedTime, slotWords } from "../src/shared/tlc/callSlots";

/** Fake brands only. The standard template is her final document (30 Oct 2026); only the brand's words change. */
const VECTOR_WORDS = {
  title: "Build Your First AI Agent", leaveFact: "everyone leaves with a working agent",
  openingTheme: "What AI agents can actually do right now", panelAngle: "what changed when they put agents to work",
  dinnerPick: "pick the agent they'll build", segmentTitle: "Giving your agent a memory",
  segmentDoes: "every table wires Vector Co into its agent", leaveWith: "A working AI agent of their own",
  seriesTitle: "the six-month agent syllabus", seriesTail: "with Vector Co as the memory layer from month 2 on.",
  months: [
    { title: "Build Your First AI Agent", line: "Everyone leaves with an agent that gets a real task done.", brand: false },
    { title: "Give Your Agent a Memory", line: "Your agent remembers past conversations, powered by Vector Co.", brand: true },
    { title: "Teach Your Agent to Use Tools", line: "It looks things up and fills in forms.", brand: true },
    { title: "Keep a Human in the Loop", line: "Your agent pauses for your OK before anything important.", brand: true },
    { title: "Build a Team of Agents", line: "A lead agent hands work to helper agents.", brand: true },
    { title: "Launch Night", line: "Demo night for the whole series.", brand: true },
  ],
  whyLead: "Real code proofs:", whyLine: "each month leaves open-source starter templates built on Vector Co.",
  perks: [{ lead: "Built in from day one:", line: "Vector Co is pre-wired in every starter template." }, { lead: "Your name in the code:", line: "co-branding on every README the club publishes." }],
};
const AGENT = { brand: "Vector Co", topic: "Build Your Own AI Agent", month: "2027-03", words: VECTOR_WORDS, mix: DEFAULT_COMMUNITY_MIX };
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("the 3-page samples PDF", () => {
  it("is her final template word for word, with only the brand's words changed, and nothing it must never carry", () => {
    const html = renderSamplesPdf(AGENT);
    expect(createHash("sha256").update(html).digest("hex")).toBe("f52f602f7759814dd92b912d3c8be74ceb3c437806037c4041bec78d8c013044");
    const t = text(html);
    for (const line of [
      "WEST PEEK ROOMS · THE LEARNING CLUB", "The Learning Club: Build Your First AI Agent", "An evening in New York · 2027 (dates flexible) · in partnership with Vector Co",
      "25 to 100+ guests, sized to your goals", "3½ hours · 6:00–9:30pm", "Hands-on · everyone leaves with a working agent",
      'Opening talk, with a 2-minute welcome from Vector Co · "What AI agents can actually do right now": real examples from founders and operators, no hype',
      "Panel · three builders on what changed when they put agents to work (a founder, an operator, a creative), with audience Q&A",
      "Dinner at the tables · facilitators help each table pick the agent they'll build",
      "Build session · step by step, in the browser, no code needed; facilitators at every table",
      "Giving your agent a memory · 30 minutes, hands-on: every table wires Vector Co into its agent, led by Vector Co or by our host",
      "Show and tell · each table demos what it built", "Close · drinks, introductions, follow-up resources",
      "Their own laptop. Everything runs in the browser with free accounts set up on arrival. Anyone without a laptop is paired at their table.",
      "A working AI agent of their own, the step-by-step guide, and introductions to the people at their table.",
      "Confidential · Preliminary · We host and facilitate the whole evening. Vector Co sends a speaker or team only if it wants to.",
      "A sample series: the six-month agent syllabus",
      "Partner on a single evening, or on a series of 6 or more. Here is a sample series of six, to show what one could look like: one build that grows every month, with Vector Co as the memory layer from month 2 on.",
      "Month 2 The Learning Club: Give Your Agent a Memory Your agent remembers past conversations, powered by Vector Co.",
      "Why six months works for a partner",
      "Two full quarters of visibility: the same people come back every month, and Vector Co is part of what they learn, not a logo they pass.",
      "Real code proofs: each month leaves open-source starter templates built on Vector Co.",
      "Builders and their teams: independent builders plus people from companies joining with team seats.",
      "Confidential · Preliminary · Dates move with Vector Co's launch calendar. Any single month can be partnered on its own.",
      "Guests are invited from our community of ~5,000, shaped around who Vector Co wants to reach.",
      "Operators · ~35% marketing, finance, product, sales and people teams; many are intrapreneurs building side businesses with AI tools like Claude and Codex outside work",
      "Creators · ~35% film, music, design, writing and content",
      "Founders · ~25% AI and tech startups, consumer brands, agencies", "Investors & legal · ~5% angels, VCs, family offices, lawyers",
      "All numbers, the mix and titles are approximate, based on how members describe themselves. Creators and operators together are well over half the community.",
      "What partnering gets Vector Co", "Built in from day one: Vector Co is pre-wired in every starter template.",
      "A room your size: from an intimate 25 to 100+ guests, and the guest list you want: invitations and room in your name, warm introductions after, and content from every evening for your channels.",
      "The team behind the room", "Carlos Barksdale Events Consultant, West Peek.",
      "This document was prepared by West Peek Ventures for Vector Co and is confidential. Please do not share it outside Vector Co without our written consent.",
      "Vector Co, Claude, Google, Columbia and other names and trademarks belong to their owners",
      "Confidential · Preliminary · West Peek Ventures · sequoia@westpeek.ventures", "1 / 3", "2 / 3", "3 / 3",
    ]) expect(t, line).toContain(line);
    expect(samplesProblems(html, AGENT.mix)).toEqual([]);
    for (const old of ["Pinecone", "5,000+", "25–40", "Quarantine Con (2020)", "tentative", "15-minute", "Creatives ·"]) expect(t, old).not.toContain(old);
    expect(t.replace(text(TEAM_HTML), " ")).not.toMatch(/\$|\bprice|\btier|\bfee\b|your team leads/i);
    expect((html.match(/class="sheet"/g) ?? []).length).toBe(3);
    // The wheel is drawn from the mix: four ring segments that close the circle, "~5,000" in the middle.
    expect((html.match(/<circle /g) ?? []).length).toBe(4);
    expect(html).toContain('class="wt1">~5,000</text>');
  });

  it("a made-up brand gets every STANDARD part of her final document, and nothing the template no longer says", () => {
    const kestrel = { ...VECTOR_WORDS, title: "Your AI Chief of Staff", segmentTitle: "Turning meeting notes into action", segmentDoes: "every table connects Kestrel to its assistant",
      seriesTail: "with Kestrel built in from month 3 on.", perks: [{ lead: "Extended trial for members,", line: "so every guest keeps using what they built." }] };
    const html = renderSamplesPdf({ brand: "Kestrel", topic: "The Learning Club: Your AI Chief of Staff", month: "2027-05", words: kestrel, mix: DEFAULT_COMMUNITY_MIX });
    const t = text(html);
    for (const p of [
      "2027 (dates flexible)", "25 to 100+ guests, sized to your goals", "3½ hours · 6:00–9:30pm",
      "Opening talk, with a 2-minute welcome from Kestrel ·", "Panel · three builders on", "Dinner at the tables ·",
      "Build session · step by step, in the browser, no code needed; facilitators at every table",
      "· 30 minutes, hands-on: every table connects Kestrel to its assistant, led by Kestrel or by our host",
      "Show and tell · each table demos what it built", "Close · drinks, introductions, follow-up resources", "Guests bring",
      "Their own laptop. Everything runs in the browser with free accounts set up on arrival. Anyone without a laptop is paired at their table.",
      "We host and facilitate the whole evening. Kestrel sends a speaker or team only if it wants to.",
      "Partner on a single evening, or on a series of 6 or more. Here is a sample series of six, to show what one could look like: one build that grows every month,",
      "Who's in the room", "community of ~5,000", "Operators · ~35%", "intrapreneurs building side businesses with AI tools like Claude and Codex outside work",
      "Creators · ~35%", "Founders · ~25%", "Investors & legal · ~5%", "All numbers, the mix and titles are approximate",
      "A room your size: from an intimate 25 to 100+ guests", "The team behind the room",
      "Scooter Taylor Co-Managing Partner, West Peek Ventures. Founding GP. Went viral in 2020 creating Quarantine Con, the online gathering that grew into West Peek: a community of ~5,000 founders",
      "Sequoia Taylor Co-Managing Partner, West Peek Ventures. A decade in investment banking and capital markets at Raymond James; more than $100M in secondary transactions.",
      "Carlos Barksdale Events Consultant, West Peek. Led venture capital business development at Google in New York",
      "Confidential · Preliminary draft · For discussion purposes only. This document was prepared by West Peek Ventures for Kestrel and is confidential.",
      "Kestrel, Claude, Google, Columbia and other names and trademarks belong to their owners",
    ]) expect(t, p).toContain(p);
    expect(t.match(/Confidential · Preliminary · /g)?.length).toBe(3);
    for (const never of ["Pinecone", "5,000+", "25–40", "Quarantine Con (2020)", "tentative"]) expect(t, never).not.toContain(never);
    expect(html).toContain('class="wt1">~5,000</text>');
    expect(samplesProblems(html, DEFAULT_COMMUNITY_MIX)).toEqual([]);
    // The guards: each one fails on a page that breaks it.
    expect(samplesProblems(html.replace("2027 (dates flexible)", "May 2027 (tentative)"), DEFAULT_COMMUNITY_MIX).join("|")).toMatch(/dates flexible.*tentative/);
    expect(samplesProblems(html.replace('class="wt1">~5,000', 'class="wt1">5,000+'), DEFAULT_COMMUNITY_MIX).join("|")).toMatch(/wt1.*5,000\+/);
    expect(samplesProblems(html.replace("<b>25 to 100+</b> guests", "<b>25–40</b> guests"), DEFAULT_COMMUNITY_MIX).join("|")).toMatch(/sized to your goals.*25–40/);
    expect(samplesProblems(html.replace("Events Consultant, West Peek.", "Advisor."), DEFAULT_COMMUNITY_MIX).join("|")).toContain("The team behind the room");
    expect(samplesProblems(html.replace('<span class="conf">Confidential · Preliminary</span> · We host', "We host"), DEFAULT_COMMUNITY_MIX)).toContain("a page without its Confidential · Preliminary footer");
    expect(samplesProblems(html.replace("· sequoia@", "· founding GP Scooter Taylor, creator of Quarantine Con (2020) · sequoia@"), DEFAULT_COMMUNITY_MIX).join("|")).toContain("Quarantine Con (2020)");
    expect(samplesProblems(html.replace("Confidential · Preliminary draft · For discussion purposes only.", ""), DEFAULT_COMMUNITY_MIX).join("|")).toContain("For discussion purposes only");
    expect([...STANDARD_TEXT].length).toBeGreaterThan(5);
    expect(NEVER_TEXT).toEqual(["5,000+", "25–40", "Quarantine Con (2020)", "tentative"]);
  });

  it("only the per-brand words are the model's: the schema takes exactly those fields, and an older row is completed, never broken", () => {
    expect(Object.keys(samplesWordsSchema.shape).sort()).toEqual(["dinnerPick", "leaveFact", "leaveWith", "months", "openingTheme", "panelAngle", "perks", "segmentDoes", "segmentTitle", "seriesTail", "seriesTitle", "title", "whyLead", "whyLine"]);
    expect(samplesWordsSchema.safeParse({ ...VECTOR_WORDS, guests: "25–40" }).success).toBe(false);
    expect(samplesWordsSchema.safeParse({ ...VECTOR_WORDS, months: VECTOR_WORDS.months.slice(0, 5) }).success).toBe(false);
    expect(samplesWordsSchema.safeParse({ ...VECTOR_WORDS, months: VECTOR_WORDS.months.map((m) => ({ ...m, brand: false })) }).success).toBe(false);
    expect(completeWords(VECTOR_WORDS, "Vector Co", "x")).toEqual(VECTOR_WORDS);
    const old = completeWords({ segmentTitle: "Giving your agent a memory", seriesTitle: "Give it a memory", reach: "founders" }, "Old Co", "The Learning Club: Build Your Own AI Agent");
    expect(old.segmentTitle).toBe("Giving your agent a memory");
    expect(old.title).toBe("Build Your Own AI Agent");
    expect(old.months[1]).toEqual({ title: "Give it a memory", line: "The build grows, with Old Co at its centre.", brand: true });
    const plain = renderSamplesPdf({ brand: "Old Co", topic: "Build Your Own AI Agent", month: "2027-03", words: fallbackWords("Old Co", "Build Your Own AI Agent"), mix: DEFAULT_COMMUNITY_MIX });
    expect(samplesProblems(plain, DEFAULT_COMMUNITY_MIX)).toEqual([]);
    expect(text(plain)).not.toMatch(/exclusive/i);
  });

  it("renders major per-deal edits as escaped copy, replacing each selected section", () => {
    const overrides = {
      page1Rows: [{ label: "6:30", title: "Practice lab", line: "Build <something> & learn", highlight: true }],
      series: [{ label: "A", title: "Start with a lab", line: "Bring a problem", highlight: true }],
      seriesHeading: "A new sequence", seriesSub: "Three workshops, shaped together",
      whyItWorks: ["Practice with the same group"], partnerGets: ["A useful guide"], footer2: "Next dates agreed together",
      bring: "A question", leaveWith: "A prototype",
    };
    const html = renderSamplesPdf({ ...AGENT, overrides });
    for (const value of ["Practice lab", "A new sequence", "Three workshops, shaped together", "Practice with the same group", "A useful guide", "Next dates agreed together", "A question", "A prototype"]) expect(text(html)).toContain(value);
    expect(html).toContain("Build &lt;something&gt; &amp; learn");
    for (const old of ["Opening talk", "Launch Night", "Two full quarters of visibility", "Built in from day one"]) expect(text(html)).not.toContain(old);
    // Her edits never take out the standard parts: the room-size perk, the team, the legal block, the footers.
    for (const kept of ["A room your size:", "The team behind the room", "For discussion purposes only."]) expect(text(html)).toContain(kept);
    expect(samplesProblems(html, AGENT.mix)).toEqual([]);
    expect(samplesOverridesSchema.safeParse({ series: "bad" }).success).toBe(false);
    expect(samplesOverridesSchema.safeParse({ approvedPrices: ["$4,000"] }).success).toBe(false);
  });

  it("permits only the exact price the owner explicitly puts in this PDF", () => {
    const html = renderSamplesPdf({ ...AGENT, overrides: { footer2: "Price: $4,250.50" } });
    expect(samplesProblems(html, AGENT.mix)).toContain("a price, fee or tier");
    expect(approvedSamplePrices("Put the price of $4,250.50 in the PDF.")).toEqual(["$4,250.50"]);
    expect(samplesProblems(html, AGENT.mix, approvedSamplePrices("Put the price of $4,250.50 in the PDF."))).toEqual([]);
    expect(samplesProblems(html.replace("$4,250.50", "$9,000"), AGENT.mix, ["$4,250.50"])).toContain("a price, fee or tier");
    for (const note of ["The budget is $4,250.50", "Do not put $4,250.50 in the PDF", "If they ask, add $4,250.50 to the PDF", "Include a price in the email: $4,250.50", "Remove the $4,250.50 price from the PDF", "Add $4,250.50 to the email and keep the PDF as it is", "Don’t put $4,250.50 in the PDF", "You shouldn't put $4,250.50 in the PDF"]) expect(approvedSamplePrices(note), note).toEqual([]);
    expect(samplesProblems(renderSamplesPdf(AGENT), AGENT.mix)).toEqual([]);
  });

  it("her title edit renames page 1, the document and the PDF file; without one, the brand's title names them", () => {
    const html = renderSamplesPdf({ ...AGENT, overrides: { title: "Agents <at> Work" } });
    expect(html).toContain("<title>The Learning Club: Agents &lt;at&gt; Work · Vector Co</title>");
    expect(html).toContain('<div class="ttl">The Learning Club: Agents &lt;at&gt; Work</div>');
    expect(samplesPdfName({ ...AGENT, overrides: { title: "Agents: at Work!" } })).toBe("The Learning Club - Agents at Work - Vector Co.pdf");
    expect(samplesPdfName(AGENT)).toBe("The Learning Club - Build Your First AI Agent - Vector Co.pdf");
    expect(samplesOverridesSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("each change is one plain line built from what changed, never from a model's claim", () => {
    expect(whatChangedLine({ seriesHeading: "x", footer2: "y" }, "Make it   shorter")).toBe('Changed the page 2 heading and the page 2 footer (your note: "Make it shorter")');
    expect(whatChangedLine({ title: "x" }, "")).toBe("Changed the title");
    expect(whatChangedLine({}, "Looks fine")).toBe('Looked at your note; nothing needed to change (your note: "Looks fine")');
    expect(whatChangedLine({ bring: "x" }, "a".repeat(200)).length).toBeLessThan(160);
  });

  it("the preview page IS the PDF's HTML, byte for byte, with her notes above it that never print", () => {
    const pdf = renderSamplesPdf({ ...AGENT, overrides: { footer2: "Dates agreed together" } });
    const history = [{ at: "2026-10-30T18:00:00.000Z", line: "Changed the page 2 footer <b>x</b>" }, { at: "2026-10-30T17:00:00.000Z", line: "First draft, from the approved template" }];
    const page = renderSamplesPreview(pdf, { brand: "Vector Co", status: "DRAFT", history });
    const body = (h: string) => h.slice(h.indexOf("<section"), h.lastIndexOf("</section>"));
    expect(body(page)).toBe(body(pdf));
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(page).toMatch(/@media print\{\.wp-preview\{display:none!important\}\}/);
    expect(page).toContain("Draft · not sent yet");
    expect(page).toContain("reply <b>approved</b>");
    expect(page).toContain("What changed (2): tap to show ▾");
    expect(page).toContain("<b>Latest:</b> Changed the page 2 footer &lt;b&gt;x&lt;/b&gt;");
    expect(page).not.toContain("<b>x</b>");
    expect(page).toContain('id="wp-long" hidden');
    const sent = renderSamplesPreview(pdf, { brand: "Vector Co", status: "SENT", sentAt: "2026-10-31T15:00:00.000Z", history });
    expect(sent).toContain("Nothing here can change it now.");
    expect(sent).not.toContain("reply <b>approved</b>");
    expect(sent).not.toContain("wp-long");
    expect(renderSamplesPreview(pdf, { brand: "Vector Co", status: "WORKING", history })).toContain("Your latest change is still being made.");
  });

  it("recognizes a direct request for materials without a prior offer", () => {
    for (const yes of ["Please send the materials", "Could you share the PDF?", "We would love to see samples"]) expect(requestsSamples(yes)).toBe(true);
    for (const no of ["Do not send the materials", "Not right now", "Sure, sounds interesting"]) expect(requestsSamples(no)).toBe(false);
  });

  it("the mix is editable data: a valid stored mix is used, a broken one falls back to hers", () => {
    const mine = [{ label: "Founders", pct: 50, roles: ["a"] }, { label: "Operators", pct: 50, roles: ["b"] }];
    expect(readMix(JSON.stringify(mine))).toEqual(mine);
    expect(text(renderSamplesPdf({ ...AGENT, mix: mine }))).toContain("Founders · ~50%");
    const noted = [{ label: "Operators", pct: 100, roles: ["sales"], note: "many build on the side" }];
    expect(readMix(JSON.stringify(noted))).toEqual(noted);
    expect(readMix(JSON.stringify([{ label: "x", pct: 30, roles: ["a"] }]))).toEqual(DEFAULT_COMMUNITY_MIX);
    expect(readMix("not json")).toEqual(DEFAULT_COMMUNITY_MIX);
  });

  it("a price or a brand put on the hook is caught", () => {
    const page = renderSamplesPdf(AGENT);
    expect(samplesProblems(page.replace("Real code proofs:", "Partner $5,000:"), AGENT.mix)).toContain("a price, fee or tier");
    expect(samplesProblems(page.replace("Real code proofs:", "your team leads the demo:"), AGENT.mix)).toContain("a segment the brand must staff");
    expect(samplesProblems(page.replace("All numbers, the mix", "The mix"), AGENT.mix)).toContain("the mix is not labelled approximate");
    // Her track record in the team's bios is not a price; the same figure anywhere else is.
    expect(samplesProblems(page, AGENT.mix)).toEqual([]);
    expect(samplesProblems(page.replace("Real code proofs:", "more than $100M:"), AGENT.mix)).toContain("a price, fee or tier");
  });

  it("the cover email says a short 3-page PDF, and the brand's segment is led by the brand or by our host", () => {
    const c = samplesCoverEmail({ brand: "Vector Co", contactName: "Sam Lee", topic: AGENT.topic, segmentTitle: AGENT.words.segmentTitle });
    expect(c).toMatch(/^Hi Sam,\n\nHere's a short 3-page PDF, built around Vector Co:/);
    expect(c).toContain("led by Vector Co or by our host");
    expect(c).not.toMatch(/your team leads|\bcall\b|\$/i);
  });

  it("reads a yes to the samples, and never reads a no or a not-now as one", () => {
    for (const yes of ["Sure, send it", "yes please!", "Please send them over", "Would love to see that", "Sounds great, go ahead", "Happy to take a look"]) expect(isYesToSamples(yes), yes).toBe(true);
    for (const no of ["No thanks", "Not right now, maybe later", "We'll pass", "Not interested", "What is the budget?"]) expect(isYesToSamples(no), no).toBe(false);
  });
});

describe("a call the brand asked for: times from her calendar, never double-booked", () => {
  const MON = new Date("2026-11-09T14:00:00.000Z"); // Monday 09:00 in New York
  it("offers three open times on three working days, skipping anything on her calendar and the weekend", () => {
    const tue11 = nyToUtc(2026, 11, 10, 11).getTime();
    const busy = [{ start: tue11, end: tue11 + 60 * 60_000 }];
    const slots = freeSlots(busy, MON);
    expect(slots).toHaveLength(3);
    // Tuesday 11:00 is taken, so Tuesday's time is 14:00; then Wednesday and Thursday at 11:00.
    expect(slots.map(slotWords)).toEqual(["Tuesday 10 Nov, 2:00pm", "Wednesday 11 Nov, 11:00am", "Thursday 12 Nov, 11:00am"]);
    for (const s of slots) expect(isFree(s, busy, MON)).toBe(true);
    // Friday then the weekend: a Friday morning asks Monday onward.
    expect(freeSlots([], new Date("2026-11-13T14:00:00.000Z")).map(slotWords)[0]).toBe("Monday 16 Nov, 11:00am");
  });

  it("never offers a time within 15 minutes of a meeting", () => {
    const day = (h: number, m = 0) => nyToUtc(2026, 11, 10, h, m).getTime();
    const busy = [{ start: day(10), end: day(12, 50) }, { start: day(14, 40), end: day(15, 40) }];
    const tue = freeSlots(busy, MON, 1)[0]!;
    // 11:00, 14:00 (ends 14:30, within 15 of 14:40), 10:00, 15:00 are out; 12:00 overlaps; 16:00 is clear.
    expect(slotWords(tue)).toBe("Tuesday 10 Nov, 4:00pm");
    expect(isFree(nyToUtc(2026, 11, 10, 14).toISOString(), busy, MON)).toBe(false);
  });

  it("reads the time they proposed, and which offered time they picked", () => {
    expect(slotWords(proposedTime("Could we do Thursday at 2:30pm?", MON)!)).toBe("Thursday 12 Nov, 2:30pm");
    expect(slotWords(proposedTime("How about Nov 17 at 11am", MON)!)).toBe("Tuesday 17 Nov, 11:00am");
    expect(proposedTime("Let's find a time", MON)).toBeNull();
    const offered = freeSlots([], MON);
    expect(pickedSlot("The second one works for us", offered, MON)).toBe(offered[1]);
    expect(pickedSlot("Wednesday is great", offered, MON)).toBe(offered[1]);
    expect(pickedSlot("None of those work, sorry", offered, MON)).toBeNull();
  });
});
