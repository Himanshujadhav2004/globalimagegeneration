/**
 * cover-refs.ts — entity reference resolution for the cover pipeline.
 *
 * Port of the resolver layer from `factors114.py` (+ `geo.py`, `factors2.py`).
 * For each planner factor it yields image-reference candidates in priority order
 * from a per-kind source chain, downloads/normalizes each (SVG + GIF → PNG, then
 * downsize for the edits endpoint), and exposes a LENIENT vision `refGate` so the
 * pipeline can keep the first candidate that passes and otherwise describe the
 * entity in-prompt. All sources are keyless except the optional Brandfetch one.
 *
 *   person     -> Geo DB avatar -> Geo graph avatar -> Wikipedia -> Commons
 *   crypto     -> Geo DB logo   -> CoinGecko -> Wikidata -> Commons
 *   company    -> Geo DB logo   -> Brandfetch? -> Wikidata -> Commons -> Wikipedia
 *   gov/place/agreement/org/object -> Wikidata (type-checked) -> Wikipedia -> Commons
 *   concept    -> (nothing; always described in-prompt)
 */

import sharp from "sharp";
import { dbImage } from "./entity-db.js";
import { chatCompletion, dataUrl, VISION_MODEL } from "./openai.js";

// ── Tunables (match factors114) ─────────────────────────────────────
export const ENTITY_MIN_CONF = 0.7;
const MAXPX = 2000; // resize refs before the edits endpoint
const BRANDFETCH_KEY = (process.env.BRANDFETCH_KEY ?? "").trim(); // optional; off by default

/** Per-source confidence — higher = more trusted likeness/logo. */
export const CONF: Record<string, number> = {
  db: 0.96, brandfetch: 0.99, coingecko: 0.98, geo: 0.97,
  wikidata: 0.95, wikipedia: 0.88, commons: 0.8,
};

const H = { "User-Agent": "geo-news-worker/1.0 (covers; +https://github.com/geo-explorers/news-worker)" };
const WIKI = "https://en.wikipedia.org/w/api.php";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
const WD = "https://www.wikidata.org/w/api.php";
const CG = "https://api.coingecko.com/api/v3";

// Loose keyword type-check against the Wikidata one-line description (free, no
// extra call) so "Stellar" the crypto never resolves to "Stellar" the star.
const KIND_DESC_KW: Record<string, string[]> = {
  company: ["company", "business", "enterprise", "corporation", "startup", "firm", "manufacturer",
    "developer", "brand", "platform", "maker", "vendor", "organization", "organisation", "lab",
    "laboratory", "research", "institute", "technology", "tech", "software", "ai",
    "artificial intelligence", "group", "network", "studio", "cryptocurrency", "token", "blockchain", "coin"],
  organization: ["organization", "organisation", "association", "institution", "body", "party",
    "agency", "foundation", "nonprofit", "union"],
  government: ["agency", "government", "department", "ministry", "bureau", "commission", "authority",
    "central bank", "federal", "regulator", "court", "military", "cabinet", "administration"],
  place: ["building", "structure", "city", "country", "region", "headquarters", "capitol", "landmark",
    "fortress", "castle", "stadium", "palace", "arena", "town", "state", "river", "mountain", "airport", "base"],
  agreement: ["agreement", "treaty", "act", "law", "bill", "pact", "accord", "deal", "statute"],
};

// Wikidata image properties, in priority order per kind.
const PROP_PRIORITY: Record<string, string[]> = {
  person: ["P18"], company: ["P154", "P18"], organization: ["P154", "P18", "P158"],
  government: ["P158", "P41", "P18", "P154"], place: ["P18", "P154"],
  agreement: ["P18", "P154"], object: ["P18"],
};

// ── HTTP helpers ────────────────────────────────────────────────────
async function getJSON(base: string, params: Record<string, string>, timeoutMs = 25_000): Promise<any | null> {
  const url = base + "?" + new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: H, signal: controller.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBuffer(url: string, timeoutMs = 60_000): Promise<Buffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: H, redirect: "follow", signal: controller.signal });
    if (!r.ok) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Image sources ───────────────────────────────────────────────────
