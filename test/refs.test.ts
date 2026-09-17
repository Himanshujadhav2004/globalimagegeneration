import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import {
  download, isMarkup, isSvg, refGate, resetSharpCache, resolveCandidates, resolveRefs,
  setDbImageResolver, sniff, ENTITY_MIN_CONF,
} from "../src/refs.js";
import { CONF, MAX_REF_TRIES_PERSON } from "../src/config.js";
import {
  bytesRes, chatRes, errorRes, GIF_BYTES, HTML_BYTES, JPEG_BYTES, jsonRes, mockFetch,
  PNG_BYTES, SVG_BYTES, textRes, WEBP_BYTES, type MockHandle,
} from "./helpers/mock.js";

let net: MockHandle | null = null;

before(() => {
  process.env.GEO_IMAGE_SLEEP_SCALE = "0";
  process.env.OPENAI_API_KEY ||= "test-key";
});

afterEach(() => {
  net?.restore();
  net = null;
  setDbImageResolver(null);
  delete process.env.GEO_IMAGE_NO_SHARP;
  resetSharpCache();
});

const noSharp = () => {
  process.env.GEO_IMAGE_NO_SHARP = "1";
  resetSharpCache();
};

// ── byte sniffing ───────────────────────────────────────────────────
describe("sniff", () => {
  it("recognises the formats the edits endpoint takes", () => {
    assert.equal(sniff(PNG_BYTES), "png");
    assert.equal(sniff(JPEG_BYTES), "jpeg");
    assert.equal(sniff(WEBP_BYTES), "webp");
    assert.equal(sniff(GIF_BYTES), "gif");
  });

  it("returns null for anything else", () => {
    assert.equal(sniff(HTML_BYTES), null);
    assert.equal(sniff(SVG_BYTES), null);
    assert.equal(sniff(Buffer.alloc(0)), null);
    assert.equal(sniff(Buffer.from([0x89])), null, "a truncated PNG header is not a PNG");
    assert.equal(sniff(Buffer.from("RIFFxxxxAVI ")), null, "RIFF alone is not WEBP");
  });
});

describe("isSvg / isMarkup", () => {
  it("spots an SVG with or without an XML prologue", () => {
    assert.equal(isSvg(SVG_BYTES), true);
    assert.equal(isSvg(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), true);
    assert.equal(isSvg(Buffer.from('   \n<SVG width="1"/>')), true);
  });

  it("does not mistake HTML or binary for SVG", () => {
    assert.equal(isSvg(HTML_BYTES), false);
    assert.equal(isSvg(PNG_BYTES), false);
  });

  it("spots an HTML error page", () => {
    assert.equal(isMarkup(HTML_BYTES), true);
    assert.equal(isMarkup(Buffer.from("<html><body>429</body></html>")), true);
    assert.equal(isMarkup(Buffer.from("  \n<!DOCTYPE HTML PUBLIC ...")), true);
  });

  it("does not flag an SVG or an image as markup", () => {
    assert.equal(isMarkup(SVG_BYTES), false);
    assert.equal(isMarkup(PNG_BYTES), false);
    assert.equal(isMarkup(Buffer.alloc(0)), false);
  });
});

