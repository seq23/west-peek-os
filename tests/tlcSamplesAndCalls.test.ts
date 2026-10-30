import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { approvedSamplePrices, renderSamplesPreview, requestsSamples, samplesOverridesSchema, samplesPdfName, whatChangedLine, DEFAULT_COMMUNITY_MIX, isYesToSamples, readMix, renderSamplesPdf, samplesCoverEmail, samplesProblems } from "../src/shared/tlc/samples";
import { freeSlots, isFree, nyToUtc, pickedSlot, proposedTime, slotWords } from "../src/shared/tlc/callSlots";

/** Fake brands only. The approved template (artifact v7, 26 Oct 2026); only the brand's words change. */
const AGENT = { brand: "Vector Co", topic: "Build Your Own AI Agent", month: "2027-03", tentative: true, segmentTitle: "Giving your agent a memory", seriesTitle: "Give it a memory", reach: "founders and operators deciding what their teams build on", mix: DEFAULT_COMMUNITY_MIX };
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ");

describe("the 3-page samples PDF", () => {
  it("is her approved template word for word, with only the brand's words changed, and nothing it must never carry", () => {
    const html = renderSamplesPdf(AGENT);
    expect(createHash("sha256").update(html).digest("hex")).toBe("b5bf653ac0c8bbd153381982e1e5ae8b8a1063269d4a5e6fcebf936a22806c10");
    const t = text(html);
    for (const line of [
      "WEST PEEK ROOMS · THE LEARNING CLUB", "An evening in New York · March 2027 (tentative) · in partnership with Vector Co",
      "25–40 guests, flexible to your goals", "3½ hours · 6:00–9:30pm", "everyone leaves with a working agent",
      'Opening talk · "What AI agents can actually do right now": real examples from founders and operators, no hype',
      "Panel · three builders on what changed when they put agents to work (a founder, an operator, a creative), with audience Q&A",
      "Dinner at the tables · facilitators help each table pick the agent they'll build",
      "Build session · step by step, in the browser, no code needed; facilitators at every table",
      "Giving your agent a memory · a 15-minute segment led by Vector Co or by our host",
      "Show and tell · each table demos what it built",
      "Their own laptop. Everything runs in the browser with free accounts set up on arrival.",
      "We host and facilitate the whole evening. Vector Co sends a speaker or team only if it wants to.",
      "Dates move with Vector Co's launch calendar.", "02 Give it a memory Vector Co's signature evening", "06 Demo night",
      "150–240 builders across the series at the standard size, all hands-on.",
      "Guests are invited from our community of 5,000+, shaped around who Vector Co wants to reach.",
      "Operators · 35% marketing, finance, product, sales, people teams", "Creatives · 35% film, music, design, writing",
      "Founders · 25% AI and tech startups, consumer brands, agencies", "Investors & legal · 5% angels, VCs, family offices, lawyers",
      "Approximate mix of our community.", "we weight the room toward founders and operators deciding what their teams build on.",
      "founding GP Scooter Taylor, creator of Quarantine Con (2020)", "1 / 3", "2 / 3", "3 / 3",
    ]) expect(t, line).toContain(line);
    expect(samplesProblems(html, AGENT.mix)).toEqual([]);
    expect(t).not.toMatch(/\$|\bprice|\btier|\bfee\b|your team leads/i);
    expect((html.match(/class="sheet"/g) ?? []).length).toBe(3);
    // The wheel is drawn from the mix: four ring segments that close the circle.
    expect((html.match(/<circle /g) ?? []).length).toBe(4);
  });

  it("renders major per-deal edits as escaped copy, replacing each selected section", () => {
    const overrides = {
      page1Rows: [{ label: "6:30", title: "Practice lab", line: "Build <something> & learn", highlight: true }],
      series: [{ label: "A", title: "Start with a lab", line: "Bring a problem", highlight: true }],
      seriesHeading: "A new sequence", seriesSub: "Three workshops, shaped together",
      whyItWorks: ["Practice with the same group"], partnerGets: ["A useful guide"], footer2: "Next dates agreed together",
      bring: "A question", leaveWith: "A prototype", reach: "working designers",
    };
    const html = renderSamplesPdf({ ...AGENT, overrides });
    for (const value of ["Practice lab", "A new sequence", "Three workshops, shaped together", "Practice with the same group", "A useful guide", "Next dates agreed together", "A question", "A prototype"]) expect(text(html)).toContain(value);
    expect(html).toContain("Build &lt;something&gt; &amp; learn");
    for (const old of ["Opening talk", "Demo night", "Six evenings, one community", "Your product in their hands"]) expect(text(html)).not.toContain(old);
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

  it("her title edit renames page 1, the document and the PDF file; without one, the topic names them", () => {
    const html = renderSamplesPdf({ ...AGENT, overrides: { title: "Agents <at> Work" } });
    expect(html).toContain("<title>The Learning Club: Agents &lt;at&gt; Work · Vector Co</title>");
    expect(html).toContain('<div class="ttl">Agents &lt;at&gt; Work</div>');
    expect(samplesPdfName({ ...AGENT, overrides: { title: "Agents: at Work!" } })).toBe("The Learning Club - Agents at Work - Vector Co.pdf");
    expect(samplesPdfName(AGENT)).toBe(`The Learning Club - ${AGENT.topic.replace(/[^\w &-]+/g, "").trim()} - Vector Co.pdf`);
    expect(samplesOverridesSchema.safeParse({ title: "" }).success).toBe(false);
  });

  it("each change is one plain line built from what changed, never from a model's claim", () => {
    expect(whatChangedLine({ seriesHeading: "x", footer2: "y" }, "Make it   shorter")).toBe('Changed the page 2 heading and the page 2 footer (your note: "Make it shorter")');
    expect(whatChangedLine({ title: "x" }, "")).toBe("Changed the title");
    expect(whatChangedLine({}, "Looks fine")).toBe('Looked at your note; nothing needed to change (your note: "Looks fine")');
    expect(whatChangedLine({ reach: "x" }, "a".repeat(200)).length).toBeLessThan(160);
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
    expect(text(renderSamplesPdf({ ...AGENT, mix: mine }))).toContain("Founders · 50%");
    expect(readMix(JSON.stringify([{ label: "x", pct: 30, roles: ["a"] }]))).toEqual(DEFAULT_COMMUNITY_MIX);
    expect(readMix("not json")).toEqual(DEFAULT_COMMUNITY_MIX);
  });

  it("a price or a brand put on the hook is caught", () => {
    expect(samplesProblems("<p>Partner $5,000 · 1 / 3 2 / 3 3 / 3 Approximate mix of our community</p>", AGENT.mix)).toContain("a price, fee or tier");
    expect(samplesProblems("<p>your team leads the demo · 1 / 3 2 / 3 3 / 3 Approximate mix of our community</p>", AGENT.mix)).toContain("a segment the brand must staff");
  });

  it("the cover email says a short 3-page PDF, and the brand's segment is led by the brand or by our host", () => {
    const c = samplesCoverEmail({ brand: "Vector Co", contactName: "Sam Lee", topic: AGENT.topic, segmentTitle: AGENT.segmentTitle });
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
