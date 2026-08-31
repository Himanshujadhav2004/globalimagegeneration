import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeGeoId, looksLikeGeoId, ordinal, parseJSON, slugify, tidy, uniqueBy } from "../src/util.js";

describe("parseJSON", () => {
  it("parses plain JSON", () => {
    assert.deepEqual(parseJSON<{ a: number }>('{"a":1}'), { a: 1 });
  });

  it("parses a fenced block", () => {
    assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJSON("```\n{\"a\":1}\n```"), { a: 1 });
  });

  it("ignores prose before and after the object", () => {
    assert.deepEqual(parseJSON('Sure! Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
  });

  it("does not stop at a brace inside a string", () => {
    const out = parseJSON<{ role: string }>('{"role":"holds a } brace","k":2}');
    assert.equal(out.role, "holds a } brace");
  });

  it("handles an escaped quote before a brace", () => {
    const out = parseJSON<{ role: string }>('{"role":"say \\"hi\\" }","k":2}');
    assert.equal(out.role, 'say "hi" }');
  });

  it("parses a top-level array", () => {
    assert.deepEqual(parseJSON<number[]>("[1,2,3]"), [1, 2, 3]);
  });

  it("strips a BOM", () => {
    assert.deepEqual(parseJSON('﻿{"a":1}'), { a: 1 });
  });

  it("throws on empty output", () => {
    assert.throws(() => parseJSON(""), /empty output/);
    assert.throws(() => parseJSON("   \n "), /empty output/);
  });

  it("throws on unparseable output", () => {
    assert.throws(() => parseJSON("I cannot help with that."), /did not return JSON/);
    assert.throws(() => parseJSON("{unclosed"), /did not return JSON/);
  });

  it("reports the head of the bad output so a failure is debuggable", () => {
    assert.throws(() => parseJSON("nope nope nope"), /nope nope nope/);
  });
});

describe("ordinal", () => {
  it("names the first eight", () => {
    assert.equal(ordinal(0), "first");
    assert.equal(ordinal(4), "fifth");
    assert.equal(ordinal(7), "eighth");
  });

  it("falls back to a numeric ordinal past the table", () => {
    assert.equal(ordinal(8), "9th");
    assert.equal(ordinal(20), "21th");
  });
});

describe("slugify", () => {
  it("makes a filesystem-safe slug", () => {
    assert.equal(slugify("Vitalik Buterin"), "vitalik-buterin");
    assert.equal(slugify("  SEC v. Ripple: round 2!  "), "sec-v-ripple-round-2");
  });

  it("folds accents and drops non-latin", () => {
    assert.equal(slugify("Café Münster"), "cafe-munster");
  });

  it("survives an empty or symbol-only name", () => {
    assert.equal(slugify(""), "");
    assert.equal(slugify("!!!"), "");
    assert.equal(slugify(undefined as any), "");
  });

  it("caps the length", () => {
    assert.ok(slugify("x".repeat(200)).length <= 80);
  });
});

describe("tidy", () => {
  it("collapses whitespace", () => {
    assert.equal(tidy("  a\n\n b  \t c "), "a b c");
  });

  it("truncates with an ellipsis", () => {
    const out = tidy("abcdefghij", 5);
    assert.equal(out, "abcd…");
    assert.equal(out.length, 5);
  });

  it("handles null and undefined", () => {
    assert.equal(tidy(null), "");
    assert.equal(tidy(undefined), "");
    assert.equal(tidy(42), "42");
  });
});

describe("uniqueBy", () => {
  it("keeps the first of each key, in order", () => {
    const out = uniqueBy(["a", "b", "a", "c"], (s) => s);
    assert.deepEqual(out, ["a", "b", "c"]);
  });

  it("keeps every item whose key is empty", () => {
    const out = uniqueBy([{ k: "" }, { k: "" }], (o) => o.k);
    assert.equal(out.length, 2);
  });
});

describe("normalizeGeoId", () => {
  it("accepts a bare 32-hex id", () => {
    assert.equal(normalizeGeoId("0068f0fc16034c749c991e6eabe37031"), "0068f0fc16034c749c991e6eabe37031");
  });

  it("accepts a dashed UUID and strips the dashes", () => {
    assert.equal(normalizeGeoId("0068f0fc-1603-4c74-9c99-1e6eabe37031"), "0068f0fc16034c749c991e6eabe37031");
  });

  it("lowercases", () => {
    assert.equal(normalizeGeoId("0068F0FC16034C749C991E6EABE37031"), "0068f0fc16034c749c991e6eabe37031");
  });

  it("trims surrounding whitespace", () => {
    assert.equal(normalizeGeoId("  0068f0fc16034c749c991e6eabe37031 "), "0068f0fc16034c749c991e6eabe37031");
  });

  it("rejects names and malformed ids", () => {
    for (const bad of ["Ethereum", "", "  ", "0068f0fc", "z".repeat(32), "0068f0fc16034c749c991e6eabe370311"]) {
      assert.equal(normalizeGeoId(bad), null, `expected null for ${JSON.stringify(bad)}`);
    }
    assert.equal(normalizeGeoId(undefined as any), null);
  });

  it("looksLikeGeoId agrees", () => {
    assert.equal(looksLikeGeoId("0068f0fc16034c749c991e6eabe37031"), true);
    assert.equal(looksLikeGeoId("Ethereum"), false);
  });
});