export async function wikiImageUrl(query: string): Promise<string | null> {
  const s = await getJSON(WIKI, { action: "query", list: "search", srsearch: query, format: "json", srlimit: "1" });
  const hits = s?.query?.search ?? [];
  if (!hits.length) return null;
  const p = await getJSON(WIKI, {
    action: "query", titles: hits[0].title, prop: "pageimages",
    piprop: "thumbnail", pithumbsize: "900", format: "json",
  });
  for (const pg of Object.values(p?.query?.pages ?? {}) as any[]) {
    const img = pg?.thumbnail?.source;
    if (img) return img;
  }
  return null;
}

export async function commonsImageUrl(query: string): Promise<string | null> {
  const s = await getJSON(COMMONS, {
    action: "query", list: "search", srsearch: query, srnamespace: "6", srlimit: "5", format: "json",
  });
  for (const h of s?.query?.search ?? []) {
    const title: string = h.title;
    if (!/\.(png|jpe?g|svg)$/i.test(title)) continue;
    const info = await getJSON(COMMONS, {
      action: "query", titles: title, prop: "imageinfo", iiprop: "url", iiurlwidth: "900", format: "json",
    });
    for (const pg of Object.values(info?.query?.pages ?? {}) as any[]) {
      const ii = pg?.imageinfo ?? [];
      if (ii.length) return ii[0].thumburl ?? ii[0].url ?? null;
    }
  }
  return null;
}

async function wdSearch(query: string, n = 5): Promise<Array<[string, string]>> {
  const r = await getJSON(WD, {
    action: "wbsearchentities", search: query, language: "en", format: "json", type: "item", limit: String(n),
  }, 20_000);
  return (r?.search ?? []).map((c: any) => [c.id, c.description ?? ""] as [string, string]);
}

async function wdImage(qid: string, kind: string): Promise<string | null> {
  const r = await getJSON(WD, { action: "wbgetentities", ids: qid, props: "claims", format: "json" }, 20_000);
  const cl = r?.entities?.[qid]?.claims ?? {};
  for (const prop of PROP_PRIORITY[kind] ?? ["P18", "P154"]) {
    const fn = cl[prop]?.[0]?.mainsnak?.datavalue?.value;
    if (typeof fn === "string" && fn) {
      return `https://commons.wikimedia.org/wiki/Special:FilePath/${fn.replace(/ /g, "_")}?width=900`;
    }
  }
  return null;
}

/** Resolve name → QID with a type-check, then fetch the type-appropriate image. */
async function wdResolveImage(query: string, kind: string): Promise<string | null> {
  const kws = KIND_DESC_KW[kind];
  for (const [qid, desc] of await wdSearch(query)) {
    if (kws && !kws.some((k) => (desc || "").toLowerCase().includes(k))) continue; // type mismatch
    const u = await wdImage(qid, kind);
    if (u) return u;
  }
  return null;
}

export async function coingeckoLogo(name: string): Promise<string | null> {
  const s = await getJSON(`${CG}/search`, { query: name }, 20_000);
  const coins = s?.coins ?? [];
  return coins.length ? (coins[0].large ?? coins[0].thumb ?? null) : null;
}

