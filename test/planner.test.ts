import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { FACTOR_KINDS, normalizePlan, plan, PROMPTS } from "../src/planner.js";
import type { Dossier } from "../src/geo.js";
import { chatRes, mockFetch, type MockHandle } from "./helpers/mock.js";
import { hasLegacy, legacyConst } from "./helpers/legacy.js";

let net: MockHandle | null = null;
afterEach(() => {
  net?.restore();
  net = null;
});

const dossier = (over: Partial<Dossier> = {}): Dossier => ({
  subject: "entity",
  name: "Ethereum",
  description: "A decentralized blockchain platform.",
  typeNames: ["Project"],
  facts: [],
  related: [],
  ownImages: [],
  refKind: "company",
  extra: [],
  ...over,
});

// ── prompts ─────────────────────────────────────────────────────────
describe("prompts", () => {
  it("has one for every subject kind that plans", () => {
    for (const kind of ["story", "entity", "type", "property", "space", "relation", "text"]) {
      assert.ok(PROMPTS[kind]?.length > 400, `${kind} prompt missing or too short`);
    }
  });

  it("keeps the story prompt identical to the validated news planner", { skip: !hasLegacy() }, () => {
    assert.equal(PROMPTS.story, legacyConst("EXTRACT"));
  });

  it("forbids screens and UI in the property prompt", () => {
    assert.match(PROMPTS.property, /NEVER depict a screen, monitor, phone, browser, form/);
  });

  it("forbids naming a real member in the type prompt", () => {
    assert.match(PROMPTS.type, /Name NO real company, person, product or place/);
  });

  it("forbids drawing arrows or graphs in the relation prompt", () => {
    assert.match(PROMPTS.relation, /Never draw an arrow, a line, a link, a diagram/);
  });

  it("forbids depicting the software in the space prompt", () => {
    assert.match(PROMPTS.space, /Never depict the software/);
  });

  it("offers the profile choice on every non-story prompt", () => {
    for (const kind of ["entity", "type", "property", "space", "relation", "text"]) {
      assert.match(PROMPTS[kind], /"profile": which look best fits/, kind);
    }
    assert.ok(!PROMPTS.story.includes('"profile"'), "the story planner keeps its validated contract");
  });
});

