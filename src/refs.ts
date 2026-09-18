/**
 * refs.ts — find a real photograph/logo/mark for each planned factor.
 *
 * Generalised from cover-refs.ts. Two things are new:
 *
 *  1. GEO-OWN images. When the subject came out of the graph, the graph itself
 *     usually holds its Avatar or Cover. That beats every web source, so it is
 *     tried first at conf 0.99 (and every configured IPFS gateway is tried,
 *     because a single gateway lies with a 200 + an HTML error page).
 *  2. Content sniffing that REJECTS non-images. A gateway that answers 200
 *     text/html, or a CID that actually holds a saved error page, must not
 *     reach the render call.
 *
 * Source chains (first candidate that passes the vision gate wins):
 *   person     -> geo-own -> db? -> geo name search -> Wikipedia -> Firecrawl? -> Commons
 *   crypto     -> geo-own -> db? -> CoinGecko -> Wikidata -> Commons
 *   company    -> geo-own -> db? -> Brandfetch? -> Wikidata -> Commons -> Wikipedia
 *   gov/place/agreement/organization/object -> geo-own -> Wikidata -> Wikipedia -> Commons
 *   concept    -> geo-own only (otherwise always described in-prompt)
 */

import {
  BRANDFETCH_KEY, CONF, ENTITY_MIN_CONF, MAXPX, MAXREF,
  MAX_REF_TRIES, MAX_REF_TRIES_PERSON, USER_AGENT, noSharp,
} from "./config.js";
import { chatCompletion, dataUrl, VISION_MODEL } from "./openai.js";
import { firecrawlImages } from "./firecrawl.js";
import { uniqueBy } from "./util.js";

export { ENTITY_MIN_CONF };

const H = { "User-Agent": USER_AGENT };
const WIKI = "https://en.wikipedia.org/w/api.php";
const COMMONS = "https://commons.wikimedia.org/w/api.php";
const WD = "https://www.wikidata.org/w/api.php";
const CG = "https://api.coingecko.com/api/v3";
const MAX_BYTES = 20 * 1024 * 1024;