async function brandfetchLogo(domain: string): Promise<string | null> {
  if (!BRANDFETCH_KEY || !domain) return null;
  try {
    const r = await fetch(`https://api.brandfetch.io/v2/brands/${domain}`, {
      headers: { ...H, Authorization: `Bearer ${BRANDFETCH_KEY}` },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    for (const lg of j.logos ?? []) {
      for (const fmt of lg.formats ?? []) {
        if (fmt.src) return fmt.src;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ── Geo graph avatar resolver (geo.py) ──────────────────────────────
const GEO_GRAPHQL = "https://api-testnet.geobrowser.io/graphql";
const IPFS_GATEWAY = "https://ipfs.io/ipfs/";
const PERSON_TYPE = "7ed45f2bc48b419e8e4664d5ff680b0d";
const AVATAR_REL = "1155befffad549b7a2e0da4777b8792c";
const IPFS_PROP = "8a743832c0944a62b6650c3cc2f9c7bc";
const GEO_Q =
  `query($name:String!){ entities(filter:{name:{includesInsensitive:$name}, typeIds:{anyEqualTo:"${PERSON_TYPE}"}}, first:25){` +
  ` id name relationsList(filter:{typeId:{is:"${AVATAR_REL}"}}){ toEntity { valuesList(filter:{propertyId:{is:"${IPFS_PROP}"}}){ text } } } } }`;

function ipfsForEntity(e: any): string | null {
  for (const rel of e?.relationsList ?? []) {
    for (const v of rel?.toEntity?.valuesList ?? []) {
      const t: string = v?.text ?? "";
      if (t.startsWith("ipfs://")) return t;
    }
  }
  return null;
}

export async function geoResolveAvatar(name: string, timeoutMs = 40_000): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(GEO_GRAPHQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: GEO_Q, variables: { name } }),
      signal: controller.signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const cands: Array<[string, string]> = [];
    for (const e of j?.data?.entities ?? []) {
      const ipfs = ipfsForEntity(e);
      if (ipfs) cands.push([e.name ?? "", ipfs]);
    }
    if (!cands.length) return null;
    const exact = cands.filter(([n]) => n.toLowerCase() === name.toLowerCase());
    const chosen = (exact.length ? exact : cands)[0][1];
    return IPFS_GATEWAY + chosen.slice("ipfs://".length);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Candidate chain (lazy, per-kind) ────────────────────────────────
export interface RefCandidate {
  url: string;
  src: string;
  conf: number;
}

/**
 * Lazily yield (url, src, conf) reference candidates in priority order — the
 * ref-retry loop gates each and keeps the first that passes, else describes.
 * Concepts yield nothing (always described in-prompt).
 */
export async function* resolveCandidates(
  kind: string, name: string, refQuery: string, domain = "",
): AsyncGenerator<RefCandidate> {
  const q = (refQuery || name).trim();
  let chain: Array<[string, () => Promise<string | null>]>;
  if (kind === "person") {
    chain = [
      ["db", () => dbImage(name, "person")],
      ["geo", () => geoResolveAvatar(name)],
      ["wikipedia", () => wikiImageUrl(name)],
      ["commons", () => commonsImageUrl(name)],
    ];
  } else if (kind === "crypto") {
    chain = [
      ["db", () => dbImage(name, "company")],
      ["coingecko", () => coingeckoLogo(name)],
      ["wikidata", () => wdResolveImage(q, "company")],
      ["commons", () => commonsImageUrl(q + " logo")],
    ];
  } else if (kind === "company") {
    chain = [
      ["db", () => dbImage(name, "company")],
      ["brandfetch", () => brandfetchLogo(domain)],
      ["wikidata", () => wdResolveImage(q, "company")],
      ["commons", () => commonsImageUrl(q + " logo")],
      ["wikipedia", () => wikiImageUrl(q)],
      ["commons", () => commonsImageUrl(q)],
    ];
  } else if (["government", "place", "agreement", "organization", "object"].includes(kind)) {
    chain = [
      ["wikidata", () => wdResolveImage(q, kind)],
      ["wikipedia", () => wikiImageUrl(q)],
      ["commons", async () => (await commonsImageUrl(q + (kind === "organization" ? " logo" : ""))) ?? (await commonsImageUrl(q))],
    ];
  } else {
    return; // concept (or unknown) — always described
  }
  for (const [src, fn] of chain) {
    let u: string | null = null;
    try {
      u = await fn();
    } catch {
      u = null;
    }
    if (u) yield { url: u, src, conf: CONF[src] ?? 0.5 };
  }
}

// ── download + normalize (in-memory; no temp files) ─────────────────
export interface RefImage {
  buf: Buffer;
  mime: string;
}

function sniff(d: Buffer): "png" | "jpeg" | "webp" | null {
  if (d.length >= 8 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return "png";
  if (d.length >= 2 && d[0] === 0xff && d[1] === 0xd8) return "jpeg";
  if (d.length >= 12 && d.toString("ascii", 0, 4) === "RIFF" && d.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

function isSvg(d: Buffer): boolean {
  const head = d.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<?xml") || head.startsWith("<svg") || head.includes("<svg");
}

/** Resize oversized refs so the edits endpoint accepts them; keep PNG (logo transparency), else JPEG. */
async function downsize({ buf, mime }: RefImage): Promise<RefImage> {
  try {
    const meta = await sharp(buf).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (Math.max(w, h) <= MAXPX && buf.length < 4_000_000) return { buf, mime };
    const resized = sharp(buf).resize(MAXPX, MAXPX, { fit: "inside", withoutEnlargement: true });
    if (mime === "image/png") return { buf: await resized.png().toBuffer(), mime: "image/png" };
    return { buf: await resized.jpeg({ quality: 85 }).toBuffer(), mime: "image/jpeg" };
  } catch {
    return { buf, mime };
  }
}

/**
 * Download a reference URL into a normalized in-memory image the edits endpoint
 * accepts. SVG flags/seals → PNG (else silently dropped); GIF/BMP/TIFF → PNG;
 * oversized originals are downsized. Returns null on any failure.
 */
export async function download(url: string): Promise<RefImage | null> {
  let d = await fetchBuffer(url);
  if (!d || !d.length) return null;

  if (isSvg(d)) {
    try {
      d = await sharp(d, { density: 200 }).resize({ width: 900 }).png().toBuffer();
    } catch {
      return null;
    }
  }

  let mime: string;
  const kind = sniff(d);
  if (kind === "png") mime = "image/png";
  else if (kind === "jpeg") mime = "image/jpeg";
  else if (kind === "webp") mime = "image/webp";
  else {
    try {
      d = await sharp(d).png().toBuffer(); // GIF/BMP/TIFF/... -> PNG
      mime = "image/png";
    } catch {
      return null;
    }
  }
  return downsize({ buf: d, mime });
}

// ── Reference gate (LENIENT; applied to EVERY source incl. db) ──────
export interface GateResult {
  ok: boolean;
  reason: string;
}

/**
 * Validate ONE fetched entity ref by LOOKING at it. Lenient: reject ONLY a
 * clearly-wrong ref so the loop can try another candidate. Person refs must be a
 * REAL (non-stylized) face. Fail-OPEN (keep) on any API error so a transient
 * blip never drops a good ref.
 */
export async function refGate(buf: Buffer, mime: string, name: string, kind: string): Promise<GateResult> {
  const q = kind === "person"
    ? `Is this a REAL photograph of a real human person's face, usable as a likeness reference for ` +
      `'${name}'? Reply one word, YES or NO. Answer NO ONLY if it is a cartoon, anime, illustration, ` +
      `drawing, painting, 3D render, avatar or emoji, OR a logo / object / scene with no clear human ` +
      `face. Answer YES for any real photograph of a plausible real person.`
    : `This image is a reference for a news graphic about '${name}'. Reply one word, YES or NO. Answer ` +
      `NO ONLY if it is clearly UNUSABLE — a website screenshot, a stock chart / graph / infographic, ` +
      `a watermarked stock thumbnail, or obviously a DIFFERENT unrelated thing. Any logo, seal, flag, ` +
      `building, monument, product, map, coin or plausibly on-topic photo of '${name}': answer YES. ` +
      `When unsure, answer YES.`;
  try {
    const ans = (await chatCompletion({
      model: VISION_MODEL,
      maxTokens: 4,
      messages: [{ role: "user", content: [{ type: "text", text: q }, { type: "image_url", image_url: { url: dataUrl(buf, mime) } }] }],
    })).trim().toLowerCase();
    const ok = ans.startsWith("y");
    return { ok, reason: ok ? "ok" : kind === "person" ? "not-real-face" : "wrong-ref" };
  } catch {
    return { ok: true, reason: "gate-error" }; // fail-OPEN
  }
}
