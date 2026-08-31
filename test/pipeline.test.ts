import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { attachOwnImages, generateGroundedCover, generateImage } from "../src/pipeline.js";
import type { Dossier } from "../src/geo.js";
import type { PlanFactor } from "../src/planner.js";
import {
  bytesRes, chatRes, entityRow, geoRes, imageRes, mockFetch, PNG_BYTES, type MockHandle,
} from "./helpers/mock.js";

let net: MockHandle | null = null;
before(() => {
  process.env.GEO_IMAGE_SLEEP_SCALE = "0";
  process.env.OPENAI_API_KEY ||= "test-key";
});
afterEach(() => {
  net?.restore();
  net = null;
});

// ── one router for the whole pipeline ───────────────────────────────
interface Scenario {
  /** JSON the planner returns. */
  plan?: unknown;
  /** Gate verdicts, consumed in order (last one repeats). */
  gate?: string[];
  /** QC verdicts, consumed in order (last one repeats). */
  qc?: Array<{ bad: boolean; reason?: string }>;
  /** Geo entity row (id lookups). */
  entity?: any;
  /** Avatar/cover relations for the own-images query. */
  ownRelations?: any[];
  /** URLs that serve a real image; everything else 404s. */
  images?: string[];
}

function pipelineNet(s: Scenario) {
  let gateAt = 0;
  let qcAt = 0;
  const pick = <T>(arr: T[] | undefined, i: number, dflt: T): T =>
    arr && arr.length ? arr[Math.min(i, arr.length - 1)] : dflt;

  return mockFetch((url, _init, call) => {
    if (url.includes("geobrowser")) {
      const q = String(call.json.query);
      if (q.includes("relationsList(first:12")) return geoRes({ entity: { relationsList: s.ownRelations ?? [] } });
      return geoRes({ entity: s.entity ?? entityRow() });
    }
    if (url.includes("/chat/completions")) {
      const messages = call.json.messages;
      if (messages[0].role === "system") return chatRes(JSON.stringify(s.plan ?? {}));
      const text = messages[0].content?.[0]?.text ?? "";
      if (text.startsWith("Strict QA")) {
        return chatRes(JSON.stringify(pick(s.qc, qcAt++, { bad: false, reason: "clean" })));
      }
      return chatRes(pick(s.gate, gateAt++, "YES"));
    }
    if (url.includes("/images/")) return imageRes(PNG_BYTES);
    if ((s.images ?? []).some((u) => url.includes(u))) return bytesRes(PNG_BYTES, "image/png");
    return new Response("nope", { status: 404 });
  });
}

const storySubject = { kind: "story" as const, headline: "SEC drops its case", summary: "context" };

// ── attachOwnImages ─────────────────────────────────────────────────
describe("attachOwnImages", () => {
  const dossier = (over: Partial<Dossier> = {}): Dossier => ({
    subject: "entity", name: "Ethereum", description: "", typeNames: [], facts: [], related: [],
    ownImages: [], refKind: "company", extra: [], ...over,
  });
  const factor = (name: string): PlanFactor => ({ name, kind: "company", refQuery: name, domain: "", role: "r" });

  it("matches an own image to the factor with the same name", () => {
    const out = attachOwnImages([factor("Bitcoin"), factor("Ethereum")], dossier({
      ownImages: [{ name: "Ethereum", urls: ["https://g/eth"] }],
    }));
    assert.deepEqual(out[0].ownImageUrls, []);
    assert.deepEqual(out[1].ownImageUrls, ["https://g/eth"]);
  });

  it("matches loosely when the planner renamed the factor", () => {
    const out = attachOwnImages([factor("the Ethereum logo")], dossier({
      ownImages: [{ name: "Ethereum", urls: ["https://g/eth"] }],
    }));
    assert.deepEqual(out[0].ownImageUrls, ["https://g/eth"]);
  });

  it("ignores case and punctuation", () => {
    const out = attachOwnImages([factor("VITALIK  BUTERIN!")], dossier({
      ownImages: [{ name: "Vitalik Buterin", urls: ["https://g/vb"] }],
    }));
    assert.deepEqual(out[0].ownImageUrls, ["https://g/vb"]);
  });

  it("falls back to the lead factor for a single-entity subject", () => {
    const out = attachOwnImages([factor("a wall of servers")], dossier({
      ownImages: [{ name: "Ethereum", urls: ["https://g/eth"] }],
    }));
    assert.deepEqual(out[0].ownImageUrls, ["https://g/eth"], "the subject's picture belongs to the lead factor");
  });

  it("does NOT guess for a relation, where both endpoints matter", () => {
    const out = attachOwnImages([factor("a handshake")], dossier({
      subject: "relation",
      ownImages: [{ name: "Vitalik Buterin", urls: ["https://g/vb"] }],
    }));
    assert.deepEqual(out[0].ownImageUrls, []);
  });

  it("routes each endpoint of a relation to its own factor", () => {
    const out = attachOwnImages([factor("Vitalik Buterin"), factor("Ethereum Foundation")], dossier({
      subject: "relation",
      ownImages: [
        { name: "Vitalik Buterin", urls: ["https://g/vb"] },
        { name: "Ethereum Foundation", urls: ["https://g/ef"] },
      ],
    }));
    assert.deepEqual(out[0].ownImageUrls, ["https://g/vb"]);
    assert.deepEqual(out[1].ownImageUrls, ["https://g/ef"]);
  });

  it("ignores an entry with no URLs and copes with no factors", () => {
    assert.deepEqual(attachOwnImages([factor("a")], dossier({ ownImages: [{ name: "a", urls: [] }] }))[0].ownImageUrls, []);
    assert.deepEqual(attachOwnImages([], dossier({ ownImages: [{ name: "a", urls: ["u"] }] })), []);
  });
});

