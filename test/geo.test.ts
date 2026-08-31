import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  dossierText, GeoError, gql, inferRefKind, ipfsUrls, ownImageUrls, resolveSubject, SYS,
} from "../src/geo.js";
import { entityRow, geoErrRes, geoRes, jsonRes, mockFetch, textRes, type MockHandle } from "./helpers/mock.js";

let net: MockHandle | null = null;
afterEach(() => {
  net?.restore();
  net = null;
});

// ── transport ───────────────────────────────────────────────────────
describe("gql", () => {
  it("returns data on success", async () => {
    net = mockFetch(() => geoRes({ ok: 1 }));
    assert.deepEqual(await gql("query{ok}"), { ok: 1 });
  });

  it("posts the query and variables as JSON", async () => {
    net = mockFetch(() => geoRes({ ok: 1 }));
    await gql("query($id:UUID!){entity(id:$id){id}}", { id: "abc" });
    const call = net.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.json.variables.id, "abc");
    assert.match(call.json.query, /entity\(id:\$id\)/);
  });

  it("surfaces a GraphQL error as GeoError", async () => {
    net = mockFetch(() => geoErrRes('Field "contains" is not defined by type "UUIDListFilter"'));
    await assert.rejects(() => gql("query{x}"), (e: Error) => e instanceof GeoError && /UUIDListFilter/.test(e.message));
  });

  it("surfaces an HTTP failure", async () => {
    net = mockFetch(() => new Response("gateway down", { status: 502 }));
    await assert.rejects(() => gql("query{x}"), /geo api HTTP 502/);
  });

  it("surfaces a non-JSON body", async () => {
    net = mockFetch(() => textRes("<html>maintenance</html>", 200, "text/html"));
    await assert.rejects(() => gql("query{x}"), /non-JSON/);
  });

  it("surfaces a network failure", async () => {
    net = mockFetch(() => new Error("ECONNREFUSED"));
    await assert.rejects(() => gql("query{x}"), /unreachable/);
  });

  it("rejects a payload with no data key", async () => {
    net = mockFetch(() => jsonRes({ extensions: {} }));
    await assert.rejects(() => gql("query{x}"), /no data/);
  });

  it("treats data:null as no data", async () => {
    net = mockFetch(() => jsonRes({ data: null }));
    await assert.rejects(() => gql("query{x}"), /no data/);
  });
});

// ── ipfs ────────────────────────────────────────────────────────────
describe("ipfsUrls", () => {
  it("expands ipfs:// across every gateway", () => {
    const urls = ipfsUrls("ipfs://bafkrei123");
    assert.ok(urls.length >= 2, "expected more than one gateway");
    assert.ok(urls.every((u) => u.endsWith("bafkrei123")));
    assert.ok(urls[0].startsWith("https://"));
  });

  it("accepts a bare CID and an /ipfs/ prefix", () => {
    assert.deepEqual(ipfsUrls("bafkrei123"), ipfsUrls("ipfs://bafkrei123"));
    assert.deepEqual(ipfsUrls("/ipfs/bafkrei123"), ipfsUrls("ipfs://bafkrei123"));
  });

  it("passes an http(s) URL through untouched", () => {
    assert.deepEqual(ipfsUrls("https://cdn.example/a.png"), ["https://cdn.example/a.png"]);
  });

  it("returns nothing for empty or scheme-only input", () => {
    assert.deepEqual(ipfsUrls(""), []);
    assert.deepEqual(ipfsUrls("   "), []);
    assert.deepEqual(ipfsUrls("ipfs://"), []);
    assert.deepEqual(ipfsUrls(undefined as any), []);
  });

  it("honours a custom gateway list", () => {
    const prev = process.env.IPFS_GATEWAYS;
    process.env.IPFS_GATEWAYS = "https://g1.test/ipfs, https://g2.test/ipfs/";
    try {
      assert.deepEqual(ipfsUrls("ipfs://cid"), ["https://g1.test/ipfs/cid", "https://g2.test/ipfs/cid"]);
    } finally {
      if (prev === undefined) delete process.env.IPFS_GATEWAYS;
      else process.env.IPFS_GATEWAYS = prev;
    }
  });
});