// ── download ────────────────────────────────────────────────────────
describe("download", () => {
  it("passes a PNG and a JPEG straight through", async () => {
    net = mockFetch((url) => bytesRes(url.includes("png") ? PNG_BYTES : JPEG_BYTES, "image/png"));
    assert.deepEqual(await download("https://x.test/a.png"), { buf: PNG_BYTES, mime: "image/png" });
    assert.deepEqual((await download("https://x.test/a.jpg"))!.mime, "image/jpeg");
  });

  it("keeps a WEBP as a WEBP", async () => {
    net = mockFetch(() => bytesRes(WEBP_BYTES, "image/webp"));
    assert.equal((await download("https://x.test/a.webp"))!.mime, "image/webp");
  });

  it("rejects a gateway that answers 200 with text/html", async () => {
    net = mockFetch(() => textRes("<!DOCTYPE html><title>Wikimedia Error</title>", 200, "text/html"));
    assert.equal(await download("https://ipfs.io/ipfs/cid"), null);
  });

  it("rejects an HTML body even when the content-type lies", async () => {
    // This is the real failure: a CID that holds a saved error page.
    net = mockFetch(() => bytesRes(HTML_BYTES, "image/jpeg"));
    assert.equal(await download("https://ipfs.io/ipfs/cid"), null);
  });

  it("rejects a JSON body", async () => {
    net = mockFetch(() => jsonRes({ error: "not found" }));
    assert.equal(await download("https://x.test/a.png"), null);
  });

  it("returns null on 404, on an empty body and on a network error", async () => {
    net = mockFetch((url) => {
      if (url.includes("404")) return errorRes(404);
      if (url.includes("empty")) return bytesRes(Buffer.alloc(0), "image/png");
      return new Error("ECONNRESET");
    });
    assert.equal(await download("https://x.test/404.png"), null);
    assert.equal(await download("https://x.test/empty.png"), null);
    assert.equal(await download("https://x.test/boom.png"), null);
  });

  it("refuses a file that declares itself enormous", async () => {
    net = mockFetch(() => new Response(new Uint8Array(PNG_BYTES), {
      headers: { "content-type": "image/png", "content-length": String(64 * 1024 * 1024) },
    }));
    assert.equal(await download("https://x.test/huge.png"), null);
  });

  it("converts an SVG logo to PNG when sharp is available", async () => {
    net = mockFetch(() => bytesRes(SVG_BYTES, "image/svg+xml"));
    const out = await download("https://x.test/logo.svg");
    assert.ok(out, "sharp should rasterise an SVG");
    assert.equal(out!.mime, "image/png");
    assert.equal(sniff(out!.buf), "png");
  });

  it("converts a GIF to PNG when sharp is available", async () => {
    net = mockFetch(() => bytesRes(GIF_BYTES, "image/gif"));
    const out = await download("https://x.test/a.gif");
    assert.equal(out!.mime, "image/png");
  });

  it("skips SVG and GIF rather than failing when sharp is missing", async () => {
    noSharp();
    net = mockFetch((url) => bytesRes(url.endsWith(".svg") ? SVG_BYTES : GIF_BYTES, "image/x"));
    assert.equal(await download("https://x.test/logo.svg"), null);
    assert.equal(await download("https://x.test/a.gif"), null);
  });

  it("still serves PNG and JPEG without sharp", async () => {
    noSharp();
    net = mockFetch(() => bytesRes(PNG_BYTES, "image/png"));
    assert.deepEqual((await download("https://x.test/a.png"))!.mime, "image/png");
  });

  it("without sharp, refuses an image too large to shrink", async () => {
    noSharp();
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(5_000_000)]);
    net = mockFetch(() => bytesRes(big, "image/png"));
    assert.equal(await download("https://x.test/big.png"), null);
  });

  it("rejects bytes that are not an image at all", async () => {
    net = mockFetch(() => bytesRes(Buffer.from("just some text, no header"), "application/octet-stream"));
    assert.equal(await download("https://x.test/a.bin"), null);
  });
});

