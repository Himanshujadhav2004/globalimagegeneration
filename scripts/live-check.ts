/**
 * live-check.ts — talk to the real services and report what actually works.
 *
 * The unit suite runs entirely on mocks. This is the counterpart: it hits the
 * live Geo API (free, unauthenticated), the live IPFS gateways, and — if a key
 * is present — probes OpenAI without spending anything on an image.
 *
 *   npm run check:live
 */

import { download } from "../src/refs.js";
import { dossierText, gql, ownImageUrls, resolveSubject, SYS } from "../src/geo.js";
import { GEO_GRAPHQL, IMAGE_MODEL, PLANNER_MODEL, VISION_MODEL } from "../src/config.js";

try {
  process.loadEnvFile?.(new URL("../.env", import.meta.url).pathname.replace(/^\//, ""));
} catch {
  /* no .env */
}

let pass = 0;
let fail = 0;

async function check(label: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    pass++;
    console.log(`  ✓ ${label}\n      ${detail.replace(/\n/g, "\n      ")}`);
  } catch (e: any) {
    fail++;
    console.log(`  ✗ ${label}\n      ${String(e?.message ?? e).slice(0, 300)}`);
  }
}

console.log(`\nGeo API: ${GEO_GRAPHQL()}\n`);

// ── the graph ───────────────────────────────────────────────────────
await check("typesList reachable", async () => {
  const d = await gql<{ typesList: any[] }>("query{ typesList(first:3){ id name } }");
  return d.typesList.map((t) => t.name).join(", ");
});

await check("well-known system ids still resolve", async () => {
  const d = await gql<{ properties: any[] }>(
    `query{ properties(first:5, filter:{id:{in:["${SYS.AVATAR}","${SYS.COVER}","${SYS.IPFS_URL}"]}}){ id name } }`,
  );
  const byId = new Map(d.properties.map((p: any) => [p.id, p.name]));
  for (const [key, id] of [["AVATAR", SYS.AVATAR], ["COVER", SYS.COVER], ["IPFS_URL", SYS.IPFS_URL]] as const) {
    if (!byId.has(id)) throw new Error(`${key} (${id}) no longer exists`);
  }
  return [...byId.values()].join(", ");
});

let personId = "";
await check("entity by name (person)", async () => {
  const d = await resolveSubject({ kind: "entity", ref: "Vitalik Buterin" });
  personId = d.id ?? "";
  if (d.refKind !== "person") throw new Error(`expected refKind=person, got ${d.refKind}`);
  return dossierText(d).split("\n").slice(0, 3).join("\n");
});

await check("entity by id", async () => {
  const d = await resolveSubject({ kind: "entity", ref: "0068f0fc16034c749c991e6eabe37031" });
  return `${d.name} [${d.typeNames.join(", ")}] refKind=${d.refKind}, ${d.facts.length} facts`;
});

await check("type by name", async () => {
  const d = await resolveSubject({ kind: "type", ref: "City" });
  return `${d.name}: ${d.extra[0] ?? "(no properties listed)"}`.slice(0, 200);
});

await check("property by name", async () => {
  const d = await resolveSubject({ kind: "property", ref: "Website" });
  return `${d.name} — ${d.extra.join("; ")}`;
});

await check("space that describes itself (fast path)", async () => {
  const d = await resolveSubject({ kind: "space", ref: "003eaa9b7a56fa847afd6f2e8cc518a6" });
  if (!d.description) throw new Error("expected a page description");
  if (d.extra.length) throw new Error("should not have paid for the contents sample");
  return `${d.name}: ${d.description.slice(0, 140)}…`;
});

await check("space with no description (samples its contents)", async () => {
  const d = await resolveSubject({ kind: "space", ref: "fae5c35a91712b2cae3dd5028d3aba3f" });
  return `${d.name}\n${d.extra.join("\n") || "(sample returned nothing)"}`.slice(0, 300);
});

// ── images in the graph ─────────────────────────────────────────────
await check("an entity's own avatar downloads as a real image", async () => {
  const id = personId || "000ab2477bca47ec82f3bb62a6685214";
  const urls = await ownImageUrls(id);
  if (!urls.length) throw new Error(`no avatar relation on ${id}`);
  for (const url of urls) {
    const img = await download(url);
    if (img) return `${img.mime}, ${img.buf.length}b via ${new URL(url).host}`;
  }
  throw new Error(`all ${urls.length} gateway(s) failed for ${urls[0]}`);
});

await check("a CID holding an error page is rejected, not rendered", async () => {
  // Ethereum's avatar in the graph is a saved Wikimedia error page — the exact
  // case that must never reach the image API.
  const urls = await ownImageUrls("0068f0fc16034c749c991e6eabe37031");
  if (!urls.length) return "entity has no avatar (nothing to reject)";
  const got = await download(urls[0]);
  if (got) throw new Error(`accepted ${got.mime} that should have been rejected`);
  return `rejected ${urls[0].slice(0, 60)}…`;
});

// ── OpenAI ──────────────────────────────────────────────────────────
const key = (process.env.OPENAI_API_KEY ?? "").trim();
console.log(`\nOpenAI (planner=${PLANNER_MODEL}, vision=${VISION_MODEL}, image=${IMAGE_MODEL})\n`);

if (!key) {
  console.log("  – skipped: OPENAI_API_KEY is not set");
} else {
  await check("key is valid and the configured models exist", async () => {
    const r = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const ids = new Set(((await r.json()) as any).data.map((m: any) => m.id));
    const missing = [PLANNER_MODEL, VISION_MODEL, IMAGE_MODEL].filter((m) => !ids.has(m));
    if (missing.length) throw new Error(`not available to this key: ${missing.join(", ")}`);
    return `all three models available (${ids.size} total)`;
  });

  await check("account can actually spend (1-token completion)", async () => {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: VISION_MODEL, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return "billing is live — full renders will work";
  });
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