// ── kind inference ──────────────────────────────────────────────────
describe("inferRefKind", () => {
  it("maps Geo type names to ref chains", () => {
    assert.equal(inferRefKind(["Person"]), "person");
    assert.equal(inferRefKind(["City"]), "place");
    assert.equal(inferRefKind(["Project"]), "company");
    assert.equal(inferRefKind(["Cryptocurrency"]), "crypto");
    assert.equal(inferRefKind(["Government agency"]), "government");
    assert.equal(inferRefKind(["Treaty"]), "agreement");
    assert.equal(inferRefKind(["Topic"]), "concept");
    assert.equal(inferRefKind(["Drug"]), "object");
  });

  it("prefers the first matching type when several are present", () => {
    assert.equal(inferRefKind(["Person", "City"]), "person");
  });

  it("falls back to the name and description", () => {
    assert.equal(inferRefKind([], "Berlin", "A city in Germany."), "place");
    assert.equal(inferRefKind([], "", "A nonprofit organization."), "company");
  });

  it("defaults to object for an unrecognised subject", () => {
    assert.equal(inferRefKind(["Wibble"], "Wibble", ""), "object");
    assert.equal(inferRefKind([]), "object");
  });

  it("does not match inside a longer word", () => {
    // "actor" must not fire on "refactoring", "act" must not fire on "action"
    assert.equal(inferRefKind(["Refactoring"], "", ""), "object");
  });
});

// ── own images ──────────────────────────────────────────────────────
describe("ownImageUrls", () => {
  const avatarPayload = {
    entity: {
      relationsList: [{
        typeId: SYS.AVATAR,
        toEntity: { id: "x", valuesList: [{ propertyId: SYS.IPFS_URL, text: "ipfs://cidA" }] },
      }],
    },
  };

  it("returns one URL per gateway for the avatar", async () => {
    net = mockFetch(() => geoRes(avatarPayload));
    const urls = await ownImageUrls("0068f0fc16034c749c991e6eabe37031");
    assert.ok(urls.length >= 2);
    assert.ok(urls.every((u) => u.endsWith("cidA")));
  });

  it("puts the avatar before the cover", async () => {
    net = mockFetch(() => geoRes({
      entity: {
        relationsList: [
          { typeId: SYS.COVER, toEntity: { valuesList: [{ propertyId: SYS.IPFS_URL, text: "ipfs://cover" }] } },
          { typeId: SYS.AVATAR, toEntity: { valuesList: [{ propertyId: SYS.IPFS_URL, text: "ipfs://avatar" }] } },
        ],
      },
    }));
    const urls = await ownImageUrls("0068f0fc16034c749c991e6eabe37031");
    assert.ok(urls[0].endsWith("avatar"), `got ${urls[0]}`);
    assert.ok(urls.some((u) => u.endsWith("cover")));
  });

  it("returns [] for a non-id", async () => {
    net = mockFetch(() => geoRes(avatarPayload));
    assert.deepEqual(await ownImageUrls("Ethereum"), []);
    assert.equal(net.calls.length, 0, "must not call the API for a name");
  });

  it("swallows an API failure", async () => {
    net = mockFetch(() => new Error("offline"));
    assert.deepEqual(await ownImageUrls("0068f0fc16034c749c991e6eabe37031"), []);
  });

  it("returns [] when the entity has no image relation", async () => {
    net = mockFetch(() => geoRes({ entity: { relationsList: [] } }));
    assert.deepEqual(await ownImageUrls("0068f0fc16034c749c991e6eabe37031"), []);
  });
});