// ── dry run ─────────────────────────────────────────────────────────
describe("generateImage (dry run)", () => {
  it("plans and composes without calling the image API", async () => {
    net = pipelineNet({
      plan: {
        factors: [{ name: "SEC", kind: "government", ref_query: "U.S. Securities and Exchange Commission", role: "the seal" }],
        composition: "a lawyer leaves a courthouse at dusk",
        poster_text: "case closed",
      },
    });

    const r = await generateImage({ subject: storySubject, dryRun: true });
    assert.equal(r.imageBase64, "");
    assert.equal(r.mimeType, "");
    assert.equal(net.to("/images/").length, 0, "a dry run must never spend money");
    assert.equal(r.sceneDescription, "a lawyer leaves a courthouse at dusk");
    assert.equal(r.posterText, "CASE CLOSED");
    assert.equal(r.profile, "editorial");
    assert.equal(r.format, "banner");
    assert.match(r.trace, /\[qc:dry-run\] \[profile:editorial\] \[fmt:banner\]/);
    assert.ok(r.prompt.includes("SEC (the seal)"), "unresolved factors are described in-prompt");
    assert.ok(r.prompt.includes("Using the 0 reference image(s)"));
  });

  it("resolves references on request", async () => {
    net = pipelineNet({
      plan: { factors: [{ name: "SEC", kind: "government" }], composition: "c" },
      images: ["wiki"],
    });
    // No web source resolves here, so the factor is still described — but the
    // hunt must have happened.
    const r = await generateImage({ subject: storySubject, dryRun: true, resolveRefsInDryRun: true });
    assert.ok(net.calls.some((c) => c.url.includes("wikidata") || c.url.includes("wikipedia")), "should have hunted");
    assert.ok(r.trace.includes("describe"));
  });
});

