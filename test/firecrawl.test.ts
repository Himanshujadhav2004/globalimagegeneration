import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { firecrawlEnabled, firecrawlImages } from "../src/firecrawl.js";
import { errorRes, jsonRes, mockFetch, textRes, type MockHandle } from "./helpers/mock.js";

let net: MockHandle | null = null;
const KEY = "FIRECRAWL_API_KEY";
let saved: string | undefined;

const withKey = (v: string | undefined) => {
  saved ??= process.env[KEY];
  if (v === undefined) delete process.env[KEY];
  else process.env[KEY] = v;
};

afterEach(() => {
  net?.restore();
  net = null;
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
  saved = undefined;
  delete process.env.FIRECRAWL_KEY;
});

/** A reply shaped like the live /v2/search response. */
const images = (...urls: string[]) =>
  jsonRes({ success: true, data: { images: urls.map((u, i) => ({ title: `result ${i}`, imageUrl: u })) } });

describe("firecrawlImages", () => {
  it("searches the name PLUS the Geo description", async () => {
    withKey("fc-test");
    net = mockFetch(() => images("https://a/1.jpg"));
    await firecrawlImages("Robert Turner", "British diabetologist and professor at the University of Oxford");

    const body = net.calls[0].json;
    assert.equal(
      body.query,
      "Robert Turner British diabetologist and professor at the University of Oxford",
      "the bare name alone returns a media mogul — the description is what disambiguates",
    );
    assert.deepEqual(body.sources, ["images"]);
    assert.equal(body.limit, 6);
    assert.match(net.calls[0].init.headers.Authorization, /^Bearer fc-test$/);
    assert.match(net.calls[0].url, /api\.firecrawl\.dev\/v2\/search$/);
  });

  it("returns every candidate in order, not just the first", async () => {
    // The top hit is frequently hotlink-protected, so the caller needs the rest.
    withKey("fc-test");
    net = mockFetch(() => images("https://a/1.jpg", "https://b/2.jpg", "https://c/3.jpg"));
    assert.deepEqual(await firecrawlImages("X", "y"), ["https://a/1.jpg", "https://b/2.jpg", "https://c/3.jpg"]);
  });

  it("de-duplicates and drops non-http entries", async () => {
    withKey("fc-test");
    net = mockFetch(() => jsonRes({
      data: { images: [
        { imageUrl: "https://a/1.jpg" }, { imageUrl: "https://a/1.jpg" },
        { imageUrl: "data:image/png;base64,xx" }, { imageUrl: "" }, {}, { url: "https://b/2.jpg" },
      ] },
    }));
    assert.deepEqual(await firecrawlImages("X", "y"), ["https://a/1.jpg", "https://b/2.jpg"]);
  });

  it("is disabled, and silent, without a key", async () => {
    withKey(undefined);
    net = mockFetch(() => images("https://a/1.jpg"));
    assert.equal(firecrawlEnabled(), false);
    assert.deepEqual(await firecrawlImages("X", "y"), []);
    assert.equal(net.calls.length, 0, "must not call a paid API with no key configured");
  });

  it("accepts either env name", async () => {
    withKey(undefined);
    process.env.FIRECRAWL_KEY = "fc-alt";
    net = mockFetch(() => images("https://a/1.jpg"));
    assert.equal(firecrawlEnabled(), true);
    assert.deepEqual(await firecrawlImages("X", "y"), ["https://a/1.jpg"]);
  });

  it("never throws — a bad key, a 500, a timeout or junk all yield []", async () => {
    withKey("fc-test");
    for (const reply of [errorRes(401), errorRes(500), textRes("<html>gateway</html>"), jsonRes({ success: false })]) {
      net?.restore();
      net = mockFetch(() => reply);
      assert.deepEqual(await firecrawlImages("X", "y"), []);
    }
    net?.restore();
    net = mockFetch(() => new Error("ETIMEDOUT"));
    assert.deepEqual(await firecrawlImages("X", "y"), []);
  });

  it("skips an empty name rather than searching for the description alone", async () => {
    withKey("fc-test");
    net = mockFetch(() => images("https://a/1.jpg"));
    assert.deepEqual(await firecrawlImages("  ", "a description"), []);
    assert.equal(net.calls.length, 0);
  });

  it("works with no context, just less precisely", async () => {
    withKey("fc-test");
    net = mockFetch(() => images("https://a/1.jpg"));
    await firecrawlImages("Ada Lovelace");
    assert.equal(net.calls[0].json.query, "Ada Lovelace");
  });
});
