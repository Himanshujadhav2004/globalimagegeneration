import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { firecrawlEnabled, firecrawlImages, titleNamesPerson } from "../src/firecrawl.js";
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

// ── the Thomas Ham failure: a result about somebody else entirely ────
describe("titleNamesPerson", () => {
  it("keeps the right man and drops the impostor that broke Thomas Ham", () => {
    // Live results for "Thomas Ham American hematologist ...", in rank order.
    const real = "Thomas Ham";
    assert.equal(titleNamesPerson("Dr Thomas Hale Ham (1905-1987) - Find a Grave Memorial", real), true);
    assert.equal(titleNamesPerson("Jesús San Miguel, MD, PhD - International Myeloma Society", real), false);
    assert.equal(titleNamesPerson("Swaminathan P. Iyer | UT MD Anderson", real), false);
    assert.equal(titleNamesPerson("Professor David Thomas", real), false, "shares one token, not both");
    assert.equal(titleNamesPerson("Dolly Parton Children's Hospital couple Dr. Jennifer and Dr. Austin Hamm", real), false);
  });

  it("tolerates a clipped or varied spelling", () => {
    assert.equal(titleNamesPerson("Afshin Matin-Asgar | CSU", "Afshin Matin-Asgari"), true);
    assert.equal(titleNamesPerson("Dr. Afshin Matin-Asgari - UCLA (January 11, 2009)", "Afshin Matin-Asgari"), true);
  });

  it("ignores accents, punctuation, honorifics and particles", () => {
    assert.equal(titleNamesPerson("Albert de la Chapelle (1933–2020)", "Albert de la Chapelle"), true);
    assert.equal(titleNamesPerson("PROF. ALBERT DE LA CHAPELLE", "Albert de la Chapelle"), true);
    assert.equal(titleNamesPerson("Jesus San Miguel", "Jesús San Miguel"), true);
  });

  it("still admits same-name strangers — that is the vision gate's job", () => {
    assert.equal(titleNamesPerson("Robert Turner - Senior Research Software Engineer", "Robert Turner"), true);
    assert.equal(titleNamesPerson("Dr. Robert Turner (1938–1999)", "Robert Turner"), true);
  });

  it("rejects an untitled result and never filters when the name is unusable", () => {
    assert.equal(titleNamesPerson("", "Thomas Ham"), false);
    assert.equal(titleNamesPerson("anything at all", "  "), true);
  });

  it("filters the live-shaped payload end to end", async () => {
    process.env.FIRECRAWL_KEY = "fc-test";
    try {
      net = mockFetch(() => jsonRes({
        data: { images: [
          { title: "Dr Thomas Hale Ham (1905-1987) - Find a Grave Memorial", imageUrl: "https://ok/1.jpg" },
          { title: "Jesús San Miguel, MD, PhD", imageUrl: "https://wrong/2.jpg" },
          { title: "Swaminathan P. Iyer", imageUrl: "https://wrong/3.jpg" },
        ] },
      }));
      assert.deepEqual(await firecrawlImages("Thomas Ham", "American hematologist"), ["https://ok/1.jpg"]);
    } finally {
      delete process.env.FIRECRAWL_KEY;
    }
  });
});