// ── entity subjects ─────────────────────────────────────────────────
describe("resolveSubject(entity)", () => {
  it("builds a dossier from an id", async () => {
    net = mockFetch((_u, _i, call) => {
      if (String(call.json.query).includes("relationsList(first:12")) return geoRes({ entity: { relationsList: [] } });
      return geoRes({
        entity: entityRow({
          valuesList: [
            { propertyId: SYS.NAME, text: "Ethereum", property: { name: "Name" } },
            { propertyId: SYS.DESCRIPTION, text: "dup", property: { name: "Description" } },
            { propertyId: "p1", text: "https://ethereum.org", property: { name: "Website" } },
            { propertyId: "p2", integer: 42, property: { name: "Score" } },
            { propertyId: "p3", boolean: true, property: { name: "Verified" } },
            { propertyId: "p4", decimal: "1.5", unit: "ETH", property: { name: "Fee" } },
          ],
          relationsList: [
            { typeId: SYS.BLOCKS_REL, type: { name: "Blocks" }, toEntity: { name: "Key People" } },
            { typeId: SYS.TYPES_REL, type: { name: "Types" }, toEntity: { name: "Project" } },
            { typeId: "r1", type: { name: "Related" }, toEntity: { name: "Blockchain" } },
            { typeId: "r2", type: { name: "Uses" }, toEntity: { name: null } },
          ],
        }),
      });
    });

    const d = await resolveSubject({ kind: "entity", ref: "0068f0fc16034c749c991e6eabe37031" });
    assert.equal(d.subject, "entity");
    assert.equal(d.name, "Ethereum");
    assert.deepEqual(d.typeNames, ["Project"]);
    assert.equal(d.refKind, "company", "Project -> company chain");

    assert.ok(!d.facts.some((f) => f.startsWith("Name:")), "name is not a fact");
    assert.ok(!d.facts.some((f) => f.startsWith("Description:")), "description is not a fact");
    assert.ok(d.facts.includes("Website: https://ethereum.org"));
    assert.ok(d.facts.includes("Score: 42"));
    assert.ok(d.facts.includes("Verified: yes"));
    assert.ok(d.facts.includes("Fee: 1.5 ETH"), `units are kept: ${d.facts}`);

    assert.deepEqual(d.related, ["Blockchain (Related)"], "blocks, types and unnamed targets are dropped");
  });

  it("keeps at most two values per property label", async () => {
    net = mockFetch((_u, _i, call) => {
      if (String(call.json.query).includes("relationsList(first:12")) return geoRes({ entity: { relationsList: [] } });
      return geoRes({
        entity: entityRow({
          valuesList: [1, 2, 3, 4].map((n) => ({ propertyId: "x", text: `https://x.test/${n}`, property: { name: "X" } })),
        }),
      });
    });
    const d = await resolveSubject({ kind: "entity", ref: "0068f0fc16034c749c991e6eabe37031" });
    assert.equal(d.facts.length, 2);
  });

  it("looks a name up through search and prefers an exact, described hit", async () => {
    const calls: string[] = [];
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("search(")) {
        calls.push("search");
        return geoRes({
          search: [
            { id: "1".repeat(32), name: "Ethereum Classic", description: "another chain" },
            { id: "2".repeat(32), name: "Ethereum", description: null },
            { id: "3".repeat(32), name: "ethereum", description: "the real one" },
          ],
        });
      }
      if (q.includes("relationsList(first:12")) return geoRes({ entity: { relationsList: [] } });
      calls.push("entity");
      return geoRes({ entity: entityRow({ id: "3".repeat(32), name: "Ethereum" }) });
    });

    const d = await resolveSubject({ kind: "entity", ref: "Ethereum" });
    assert.deepEqual(calls.slice(0, 2), ["search", "entity"], "search then a full re-read");
    assert.equal(net.to("graphql").at(1)!.json.variables.id, "3".repeat(32), "picked the described exact match");
    assert.equal(d.name, "Ethereum");
  });

  it("throws when a name matches nothing", async () => {
    net = mockFetch(() => geoRes({ search: [] }));
    await assert.rejects(
      () => resolveSubject({ kind: "entity", ref: "zzz nothing" }),
      (e: Error) => e instanceof GeoError && /no entity found/.test(e.message),
    );
  });

  it("throws when an id resolves to nothing", async () => {
    net = mockFetch(() => geoRes({ entity: null }));
    await assert.rejects(() => resolveSubject({ kind: "entity", ref: "0".repeat(32) }), /no entity found/);
  });

  it("passes a space filter into the search", async () => {
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("search(")) return geoRes({ search: [{ id: "4".repeat(32), name: "X", description: "d" }] });
      if (q.includes("relationsList(first:12")) return geoRes({ entity: { relationsList: [] } });
      return geoRes({ entity: entityRow({ name: "X" }) });
    });
    await resolveSubject({ kind: "entity", ref: "X", spaceId: "fae5c35a91712b2cae3dd5028d3aba3f" });
    assert.equal(net.calls[0].json.variables.space, "fae5c35a91712b2cae3dd5028d3aba3f");
  });
});