// ── candidate chains ────────────────────────────────────────────────
async function collect(gen: AsyncGenerator<{ url: string; src: string; conf: number }>) {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("resolveCandidates", () => {
  it("yields the subject's own graph images first, one per gateway", async () => {
    net = mockFetch(() => errorRes(404));
    const got = await collect(resolveCandidates("person", "Vitalik Buterin", "Vitalik Buterin", {
      ownImageUrls: ["https://g1/cid", "https://g2/cid"],
    }));
    assert.equal(got[0].src, "geo-own");
    assert.equal(got[0].conf, CONF["geo-own"]);
    assert.deepEqual(got.slice(0, 2).map((c) => c.url), ["https://g1/cid", "https://g2/cid"]);
  });

  it("de-duplicates repeated own-image URLs", async () => {
    net = mockFetch(() => errorRes(404));
    const got = await collect(resolveCandidates("concept", "x", "", { ownImageUrls: ["https://g/cid", "https://g/cid"] }));
    assert.equal(got.length, 1);
  });

  it("gives a concept nothing but its own image", async () => {
    net = mockFetch(() => {
      throw new Error("a concept must not hit the web");
    });
    assert.deepEqual(await collect(resolveCandidates("concept", "an invented coin", "", {})), []);
    const own = await collect(resolveCandidates("concept", "x", "", { ownImageUrls: ["https://g/cid"] }));
    assert.equal(own.length, 1);
  });

  it("gives an unknown kind nothing either", async () => {
    net = mockFetch(() => errorRes(404));
    assert.deepEqual(await collect(resolveCandidates("wibble", "x", "x", {})), []);
  });

  it("walks the person chain in order", async () => {
    net = mockFetch((url) => {
      if (url.includes("geobrowser")) return jsonRes({ data: { entities: [] } });
      if (url.includes("en.wikipedia.org") && url.includes("list=search")) {
        return jsonRes({ query: { search: [{ title: "Vitalik Buterin" }] } });
      }
      if (url.includes("en.wikipedia.org")) {
        return jsonRes({ query: { pages: { 1: { thumbnail: { source: "https://wiki/vb.jpg" } } } } });
      }
      if (url.includes("commons")) return jsonRes({ query: { search: [{ title: "File:VB.jpg" }] } });
      return errorRes(404);
    });
    const got = await collect(resolveCandidates("person", "Vitalik Buterin", "", {}));
    assert.deepEqual(got.map((c) => c.src), ["wikipedia"]);
    assert.equal(got[0].url, "https://wiki/vb.jpg");
  });

  it("uses the registered entity database first when the host app provides one", async () => {
    setDbImageResolver(async (name, kind) => (kind === "person" ? `https://db/${name}.jpg` : null));
    net = mockFetch(() => errorRes(404));
    const got = await collect(resolveCandidates("person", "VB", "", {}));
    assert.equal(got[0].src, "db");
    assert.equal(got[0].url, "https://db/VB.jpg");
  });

  it("skips the db source when no resolver is registered", async () => {
    net = mockFetch(() => errorRes(404));
    const got = await collect(resolveCandidates("person", "VB", "", {}));
    assert.ok(!got.some((c) => c.src === "db"));
  });

  it("keeps walking when a source throws", async () => {
    setDbImageResolver(async () => {
      throw new Error("database down");
    });
    net = mockFetch((url) => {
      if (url.includes("coingecko")) return jsonRes({ coins: [{ large: "https://cg/eth.png" }] });
      return errorRes(404);
    });
    const got = await collect(resolveCandidates("crypto", "Ethereum", "Ethereum", {}));
    assert.equal(got[0].src, "coingecko");
  });

  it("only calls Brandfetch when a key and a domain are present", async () => {
    net = mockFetch(() => errorRes(404));
    await collect(resolveCandidates("company", "OpenAI", "OpenAI", { domain: "openai.com" }));
    assert.equal(net.to("brandfetch").length, 0, "no key configured");

    net.restore();
    process.env.BRANDFETCH_KEY = "bf-key";
    net = mockFetch((url) => (url.includes("brandfetch") ? jsonRes({ logos: [{ formats: [{ src: "https://bf/logo.png" }] }] }) : errorRes(404)));
    try {
      const got = await collect(resolveCandidates("company", "OpenAI", "OpenAI", { domain: "openai.com" }));
      assert.equal(got[0].src, "brandfetch");
    } finally {
      delete process.env.BRANDFETCH_KEY;
    }
  });

  it("type-checks a Wikidata hit against the kind before using its image", async () => {
    net = mockFetch((url) => {
      if (url.includes("wbsearchentities")) {
        return jsonRes({ search: [{ id: "Q1", description: "star in the constellation" }, { id: "Q2", description: "cryptocurrency" }] });
      }
      if (url.includes("wbgetentities")) {
        const qid = new URL(url).searchParams.get("ids");
        assert.equal(qid, "Q2", "the star must be skipped");
        return jsonRes({ entities: { Q2: { claims: { P154: [{ mainsnak: { datavalue: { value: "Stellar logo.svg" } } }] } } } });
      }
      return errorRes(404);
    });
    const got = await collect(resolveCandidates("crypto", "Stellar", "Stellar Lumens", {}));
    assert.equal(got[0].src, "wikidata");
    assert.match(got[0].url, /Stellar_logo\.svg/);
  });

  it("every configured source is trusted enough to be tried", () => {
    for (const [src, conf] of Object.entries(CONF)) {
      assert.ok(conf >= ENTITY_MIN_CONF, `${src} would be filtered out by ENTITY_MIN_CONF`);
    }
  });
});

// ── the gate ────────────────────────────────────────────────────────
describe("refGate", () => {
  it("accepts a YES", async () => {
    net = mockFetch(() => chatRes("YES"));
    assert.deepEqual(await refGate(PNG_BYTES, "image/png", "VB", "person"), { ok: true, reason: "ok" });
  });

  it("names the reason for a rejection by kind", async () => {
    net = mockFetch(() => chatRes("NO"));
    assert.equal((await refGate(PNG_BYTES, "image/png", "VB", "person")).reason, "not-this-person");
    assert.equal((await refGate(PNG_BYTES, "image/png", "SEC", "government")).reason, "wrong-ref");
  });

  it("asks a face question for people and a usability question otherwise", async () => {
    net = mockFetch(() => chatRes("YES"));
    await refGate(PNG_BYTES, "image/png", "VB", "person");
    await refGate(PNG_BYTES, "image/png", "SEC", "government");
    assert.match(net.calls[0].json.messages[0].content[0].text, /likeness of one specific real person/);
    assert.match(net.calls[1].json.messages[0].content[0].text, /clearly UNUSABLE/);
    assert.match(net.calls[0].json.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  });

  it("fails OPEN when the vision call errors", async () => {
    net = mockFetch(() => errorRes(400, "bad image"));
    assert.deepEqual(await refGate(PNG_BYTES, "image/png", "VB", "person"), { ok: true, reason: "gate-error" });
  });

  it("treats an unexpected reply as a rejection", async () => {
    net = mockFetch(() => chatRes("I'm not sure about that."));
    assert.equal((await refGate(PNG_BYTES, "image/png", "VB", "person")).ok, false);
  });
});

// ── the resolve loop ────────────────────────────────────────────────
/** Route: OpenAI -> a gate verdict from `verdicts`; anything else -> `bytesFor(url)`. */
function refNet(verdicts: string[], bytesFor: (url: string) => Response) {
  let i = 0;
  return mockFetch((url) => {
    if (url.includes("openai.com")) return chatRes(verdicts[Math.min(i++, verdicts.length - 1)]);
    return bytesFor(url);
  });
}

describe("resolveRefs", () => {
  const factor = (over: Partial<Record<string, any>> = {}) => ({
    name: "Vitalik Buterin", kind: "person", role: "at the lectern", refQuery: "", domain: "", ownImageUrls: [], ...over,
  });

  it("keeps the first candidate that passes the gate", async () => {
    net = refNet(["YES"], () => bytesRes(PNG_BYTES, "image/png"));
    const out = await resolveRefs([factor({ ownImageUrls: ["https://g1/cid", "https://g2/cid"] })]);
    assert.equal(out.refs.length, 1);
    assert.equal(out.refs[0].src, "geo-own");
    assert.equal(out.refs[0].name, "Vitalik Buterin");
    assert.equal(out.refs[0].role, "at the lectern");
    assert.deepEqual(out.described, []);
    assert.match(out.scores[0], /^Vitalik Buterin=geo-own:0\.99@t1$/);
  });

  it("does not burn a try on a gateway that serves an error page", async () => {
    net = refNet(["YES"], (url) => (url.includes("g3") ? bytesRes(PNG_BYTES, "image/png") : textRes("<html>", 200, "text/html")));
    const out = await resolveRefs([factor({ ownImageUrls: ["https://g1/cid", "https://g2/cid", "https://g3/cid"] })]);
    assert.equal(out.refs.length, 1);
    assert.match(out.scores[0], /@t1$/, "two dead gateways cost no tries");
  });

  it("moves to the next candidate when the gate says no", async () => {
    net = refNet(["NO", "YES"], () => bytesRes(PNG_BYTES, "image/png"));
    const out = await resolveRefs([factor({ ownImageUrls: ["https://g1/a", "https://g2/b"] })]);
    assert.equal(out.refs.length, 1);
    assert.match(out.scores[0], /@t2$/);
  });

  it("gives a person six tries and everything else two", async () => {
    // People are worth digging for: the chain is long, a ranked search yields
    // several candidates, and hotlink-blocked hits are common.
    const urls = ["1", "2", "3", "4", "5", "6", "7", "8"].map((n) => `https://g${n}/cid`);
    net = refNet(["NO"], () => bytesRes(PNG_BYTES, "image/png"));
    const person = await resolveRefs([factor({ ownImageUrls: urls })]);
    assert.equal(net.to("openai.com").length, MAX_REF_TRIES_PERSON);
    assert.equal(MAX_REF_TRIES_PERSON, 6);

    net.restore();
    net = refNet(["NO"], () => bytesRes(PNG_BYTES, "image/png"));
    await resolveRefs([factor({ kind: "company", name: "ACME", ownImageUrls: urls })]);
    assert.equal(net.to("openai.com").length, 2);
    assert.match(person.scores[0], /describe\(⊘not-this-person\)/);
  });

  it("describes a factor whose references all fail", async () => {
    net = refNet(["NO"], () => bytesRes(PNG_BYTES, "image/png"));
    const out = await resolveRefs([factor({ ownImageUrls: ["https://g1/a"] })]);
    assert.deepEqual(out.refs, []);
    assert.deepEqual(out.described, [{ name: "Vitalik Buterin", role: "at the lectern" }]);
    assert.match(out.scores[0], /describe\(⊘not-this-person\)/);
  });

  it("describes a factor that has no candidates at all", async () => {
    net = refNet(["YES"], () => errorRes(404));
    const out = await resolveRefs([{ name: "an invented coin", kind: "concept", role: "on the desk" }]);
    assert.deepEqual(out.described, [{ name: "an invented coin", role: "on the desk" }]);
    assert.equal(out.scores[0], "an invented coin=describe(none)");
  });

  it("stops collecting references at the cap and describes the rest", async () => {
    net = refNet(["YES"], () => bytesRes(PNG_BYTES, "image/png"));
    const factors = ["a", "b", "c", "d", "e"].map((n) => factor({ name: n, ownImageUrls: [`https://g/${n}`] }));
    const out = await resolveRefs(factors);
    assert.equal(out.refs.length, 4);
    assert.deepEqual(out.described.map((d) => d.name), ["e"]);
    assert.equal(out.scores[4], "e=describe(none)");
  });

  it("names a factor with no name so the trace stays readable", async () => {
    net = refNet(["YES"], () => errorRes(404));
    const out = await resolveRefs([{ name: "", kind: "concept", role: "" }]);
    assert.deepEqual(out.described, [{ name: "?", role: "" }]);
  });

  it("returns nothing at all for no factors", async () => {
    net = refNet(["YES"], () => errorRes(404));
    assert.deepEqual(await resolveRefs([]), { refs: [], described: [], scores: [] });
  });
});

// ── person identity: Firecrawl + the identity gate ──────────────────
describe("person chain with Firecrawl", () => {
  const fcRes = (...urls: string[]) =>
    jsonRes({ success: true, data: { images: urls.map((u) => ({ imageUrl: u })) } });

  it("puts Firecrawl after Wikipedia and before Commons", async () => {
    process.env.FIRECRAWL_KEY = "fc-test";
    try {
      net = mockFetch((url) => {
        if (url.includes("firecrawl")) return fcRes("https://fc/a.jpg", "https://fc/b.jpg");
        if (url.includes("geobrowser")) return jsonRes({ data: { entities: [] } });
        if (url.includes("en.wikipedia.org") && url.includes("list=search")) {
          return jsonRes({ query: { search: [{ title: "T" }] } });
        }
        if (url.includes("en.wikipedia.org")) {
          return jsonRes({ query: { pages: { 1: { thumbnail: { source: "https://wiki/p.jpg" } } } } });
        }
        if (url.includes("commons") && url.includes("list=search")) {
          return jsonRes({ query: { search: [{ title: "File:C.jpg" }] } });
        }
        if (url.includes("commons")) return jsonRes({ query: { pages: { 1: { imageinfo: [{ url: "https://c/c.jpg" }] } } } });
        return errorRes(404);
      });
      const got = await collect(resolveCandidates("person", "Robert Turner", "", { context: "British diabetologist" }));
      assert.deepEqual(got.map((c) => c.src), ["wikipedia", "firecrawl", "firecrawl", "commons"]);
      assert.equal(got[1].conf, CONF.firecrawl);
    } finally {
      delete process.env.FIRECRAWL_KEY;
    }
  });

  it("turns one ranked search into several candidates so a 403 is survivable", async () => {
    process.env.FIRECRAWL_KEY = "fc-test";
    try {
      net = mockFetch((url) => (url.includes("firecrawl") ? fcRes("https://fc/1", "https://fc/2", "https://fc/3") : errorRes(404)));
      const got = await collect(resolveCandidates("person", "X", "", { context: "c" }));
      assert.deepEqual(got.filter((c) => c.src === "firecrawl").map((c) => c.url), ["https://fc/1", "https://fc/2", "https://fc/3"]);
    } finally {
      delete process.env.FIRECRAWL_KEY;
    }
  });

  it("passes the Geo description to Firecrawl", async () => {
    process.env.FIRECRAWL_KEY = "fc-test";
    try {
      net = mockFetch((url) => (url.includes("firecrawl") ? fcRes("https://fc/1") : errorRes(404)));
      await collect(resolveCandidates("person", "Robert Turner", "", { context: "British diabetologist at Oxford" }));
      const call = net.to("firecrawl")[0];
      assert.equal(call.json.query, "Robert Turner British diabetologist at Oxford");
    } finally {
      delete process.env.FIRECRAWL_KEY;
    }
  });

  it("skips Firecrawl entirely for non-people", async () => {
    process.env.FIRECRAWL_KEY = "fc-test";
    try {
      net = mockFetch(() => errorRes(404));
      await collect(resolveCandidates("company", "ACME", "ACME", { context: "a firm" }));
      assert.equal(net.to("firecrawl").length, 0, "logos do not need open-web face search");
    } finally {
      delete process.env.FIRECRAWL_KEY;
    }
  });
});

describe("identity-aware person gate", () => {
  it("checks the candidate against the dossier, not just 'is it a face'", async () => {
    net = mockFetch(() => chatRes("NO"));
    const r = await refGate(PNG_BYTES, "image/png", "Robert Turner", "person",
      "British diabetologist and professor at the University of Oxford");
    const asked = net.calls[0].json.messages[0].content[0].text;
    assert.match(asked, /WHO THEY ARE: British diabetologist/);
    assert.match(asked, /DIFFERENT person who happens to share the name/);
    assert.equal(r.reason, "not-this-person");
  });

  it("does not ask the model to judge by ethnicity", async () => {
    net = mockFetch(() => chatRes("YES"));
    await refGate(PNG_BYTES, "image/png", "X", "person", "a description");
    assert.match(net.calls[0].json.messages[0].content[0].text, /do not judge by ethnicity/);
  });

  it("leaves non-people lenient", async () => {
    net = mockFetch(() => chatRes("NO"));
    const r = await refGate(PNG_BYTES, "image/png", "SEC", "government", "an agency");
    assert.match(net.calls[0].json.messages[0].content[0].text, /clearly UNUSABLE/);
    assert.equal(r.reason, "wrong-ref");
  });

  it("still fails OPEN on an API error", async () => {
    net = mockFetch(() => errorRes(500));
    assert.deepEqual(await refGate(PNG_BYTES, "image/png", "X", "person", "c"), { ok: true, reason: "gate-error" });
  });

  it("hands the factor's context to the gate", async () => {
    net = refNet(["NO"], () => bytesRes(PNG_BYTES, "image/png"));
    await resolveRefs([{
      name: "Robert Turner", kind: "person", role: "r",
      ownImageUrls: ["https://g/a"], context: "British diabetologist at Oxford",
    }]);
    assert.match(net.to("openai.com")[0].json.messages[0].content[0].text, /WHO THEY ARE: British diabetologist at Oxford/);
  });
});