// ── normalisation ───────────────────────────────────────────────────
describe("normalizePlan", () => {
  it("passes a well-formed plan through", () => {
    const p = normalizePlan({
      factors: [{ name: "Ethereum", kind: "crypto", ref_query: "Ethereum", domain: "", role: "the coin on the desk" }],
      composition: "a coin resting on a ledger",
      profile: "emblem",
      poster_text: "the merge",
    }, dossier());

    assert.equal(p.factors.length, 1);
    assert.deepEqual(p.factors[0], {
      name: "Ethereum", kind: "crypto", refQuery: "Ethereum", domain: "", role: "the coin on the desk",
    });
    assert.equal(p.composition, "a coin resting on a ledger");
    assert.equal(p.profile, "emblem");
    assert.equal(p.posterText, "THE MERGE");
  });

  it("accepts factors given as bare strings", () => {
    const p = normalizePlan({ factors: ["Ethereum", "Bitcoin"] }, dossier());
    assert.deepEqual(p.factors.map((f) => f.name), ["Ethereum", "Bitcoin"]);
    assert.ok(p.factors.every((f) => f.kind === "concept"), "an unlabelled factor is built, not matched");
  });

  it("maps kind aliases and unknown kinds onto the enum", () => {
    const p = normalizePlan({
      factors: [
        { name: "a", kind: "Startup" }, { name: "b", kind: "token" }, { name: "c", kind: "AGENCY" },
        { name: "d", kind: "wibble" }, { name: "e", kind: "" }, { name: "f" },
      ],
    }, dossier());
    assert.deepEqual(p.factors.map((f) => f.kind), ["company", "crypto", "government", "concept", "concept", "concept"]);
    assert.ok(p.factors.every((f) => (FACTOR_KINDS as readonly string[]).includes(f.kind)));
  });

  it("blanks ref_query for concepts and keeps it otherwise", () => {
    const p = normalizePlan({
      factors: [{ name: "an invented coin", kind: "concept", ref_query: "Bitcoin" }, { name: "Berlin", kind: "place" }],
    }, dossier());
    assert.equal(p.factors[0].refQuery, "", "a concept must never be matched to a real photo");
    assert.equal(p.factors[1].refQuery, "Berlin", "defaults to the name");
  });

  it("keeps a domain only for companies and strips scheme and path", () => {
    const p = normalizePlan({
      factors: [
        { name: "OpenAI", kind: "company", domain: "https://openai.com/about" },
        { name: "Berlin", kind: "place", domain: "berlin.de" },
      ],
    }, dossier());
    assert.equal(p.factors[0].domain, "openai.com");
    assert.equal(p.factors[1].domain, "");
  });

  it("drops nameless factors", () => {
    const p = normalizePlan({ factors: [{ kind: "person" }, { name: "  ", kind: "person" }, { name: "Real" }] }, dossier());
    assert.deepEqual(p.factors.map((f) => f.name), ["Real"]);
  });

  it("clamps to the factor cap", () => {
    const p = normalizePlan({ factors: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}` })) }, dossier());
    assert.equal(p.factors.length, 6);
  });

  it("survives a plan with no factors at all", () => {
    for (const raw of [{}, { factors: null }, { factors: "nope" }, null, undefined]) {
      const p = normalizePlan(raw, dossier());
      assert.deepEqual(p.factors, []);
    }
  });

  it("falls back through composition -> description -> a generic line", () => {
    assert.equal(normalizePlan({ composition: "  a scene  " }, dossier()).composition, "a scene");
    assert.equal(normalizePlan({}, dossier()).composition, "A decentralized blockchain platform.");
    assert.equal(
      normalizePlan({}, dossier({ description: "" })).composition,
      "a single real scene that stands for Ethereum",
    );
  });

  it("keeps only a valid profile suggestion", () => {
    assert.equal(normalizePlan({ profile: "EMBLEM" }, dossier()).profile, "emblem");
    assert.equal(normalizePlan({ profile: "cinematic" }, dossier()).profile, undefined);
    assert.equal(normalizePlan({}, dossier()).profile, undefined);
  });

  it("tidies poster text into at most four uppercase words", () => {
    assert.equal(normalizePlan({ poster_text: "the great merge" }, dossier()).posterText, "THE GREAT MERGE");
    assert.equal(normalizePlan({ poster_text: "one two three four five six" }, dossier()).posterText, "ONE TWO THREE FOUR");
    assert.equal(normalizePlan({ poster_text: '"Quoted!"' }, dossier()).posterText, "QUOTED");
    assert.equal(normalizePlan({ poster_text: "" }, dossier()).posterText, "");
    assert.equal(normalizePlan({}, dossier()).posterText, "");
    assert.equal(normalizePlan({ poster_text: null }, dossier()).posterText, "");
  });

  it("keeps money and percent signs in poster text", () => {
    assert.equal(normalizePlan({ poster_text: "$250 bill" }, dossier()).posterText, "$250 BILL");
  });

  it("truncates an over-long factor name and role", () => {
    const p = normalizePlan({ factors: [{ name: "x".repeat(400), role: "y".repeat(400) }] }, dossier());
    assert.ok(p.factors[0].name.length <= 120);
    assert.ok(p.factors[0].role.length <= 160);
  });
});

// ── the call ────────────────────────────────────────────────────────
describe("plan()", () => {
  it("sends the subject's own system prompt and asks for JSON", async () => {
    net = mockFetch(() => chatRes('{"factors":[{"name":"Ethereum","kind":"crypto"}],"composition":"a coin"}'));
    const p = await plan(dossier({ subject: "entity", facts: ["Website: x"] }));

    const body = net.calls[0].json;
    assert.equal(body.response_format.type, "json_object");
    assert.equal(body.messages[0].content, PROMPTS.entity);
    assert.match(body.messages[1].content, /^ENTITY: Ethereum/);
    assert.match(body.messages[1].content, /Website: x/);
    assert.equal(p.factors[0].kind, "crypto");
  });

  it("sends a story as HEADLINE/CONTEXT, exactly as the news pipeline did", async () => {
    net = mockFetch(() => chatRes('{"factors":[],"composition":"c"}'));
    await plan(dossier({ subject: "story", name: "SEC drops case", description: "the context" }));
    assert.equal(net.calls[0].json.messages[0].content, PROMPTS.story);
    assert.equal(net.calls[0].json.messages[1].content, "HEADLINE: SEC drops case\nCONTEXT: the context");
  });

  it("honours a model override", async () => {
    net = mockFetch(() => chatRes("{}"));
    await plan(dossier(), { model: "gpt-5.4-mini" });
    assert.equal(net.calls[0].json.model, "gpt-5.4-mini");
  });

  it("parses a fenced reply", async () => {
    net = mockFetch(() => chatRes('```json\n{"composition":"a quiet desk"}\n```'));
    assert.equal((await plan(dossier())).composition, "a quiet desk");
  });

  it("propagates a reply that is not JSON at all", async () => {
    net = mockFetch(() => chatRes("I can't help with that."));
    await assert.rejects(() => plan(dossier()), /did not return JSON/);
  });

  it("falls back to the text prompt for an unknown subject kind", async () => {
    net = mockFetch(() => chatRes("{}"));
    await plan(dossier({ subject: "wibble" as any }));
    assert.equal(net.calls[0].json.messages[0].content, PROMPTS.text);
  });
});