// ── type subjects ───────────────────────────────────────────────────
describe("resolveSubject(type)", () => {
  it("resolves a name through typesList and lists the type's properties", async () => {
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("typesList")) return geoRes({ typesList: [{ id: "a".repeat(32), name: "City", description: "A city." }] });
      if (q.includes(SYS.PROPERTIES_REL)) {
        return geoRes({ entity: { relationsList: [{ toEntity: { name: "Country" } }, { toEntity: { name: "Population" } }] } });
      }
      if (q.includes("relationsList(first:12")) return geoRes({ entity: { relationsList: [] } });
      return geoRes({ entity: entityRow({ id: "a".repeat(32), name: "City", description: "A city.", types: [{ name: "Type" }] }) });
    });

    const d = await resolveSubject({ kind: "type", ref: "City" });
    assert.equal(d.subject, "type");
    assert.equal(d.name, "City");
    assert.equal(d.refKind, "concept", "a class is never photo-matched to one member");
    assert.ok(d.extra.some((x) => x.includes("Country") && x.includes("Population")));
  });

  it("prefers an exact type-name match", async () => {
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("typesList")) {
        return geoRes({ typesList: [{ id: "b".repeat(32), name: "City block" }, { id: "c".repeat(32), name: "City" }] });
      }
      if (q.includes(SYS.PROPERTIES_REL)) return geoRes({ entity: { relationsList: [] } });
      if (q.includes("relationsList(first:12")) return geoRes({ entity: { relationsList: [] } });
      return geoRes({ entity: entityRow({ id: "c".repeat(32), name: "City" }) });
    });
    await resolveSubject({ kind: "type", ref: "City" });
    assert.ok(net.calls.some((c) => c.json.variables?.id === "c".repeat(32)));
  });

  it("throws when no type matches", async () => {
    net = mockFetch(() => geoRes({ typesList: [] }));
    await assert.rejects(() => resolveSubject({ kind: "type", ref: "Nonsense" }), /no type found/);
  });
});

// ── property subjects ───────────────────────────────────────────────
describe("resolveSubject(property)", () => {
  it("describes the field and its data type", async () => {
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("properties(")) {
        return geoRes({
          properties: [{
            id: "d".repeat(32), name: "Date of birth", description: "When a person was born.",
            dataTypeName: "Date", renderableTypeName: null, format: null, isType: null,
          }],
        });
      }
      return geoRes({ entity: { relationsList: [] } });
    });

    const d = await resolveSubject({ kind: "property", ref: "Date of birth" });
    assert.equal(d.subject, "property");
    assert.equal(d.name, "Date of birth");
    assert.equal(d.refKind, "concept");
    assert.deepEqual(d.typeNames, ["Property"]);
    assert.ok(d.extra.includes("DATA TYPE: Date"));
  });

  it("uses property(id) when given an id", async () => {
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("property(id:")) {
        return geoRes({ property: { id: "e".repeat(32), name: "Website", dataTypeName: "Text", renderableTypeName: "URL" } });
      }
      return geoRes({ entity: { relationsList: [] } });
    });
    const d = await resolveSubject({ kind: "property", ref: "e".repeat(32) });
    assert.equal(d.name, "Website");
    assert.ok(d.extra.includes("RENDERED AS: URL"));
  });

  it("throws when nothing matches", async () => {
    net = mockFetch(() => geoRes({ properties: [] }));
    await assert.rejects(() => resolveSubject({ kind: "property", ref: "nope" }), /no property found/);
  });
});

