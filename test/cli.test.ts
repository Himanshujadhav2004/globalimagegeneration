import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, parseArgs, UsageError } from "../src/cli.js";
import { chatRes, geoRes, imageRes, mockFetch, PNG_BYTES, type MockHandle } from "./helpers/mock.js";

let net: MockHandle | null = null;
before(() => {
  process.env.GEO_IMAGE_SLEEP_SCALE = "0";
  process.env.OPENAI_API_KEY ||= "test-key";
});
afterEach(() => {
  net?.restore();
  net = null;
});

const ID = "0068f0fc16034c749c991e6eabe37031";

// ── parsing ─────────────────────────────────────────────────────────
describe("parseArgs", () => {
  it("parses a kind and a name", () => {
    const a = parseArgs(["entity", "Vitalik", "Buterin"]);
    assert.equal(a.kind, "entity");
    assert.equal(a.ref, "Vitalik Buterin", "unquoted multi-word names still work");
    assert.equal(a.profile, "auto");
    assert.equal(a.dryRun, false);
  });

  it("accepts --flag value and --flag=value", () => {
    const a = parseArgs(["entity", ID, "--profile", "emblem", "--space=" + ID]);
    assert.equal(a.profile, "emblem");
    assert.equal(a.spaceId, ID);
  });

  it("collects the boolean flags", () => {
    const a = parseArgs(["type", "City", "--dry-run", "--with-refs", "--json"]);
    assert.equal(a.dryRun, true);
    assert.equal(a.withRefs, true);
    assert.equal(a.json, true);
    assert.equal(a.printPrompt, true, "a dry run always shows the prompt it built");
  });

  it("takes a story from --headline and --summary", () => {
    const a = parseArgs(["story", "--headline", "SEC drops case", "--summary", "context"]);
    assert.equal(a.headline, "SEC drops case");
    assert.equal(a.summary, "context");
  });

  it("takes a story headline positionally too", () => {
    assert.equal(parseArgs(["story", "SEC drops case"]).ref, "SEC drops case");
  });

  it("rejects a missing or unknown kind", () => {
    assert.throws(() => parseArgs([]), UsageError);
    assert.throws(() => parseArgs(["planet", "mars"]), /unknown kind "planet"/);
    assert.throws(() => parseArgs(["planet", "mars"]), /entity, type, property/);
  });

  it("rejects a kind with nothing to look up", () => {
    assert.throws(() => parseArgs(["entity"]), /entity needs an id or a name/);
    assert.throws(() => parseArgs(["text"]), /text needs a brief/);
    assert.throws(() => parseArgs(["story"]), /story needs --headline/);
  });

  it("insists on an id for spaces and relations", () => {
    assert.throws(() => parseArgs(["space", "Crypto"]), /space needs an id/);
    assert.throws(() => parseArgs(["relation", "works at"]), /relation needs an id/);
    assert.equal(parseArgs(["space", ID]).ref, ID);
    assert.equal(parseArgs(["relation", "0068f0fc-1603-4c74-9c99-1e6eabe37031"]).kind, "relation");
  });

  it("rejects an unknown profile and says what is valid", () => {
    assert.throws(() => parseArgs(["type", "City", "--profile", "cinematic"]), /unknown profile "cinematic"/);
    assert.throws(() => parseArgs(["type", "City", "--profile", "cinematic"]), /editorial, portrait, landmark/);
  });

  it("rejects an unknown option instead of folding it into the subject name", () => {
    // --format was removed; a stale script must fail loudly, not search for
    // an entity called "City square".
    assert.throws(() => parseArgs(["type", "City", "--format", "square"]), /unknown option "--format"/);
    assert.throws(() => parseArgs(["type", "City", "--wibble"]), /unknown option "--wibble"/);
  });

  it("rejects a value flag with no value", () => {
    assert.throws(() => parseArgs(["type", "City", "--profile"]), /--profile needs a value/);
  });

  it("keeps auto as a valid profile", () => {
    assert.equal(parseArgs(["type", "City", "--profile", "auto"]).profile, "auto");
  });
});

// ── running ─────────────────────────────────────────────────────────
describe("main", () => {
  it("prints usage for --help and for no arguments", async () => {
    const lines: string[] = [];
    const log = console.log;
    console.log = (s: any) => lines.push(String(s));
    try {
      assert.equal(await main([]), 0);
      assert.equal(await main(["--help"]), 0);
    } finally {
      console.log = log;
    }
    assert.match(lines.join("\n"), /USAGE[\s\S]*KINDS[\s\S]*OPTIONS/);
  });

  it("returns exit code 2 and explains a bad invocation", async () => {
    const errs: string[] = [];
    const err = console.error;
    console.error = (s: any) => errs.push(String(s));
    try {
      assert.equal(await main(["wibble"]), 2);
    } finally {
      console.error = err;
    }
    assert.match(errs.join("\n"), /unknown kind "wibble"/);
  });

  it("writes the rendered image and reports it as JSON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geo-image-"));
    const out = join(dir, "eth.png");
    net = mockFetch((url, _i, call) => {
      if (url.includes("geobrowser")) {
        const q = String(call.json.query);
        if (q.includes("relationsList(first:12")) return geoRes({ entity: { relationsList: [] } });
        return geoRes({ entity: { id: ID, name: "Ethereum", description: "A chain.", types: [{ name: "Project" }], valuesList: [], relationsList: [] } });
      }
      if (url.includes("/chat/completions")) {
        return call.json.messages[0].role === "system"
          ? chatRes('{"factors":[],"composition":"a coin on a ledger","profile":"emblem"}')
          : chatRes('{"bad":false,"reason":"clean"}');
      }
      if (url.includes("/images/")) return imageRes(PNG_BYTES);
      return new Response("nope", { status: 404 });
    });

    const lines: string[] = [];
    const log = console.log;
    console.log = (s: any) => lines.push(String(s));
    try {
      assert.equal(await main(["entity", ID, "--out", out, "--json"]), 0);
    } finally {
      console.log = log;
      try {
        const written = readFileSync(out);
        assert.deepEqual(written, PNG_BYTES, "the bytes on disk are the bytes we were given");
        const parsed = JSON.parse(lines.join("\n"));
        assert.equal(parsed.subject.name, "Ethereum");
        assert.equal(parsed.profile, "emblem");
        assert.equal(parsed.size, "1536x640");
        assert.equal(parsed.path, out);
        assert.ok(parsed.bytes > 0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("writes nothing on a dry run but prints the prompt", async () => {
    net = mockFetch((url, _i, call) => {
      if (url.includes("geobrowser")) {
        const q = String(call.json.query);
        if (q.includes("properties(")) {
          return geoRes({ properties: [{ id: "d".repeat(32), name: "Date of birth", dataTypeName: "Date" }] });
        }
        return geoRes({ entity: { relationsList: [] } });
      }
      return chatRes('{"factors":[{"name":"a worn calendar","kind":"concept","role":"on the desk"}],"composition":"a calendar and a wristband"}');
    });

    const lines: string[] = [];
    const log = console.log;
    console.log = (s: any) => lines.push(String(s));
    try {
      assert.equal(await main(["property", "Date of birth", "--dry-run"]), 0);
    } finally {
      console.log = log;
    }
    const text = lines.join("\n");
    assert.match(text, /─── PROMPT ───/);
    assert.match(text, /a worn calendar \(on the desk\)/);
    assert.match(text, /still life/, "a property defaults to the still-life look");
    assert.equal(net.to("/images/").length, 0);
  });
});