// ── full runs ───────────────────────────────────────────────────────
describe("generateImage (render)", () => {
  it("renders with references through the edits endpoint", async () => {
    net = pipelineNet({
      entity: entityRow({ name: "Ethereum" }),
      ownRelations: [{
        typeId: "1155befffad549b7a2e0da4777b8792c",
        toEntity: { valuesList: [{ propertyId: "8a743832c0944a62b6650c3cc2f9c7bc", text: "ipfs://cid" }] },
      }],
      plan: { factors: [{ name: "Ethereum", kind: "company" }], composition: "a coin on a ledger", profile: "emblem" },
      images: ["/cid"],
    });

    const r = await generateImage({
      subject: { kind: "entity", ref: "0068f0fc16034c749c991e6eabe37031" },
      format: "square",
    });

    assert.equal(net.to("/images/edits").length, 1);
    assert.equal(net.to("/images/generations").length, 0);
    assert.equal(net.to("/images/edits")[0].form!.size, "1024x1024");
    assert.equal(r.mimeType, "image/png");
    assert.ok(r.imageBase64.length > 0);
    assert.deepEqual(r.refs, [{ name: "Ethereum", kind: "company", src: "geo-own", conf: 0.99 }]);
    assert.equal(r.profile, "emblem", "the planner's suggestion wins when nothing is pinned");
    assert.match(r.trace, /Ethereum=geo-own:0\.99@t1 \[qc:clean@0\] \[profile:emblem\] \[fmt:square\]/);
  });

  it("renders without references through the generations endpoint", async () => {
    net = pipelineNet({
      plan: { factors: [{ name: "a worn calendar", kind: "concept" }], composition: "a calendar on a desk" },
    });
    const r = await generateImage({ subject: { kind: "text", text: "a birthday" } });
    assert.equal(net.to("/images/generations").length, 1);
    assert.equal(net.to("/images/edits").length, 0);
    assert.equal(net.to("/images/generations")[0].json.size, "1536x640");
    assert.deepEqual(r.described, [{ name: "a worn calendar", role: "" }]);
  });

  it("re-renders with the specific defect fed back, then stops when clean", async () => {
    net = pipelineNet({
      plan: { factors: [], composition: "a quiet desk" },
      qc: [{ bad: true, reason: "PASS 1 TEXT: sign reads GOCDS" }, { bad: false, reason: "clean" }],
    });
    const r = await generateImage({ subject: { kind: "text", text: "a shop" } });

    const renders = net.to("/images/generations");
    assert.equal(renders.length, 2);
    assert.ok(!renders[0].json.prompt.includes("CRITICAL RETRY"));
    assert.ok(renders[1].json.prompt.includes("CRITICAL RETRY"));
    assert.ok(renders[1].json.prompt.includes("sign reads GOCDS"));
    assert.match(r.trace, /\[qc:clean@1\]/);
  });

  it("gives up after the QC retry budget and returns the last render", async () => {
    net = pipelineNet({
      plan: { factors: [], composition: "c" },
      qc: [{ bad: true, reason: "still wrong" }],
    });
    const r = await generateImage({ subject: { kind: "text", text: "x" } });
    assert.equal(net.to("/images/generations").length, 3, "one render plus two QC retries");
    assert.match(r.trace, /\[qc:glitch@2:still wrong\]/);
    assert.ok(r.imageBase64.length > 0, "a flawed image still beats no image");
  });

  it("lets a pinned profile beat the planner's suggestion", async () => {
    net = pipelineNet({ plan: { factors: [], composition: "c", profile: "emblem" } });
    const r = await generateImage({ subject: { kind: "text", text: "x" }, profile: "landmark" });
    assert.equal(r.profile, "landmark");
  });

  it("falls back to the subject's default profile when nobody chose", async () => {
    net = pipelineNet({
      entity: entityRow({ name: "Vitalik Buterin", types: [{ name: "Person" }] }),
      plan: { factors: [], composition: "c" },
    });
    const r = await generateImage({ subject: { kind: "entity", ref: "0".repeat(32) }, profile: "auto" });
    assert.equal(r.profile, "portrait", "a person defaults to a portrait");
  });

  it("invents a factor for the subject when the planner returns none", async () => {
    net = pipelineNet({
      entity: entityRow({ name: "Ethereum" }),
      ownRelations: [{
        typeId: "1155befffad549b7a2e0da4777b8792c",
        toEntity: { valuesList: [{ propertyId: "8a743832c0944a62b6650c3cc2f9c7bc", text: "ipfs://cid" }] },
      }],
      plan: { factors: [], composition: "a coin" },
      images: ["/cid"],
    });
    const r = await generateImage({ subject: { kind: "entity", ref: "0".repeat(32) } });
    assert.equal(r.refs.length, 1, "the subject itself is still worth a reference");
    assert.equal(r.refs[0].name, "Ethereum");
  });

  it("reports each stage", async () => {
    net = pipelineNet({ plan: { factors: [], composition: "c" } });
    const stages: string[] = [];
    await generateImage({ subject: { kind: "text", text: "x" }, onStage: (s) => stages.push(s) });
    assert.deepEqual(stages, ["resolve", "plan", "refs", "render"]);
  });

  it("propagates a subject that cannot be resolved", async () => {
    net = mockFetch(() => geoRes({ entity: null }));
    await assert.rejects(
      () => generateImage({ subject: { kind: "entity", ref: "0".repeat(32) } }),
      /no entity found/,
    );
  });
});

// ── news back-compat ────────────────────────────────────────────────
describe("generateGroundedCover", () => {
  it("keeps the old signature, shape and editorial/banner look", async () => {
    net = pipelineNet({ plan: { factors: [], composition: "a lawyer leaves a courthouse" } });
    const r = await generateGroundedCover("SEC drops its case", "context");

    assert.deepEqual(Object.keys(r).sort(), ["imageBase64", "mimeType", "sceneDescription", "trace"]);
    assert.equal(r.sceneDescription, "a lawyer leaves a courthouse");
    assert.equal(r.mimeType, "image/png");
    assert.equal(net.to("/images/generations")[0].json.size, "1536x640");
    assert.ok(net.to("/images/generations")[0].json.prompt.includes("Wide cinematic 21:9 banner."));
    assert.equal(net.to("geobrowser").length, 0, "a story never touches the graph");
  });

  it("falls back to the headline when the planner gives no composition", async () => {
    net = pipelineNet({ plan: {} });
    const r = await generateGroundedCover("SEC drops its case", "");
    assert.equal(r.sceneDescription, "a single real scene that stands for SEC drops its case");
  });
});