// ── space subjects ──────────────────────────────────────────────────
describe("resolveSubject(space)", () => {
  const spaceId = "fae5c35a91712b2cae3dd5028d3aba3f";

  it("uses the page name and description, and skips the costly contents sample", async () => {
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("space(id:")) {
        return geoRes({ space: { id: spaceId, type: "PERSONAL", page: { id: "f".repeat(32), name: "Crypto", description: "Crypto research." } } });
      }
      return geoRes({ entity: { relationsList: [] } });
    });

    const d = await resolveSubject({ kind: "space", ref: spaceId });
    assert.equal(d.name, "Crypto");
    assert.equal(d.description, "Crypto research.");
    assert.deepEqual(d.typeNames, [], "a space is not an instance of a type");
    assert.deepEqual(d.extra, [], "a self-describing space needs no sample");
    assert.equal(
      net.calls.filter((c) => String(c.json.query).includes("entities(spaceId:")).length, 0,
      "the slow contents scan must not run",
    );
  });

  it("samples the contents when the space describes itself nowhere", async () => {
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("space(id:")) return geoRes({ space: { id: spaceId, type: "PERSONAL", page: { id: "f".repeat(32), name: "Crypto", description: "" } } });
      if (q.includes("entities(spaceId:")) {
        return geoRes({
          entities: [
            { name: "Ethereum", types: [{ name: "Project" }] },
            { name: null, types: [{ name: "Text block" }] },
            { name: "Bitcoin", types: [{ name: "Project" }] },
            { name: "Nothing", types: [] },
            { name: "Berlin", types: [{ name: "City" }] },
          ],
        });
      }
      return geoRes({ entity: entityRow({ name: "", description: "" }) });
    });

    const d = await resolveSubject({ kind: "space", ref: spaceId });
    const types = d.extra.find((x) => x.startsWith("WHAT IT CATALOGUES"))!;
    assert.match(types, /Project/);
    assert.ok(!types.includes("Text block"), "layout blocks are not subject matter");
    assert.ok(types.indexOf("Project") < types.indexOf("City"), "ordered by frequency");
    const entries = d.extra.find((x) => x.startsWith("EXAMPLE ENTRIES"))!;
    assert.match(entries, /Ethereum, Bitcoin, Berlin/);
  });

  it("falls back to the system entity when the page has no name", async () => {
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("space(id:")) return geoRes({ space: { id: spaceId, type: "DAO", page: null } });
      if (q.includes("entities(spaceId:")) return geoRes({ entities: [] });
      if (q.includes("valuesList(first:60")) return geoRes({ entity: entityRow({ name: "Space fae5c35a", description: "System entity" }) });
      return geoRes({ entity: { relationsList: [] } });
    });
    const d = await resolveSubject({ kind: "space", ref: spaceId });
    assert.equal(d.name, "Space fae5c35a");
    assert.equal(d.facts[0], "Space kind: DAO");
  });

  it("still renders when the contents sample times out", async () => {
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("space(id:")) return geoRes({ space: { id: spaceId, type: "DAO", page: { id: "f".repeat(32), name: "S", description: "" } } });
      if (q.includes("entities(spaceId:")) return new Error("timeout");
      return geoRes({ entity: entityRow({ name: "", description: "" }) });
    });
    const d = await resolveSubject({ kind: "space", ref: spaceId });
    assert.equal(d.name, "S");
    assert.deepEqual(d.extra, []);
  });

  it("rejects a name instead of an id", async () => {
    net = mockFetch(() => geoRes({}));
    await assert.rejects(() => resolveSubject({ kind: "space", ref: "Crypto" }), /needs its id/);
  });

  it("throws when the space does not exist", async () => {
    net = mockFetch(() => geoRes({ space: null }));
    await assert.rejects(() => resolveSubject({ kind: "space", ref: spaceId }), /no space found/);
  });
});