// Loose keyword type-check against the Wikidata one-line description (free, no
// extra call) so "Stellar" the crypto never resolves to "Stellar" the star.
const KIND_DESC_KW: Record<string, string[]> = {
  company: ["company", "business", "enterprise", "corporation", "startup", "firm", "manufacturer",
    "developer", "brand", "platform", "maker", "vendor", "organization", "organisation", "lab",
    "laboratory", "research", "institute", "technology", "tech", "software", "ai",
    "artificial intelligence", "group", "network", "studio", "cryptocurrency", "token", "blockchain", "coin"],
  organization: ["organization", "organisation", "association", "institution", "body", "party",
    "agency", "foundation", "nonprofit", "union",
    // Events resolve through this chain too — a Wikidata conference is
    // described as a "conference"/"festival", never as an "organization".
    "conference", "convention", "summit", "festival", "expo", "exhibition", "event", "fair"],
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

// ── Optional host-app hooks ─────────────────────────────────────────
export type DbImageResolver = (name: string, kind: "person" | "company") => Promise<string | null>;
let dbImageResolver: DbImageResolver | null = null;

/**
 * Register the host app's entity-image database (the news worker's `dbImage`).
 * Unregistered, the `db` source is simply skipped — the skill runs standalone.
 */
export function setDbImageResolver(fn: DbImageResolver | null): void {
  dbImageResolver = fn;
}

// ── HTTP helpers ────────────────────────────────────────────────────
async function getJSON(base: string, params: Record<string, string>, timeoutMs = 25_000): Promise<any | null> {
  const url = base + "?" + new URLSearchParams(params).toString();
  try {
    const r = await fetch(url, { headers: H, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function fetchBuffer(url: string, timeoutMs = 60_000): Promise<{ buf: Buffer; contentType: string } | null> {
  try {
    const r = await fetch(url, { headers: H, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const contentType = (r.headers.get("content-type") ?? "").toLowerCase();
    // A gateway that answers 200 text/html is serving an error page, not a file.
    if (contentType.startsWith("text/") || contentType.includes("json")) return null;
    const declared = Number(r.headers.get("content-length") ?? 0);
    if (declared && declared > MAX_BYTES) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_BYTES) return null;
    return { buf, contentType };
  } catch {
    return null;
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
  const key = BRANDFETCH_KEY();
  if (!key || !domain) return null;
  try {
    const r = await fetch(`https://api.brandfetch.io/v2/brands/${domain}`, {
      headers: { ...H, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
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

// ── Geo graph avatar by NAME (fallback when we have no entity id) ───
const GEO_GRAPHQL_NAME_Q = (personType: string, avatarRel: string, ipfsProp: string) =>
  `query($name:String!){ entities(filter:{name:{includesInsensitive:$name}, typeIds:{anyEqualTo:"${personType}"}}, first:25){` +
  ` id name relationsList(filter:{typeId:{is:"${avatarRel}"}}){ toEntity { valuesList(filter:{propertyId:{is:"${ipfsProp}"}}){ text } } } } }`;

/**
 * Name-search a person in the graph and return their avatar. Kept for subjects
 * that were never resolved to an id (a planner factor mentioning a person who
 * is not the subject). Entity-id lookups use `ownImages` instead.
 */
export async function geoResolveAvatarByName(name: string): Promise<string | null> {
  const { GEO_GRAPHQL } = await import("./config.js");
  const { SYS, ipfsUrls } = await import("./geo.js");
  try {
    const r = await fetch(GEO_GRAPHQL(), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...H },
      body: JSON.stringify({
        query: GEO_GRAPHQL_NAME_Q(SYS.PERSON_TYPE, SYS.AVATAR, SYS.IPFS_URL),
        variables: { name },
      }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as any;
    const cands: Array<[string, string]> = [];
    for (const e of j?.data?.entities ?? []) {
      for (const rel of e?.relationsList ?? []) {
        for (const v of rel?.toEntity?.valuesList ?? []) {
          const t: string = v?.text ?? "";
          if (t.startsWith("ipfs://")) cands.push([e.name ?? "", t]);
        }
      }
    }
    if (!cands.length) return null;
    const exact = cands.filter(([n]) => n.toLowerCase() === name.toLowerCase());
    const chosen = (exact.length ? exact : cands)[0][1];
    return ipfsUrls(chosen)[0] ?? null;
  } catch {
    return null;
  }
}

// ── Candidate chain (lazy, per-kind) ────────────────────────────────
export interface RefCandidate {
  url: string;
  src: string;
  conf: number;
}

export interface ResolveOptions {
  /** Official website domain — the Brandfetch source (company factors only). */
  domain?: string;
  /** Gateway URLs for the factor's OWN image in the graph; tried first. */
  ownImageUrls?: string[];
  /**
   * What the graph says about this factor. Disambiguates a web search — a bare
   * name finds whoever is most famous, the name plus the description finds the
   * person the graph actually means.
   */
  context?: string;
}

/** A source yields one URL, or several when it is a search that ranks results. */
type SourceFn = () => Promise<string | string[] | null>;

/**
 * Lazily yield (url, src, conf) reference candidates in priority order — the
 * caller gates each and keeps the first that passes, else describes.
 * A `concept` yields only its own graph image (usually none).
 */
export async function* resolveCandidates(
  kind: string, name: string, refQuery: string, opts: ResolveOptions = {},
): AsyncGenerator<RefCandidate> {
  // 1. The subject's own picture in the graph — every gateway is a candidate,
  //    because one gateway answering with an error page must not sink the ref.
  for (const url of uniqueBy(opts.ownImageUrls ?? [], (u) => u)) {
    yield { url, src: "geo-own", conf: CONF["geo-own"] };
  }

  const q = (refQuery || name).trim();
  const domain = opts.domain ?? "";
  const context = opts.context ?? "";
  const db = dbImageResolver;
  let chain: Array<[string, SourceFn]>;

  if (kind === "person") {
    // Wikipedia keeps priority — it went 4/4 in the evaluation — and Firecrawl
    // picks up everyone Wikipedia has no portrait for. Commons is last because
    // it matches on filename alone: it is what returned a photograph of a robin
    // for "Robin May" and a different man for "Robert Turner".
    chain = [
      ["db", () => (db ? db(name, "person") : Promise.resolve(null))],
      ["geo", () => geoResolveAvatarByName(name)],
      ["wikipedia", () => wikiImageUrl(name)],
      ["firecrawl", () => firecrawlImages(name, context)],
      ["commons", () => commonsImageUrl(name)],
    ];
  } else if (kind === "crypto") {
    chain = [
      ["db", () => (db ? db(name, "company") : Promise.resolve(null))],
      ["coingecko", () => coingeckoLogo(name)],
      ["wikidata", () => wdResolveImage(q, "company")],
      ["commons", () => commonsImageUrl(q + " logo")],
    ];
  } else if (kind === "company") {
    chain = [
      ["db", () => (db ? db(name, "company") : Promise.resolve(null))],
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
    return; // concept (or unknown) — described in-prompt
  }

  for (const [src, fn] of chain) {
    let got: string | string[] | null = null;
    try {
      got = await fn();
    } catch {
      got = null;
    }
    // A ranked search returns several: yield each, best first, so the gate can
    // walk past a hotlink-blocked top hit or a stranger who shares the name.
    for (const url of (Array.isArray(got) ? got : [got]).filter((u): u is string => !!u)) {
      yield { url, src, conf: CONF[src] ?? 0.5 };
    }
  }
}

// ── download + normalize (in-memory; no temp files) ─────────────────
export interface RefImage {
  buf: Buffer;
  mime: string;
}

type SharpModule = typeof import("sharp");
let sharpCache: SharpModule | null | undefined;

/** sharp is optional: without it, SVGs and exotic formats are simply skipped. */
async function loadSharp(): Promise<SharpModule | null> {
  if (noSharp()) return null;
  if (sharpCache !== undefined) return sharpCache;
  try {
    sharpCache = (await import("sharp")).default as unknown as SharpModule;
  } catch {
    sharpCache = null;
  }
  return sharpCache;
}

/** Reset the cached sharp handle (tests flip GEO_IMAGE_NO_SHARP between cases). */
export function resetSharpCache(): void {
  sharpCache = undefined;
}

export function sniff(d: Buffer): "png" | "jpeg" | "webp" | "gif" | null {
  if (d.length >= 8 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4e && d[3] === 0x47) return "png";
  if (d.length >= 3 && d[0] === 0xff && d[1] === 0xd8 && d[2] === 0xff) return "jpeg";
  if (d.length >= 12 && d.toString("ascii", 0, 4) === "RIFF" && d.toString("ascii", 8, 12) === "WEBP") return "webp";
  if (d.length >= 6 && d.toString("ascii", 0, 3) === "GIF") return "gif";
  return null;
}

export function isSvg(d: Buffer): boolean {
  const head = d.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<?xml")) return head.includes("<svg") || d.subarray(0, 4096).toString("utf8").toLowerCase().includes("<svg");
  return head.startsWith("<svg") || head.includes("<svg");
}

/** An HTML page (a gateway error, a paywall, a "verify you are human") is not a ref. */
export function isMarkup(d: Buffer): boolean {
  const head = d.subarray(0, 512).toString("utf8").trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html") || head.startsWith("<head") ||
    (head.startsWith("<!doctype") && head.includes("html"));
}

/** Resize oversized refs so the edits endpoint accepts them; keep PNG (logo transparency), else JPEG. */
async function downsize({ buf, mime }: RefImage): Promise<RefImage | null> {
  const sharp = await loadSharp();
  if (!sharp) return buf.length <= 4_000_000 ? { buf, mime } : null; // can't shrink it — don't risk a 400
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
 * accepts. HTML/text is rejected outright; SVG flags/seals and GIF/BMP/TIFF are
 * converted to PNG when sharp is available; oversized originals are downsized.
 * Returns null on any failure — the caller just tries the next candidate.
 */
export async function download(url: string): Promise<RefImage | null> {
  const got = await fetchBuffer(url);
  if (!got) return null;
  let d = got.buf;

  if (isMarkup(d)) return null; // 200 OK + an error page

  if (isSvg(d)) {
    const sharp = await loadSharp();
    if (!sharp) return null;
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
    const sharp = await loadSharp();
    if (!sharp) return null; // GIF/BMP/TIFF/unknown and nothing to convert with
    try {
      d = await sharp(d).png().toBuffer(); // GIF/BMP/TIFF/... -> PNG
      mime = "image/png";
    } catch {
      return null; // not an image at all
    }
  }
  return downsize({ buf: d, mime });
}

// ── Reference gate (applied to EVERY source incl. geo-own) ──────────
export interface GateResult {
  ok: boolean;
  reason: string;
}

/**
 * Validate ONE fetched ref by LOOKING at it, so the loop can try another
 * candidate when it is wrong. Fail-OPEN on any API error, so a transient blip
 * never drops a good ref.
 *
 * NON-PEOPLE stay lenient: a slightly-off logo is cosmetic.
 *
 * PEOPLE are checked on IDENTITY, using `context` (their Geo description). A
 * web image search ranks well but does not understand identity — searching
 * "Robert Turner" also surfaces a software engineer, a law professor and a
 * media mogul. Asking only "is this a real face?" accepts all of them, and a
 * photograph of a DIFFERENT real person captioned with this person's name is
 * the worst thing this pipeline can emit.
 */
export async function refGate(
  buf: Buffer, mime: string, name: string, kind: string, context = "",
): Promise<GateResult> {
  const person =
    `You are checking whether a photograph can be used as the likeness of one specific real person.\n\n` +
    `PERSON: ${name}\n` +
    (context ? `WHO THEY ARE: ${context}\n` : "") +
    `\nReply one word, YES or NO.\n` +
    `Answer NO if ANY of these hold:\n` +
    `- it is not a real photograph of a real human face — a cartoon, anime, illustration, drawing, ` +
    `painting, 3D render, avatar, emoji, statue, logo, product, animal, or a scene with no clear face;\n` +
    `- it is a screenshot, a page banner, a book cover or a group shot with no single clear subject;\n` +
    `- it is plainly a DIFFERENT person who happens to share the name. Judge only from what you can ` +
    `see against the description: the era the photograph was taken (an obviously nineteenth- or ` +
    `early-twentieth-century portrait cannot be someone working today), the subject's apparent age ` +
    `against the life described, or dress, uniform or setting belonging to another era or another ` +
    `walk of life entirely;\n` +
    `- you positively recognise the person shown as somebody else.\n` +
    `Answer YES for a real photograph of one person that could genuinely be them. Do not infer from ` +
    `the name alone, and do not judge by ethnicity or appearance beyond what the description states. ` +
    `If it shows an ordinary adult and nothing contradicts the description, answer YES.`;

  const q = kind === "person"
    ? person
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
    return { ok, reason: ok ? "ok" : kind === "person" ? "not-this-person" : "wrong-ref" };
  } catch {
    return { ok: true, reason: "gate-error" }; // fail-OPEN
  }
}

// ── The resolve loop ────────────────────────────────────────────────
export interface Factor {
  name: string;
  kind: string;
  role: string;
  refQuery?: string;
  domain?: string;
  ownImageUrls?: string[];
  /** What the graph says about this factor — the person gate checks against it. */
  context?: string;
}

export interface ResolvedRef extends RefImage {
  name: string;
  role: string;
  kind: string;
  src: string;
  conf: number;
}

export interface ResolveResult {
  refs: ResolvedRef[];
  described: Array<{ name: string; role: string }>;
  /** One token per factor for the trace line. */
  scores: string[];
  /**
   * People no source could verify a likeness for. Drawing an invented face and
   * captioning it with their real name is a fabrication, so the caller keeps
   * them out of the frame entirely.
   */
  unverifiedPeople: string[];
}

/**
 * For each factor: walk its source chain, gate each candidate, keep the first
 * that passes; otherwise fall back to describing it in the prompt.
 * `geo-own` candidates never count against the try budget as long as they fail
 * to DOWNLOAD (a dead gateway is not evidence about the entity).
 */
export async function resolveRefs(factors: Factor[]): Promise<ResolveResult> {
  const refs: ResolvedRef[] = [];
  const described: Array<{ name: string; role: string }> = [];
  const scores: string[] = [];
  const unverifiedPeople: string[] = [];

  for (const f of factors) {
    const kind = (f.kind ?? "").toLowerCase();
    const name = f.name ?? "";
    let got: RefImage | null = null;
    let src = "";
    let conf = 0;
    let tries = 0;
    let gateReason = "";

    if (refs.length < MAXREF) {
      const cap = kind === "person" ? MAX_REF_TRIES_PERSON : MAX_REF_TRIES;
      for await (const cand of resolveCandidates(kind, name, f.refQuery ?? "", {
        domain: f.domain ?? "", ownImageUrls: f.ownImageUrls ?? [], context: f.context ?? "",
      })) {
        if (cand.conf < ENTITY_MIN_CONF) continue;
        if (tries >= cap) break; // depth cap -> describe
        const img = await download(cand.url);
        if (!img) continue; // dead URL / not an image -> next source (no try burned)
        tries++;
        const g = await refGate(img.buf, img.mime, name, kind, f.context ?? "");
        gateReason = g.reason;
        if (g.ok) {
          got = img;
          src = cand.src;
          conf = cand.conf;
          break; // first ref that passes the gate
        }
      }
    }

    if (got) {
      refs.push({ name, role: f.role ?? "", kind, src, conf, buf: got.buf, mime: got.mime });
      scores.push(`${name}=${src}:${conf.toFixed(2)}@t${tries}`);
    } else {
      described.push({ name: name || "?", role: f.role ?? "" });
      const gtag = gateReason && !["ok", "gate-error", ""].includes(gateReason) ? `⊘${gateReason}` : "none";
      scores.push(`${name}=describe(${gtag})`);
      if (kind === "person" && name) unverifiedPeople.push(name);
    }
  }

  return { refs, described, scores, unverifiedPeople };
}