// ── relation subjects ───────────────────────────────────────────────
describe("resolveSubject(relation)", () => {
  const relId = "1".repeat(32);

  it("names both endpoints and collects both their images", async () => {
    net = mockFetch((_u, _i, call) => {
      const q = String(call.json.query);
      if (q.includes("relation(id:")) {
        return geoRes({
          relation: {
            id: relId, typeId: "t", spaceId: "s", verified: true,
            type: { name: "Works at", description: "employment" },
            fromEntity: { id: "a".repeat(32), name: "Vitalik Buterin", description: "programmer", types: [{ name: "Person" }] },
            toEntity: { id: "b".repeat(32), name: "Ethereum Foundation", description: "nonprofit", types: [{ name: "Project" }] },
          },
        });
      }
      const id = call.json.variables?.id;
      return geoRes({
        entity: {
          relationsList: [{
            typeId: SYS.AVATAR,
            toEntity: { valuesList: [{ propertyId: SYS.IPFS_URL, text: `ipfs://cid-${id.slice(0, 1)}` }] },
          }],
        },
      });
    });

    const d = await resolveSubject({ kind: "relation", ref: relId });
    assert.equal(d.subject, "relation");
    assert.match(d.name, /Vitalik Buterin — Works at → Ethereum Foundation/);
    assert.equal(d.ownImages.length, 2);
    assert.equal(d.ownImages[0].name, "Vitalik Buterin");
    assert.ok(d.ownImages[0].urls[0].includes("cid-a"));
    assert.ok(d.ownImages[1].urls[0].includes("cid-b"));
    assert.ok(d.facts.some((f) => f.startsWith("FROM: Vitalik Buterin")));
    assert.ok(d.extra[0].includes("Works at"));
  });

  it("tolerates unnamed endpoints", async () => {
    net = mockFetch((_u, _i, call) => {
      if (String(call.json.query).includes("relation(id:")) {
        return geoRes({ relation: { id: relId, type: { name: null }, fromEntity: { id: null, name: null }, toEntity: { id: null, name: null } } });
      }
      return geoRes({ entity: { relationsList: [] } });
    });
    const d = await resolveSubject({ kind: "relation", ref: relId });
    assert.match(d.name, /\(unnamed\) — related to → \(unnamed\)/);
    assert.deepEqual(d.ownImages, []);
  });

  it("rejects a name and a missing relation", async () => {
    net = mockFetch(() => geoRes({ relation: null }));
    await assert.rejects(() => resolveSubject({ kind: "relation", ref: "works at" }), /needs its id/);
    await assert.rejects(() => resolveSubject({ kind: "relation", ref: relId }), /no relation found/);
  });
});

// ── story / text / unknown ──────────────────────────────────────────
describe("resolveSubject(story|text)", () => {
  it("carries a story without touching the graph", async () => {
    net = mockFetch(() => new Error("must not be called"));
    const d = await resolveSubject({ kind: "story", headline: "SEC drops case", summary: "context here" });
    assert.equal(d.name, "SEC drops case");
    assert.equal(d.description, "context here");
    assert.equal(d.refKind, "concept");
    assert.equal(net.calls.length, 0);
  });

  it("carries a free-text brief", async () => {
    net = mockFetch(() => new Error("must not be called"));
    const d = await resolveSubject({ kind: "text", text: "a rusted bicycle" });
    assert.equal(d.name, "a rusted bicycle");
    assert.equal(net.calls.length, 0);
  });

  it("rejects an unknown subject kind", async () => {
    await assert.rejects(() => resolveSubject({ kind: "planet" as any, ref: "mars" }), /unknown subject kind/);
  });
});

// ── rendering the dossier ───────────────────────────────────────────
describe("dossierText", () => {
  it("renders only the sections that have content", () => {
    const text = dossierText({
      subject: "entity", name: "Ethereum", description: "A chain.", typeNames: ["Project"],
      facts: ["Website: x"], related: ["Blockchain"], ownImages: [], refKind: "company", extra: ["EXTRA: y"],
    });
    assert.match(text, /^ENTITY: Ethereum/);
    assert.match(text, /TYPES: Project/);
    assert.match(text, /DESCRIPTION: A chain\./);
    assert.match(text, /EXTRA: y/);
    assert.match(text, /FACTS:\n {2}- Website: x/);
    assert.match(text, /CONNECTED TO: Blockchain/);
  });

  it("omits empty sections", () => {
    const text = dossierText({
      subject: "property", name: "Website", description: "", typeNames: [],
      facts: [], related: [], ownImages: [], refKind: "concept", extra: [],
    });
    assert.equal(text, "PROPERTY: Website");
  });
});
