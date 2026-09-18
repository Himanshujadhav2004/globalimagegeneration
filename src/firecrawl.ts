/**
 * firecrawl.ts — web image search, used to find a photograph of a person the
 * curated sources do not cover.
 *
 * Wikipedia carries a portrait for public figures and nothing for everyone
 * else: an Oxford endocrinologist, a mid-century mycologist and a history
 * professor all resolved to nothing. Firecrawl's `/v2/search` with
 * `sources:["images"]` reaches the open web — obituaries, faculty pages,
 * society profiles — where those photographs actually live.
 *
 * The query is the person's name PLUS their Geo description, and that pairing
 * is what makes it work: "Robert Turner" alone returns a software engineer, a
 * law professor and a media mogul, while "Robert Turner British diabetologist
 * professor University of Oxford" puts the right man first.
 *
 * It returns SEVERAL candidates on purpose. The top hit is often hotlink-
 * protected (403 + an HTML body), and the list reliably contains other people
 * who share the name — so the caller walks the list and the vision gate in
 * refs.ts decides which one is actually this person.
 *
 * Optional: with no FIRECRAWL_KEY the source is simply skipped, exactly like
 * Brandfetch. Never throws.
 */

import { FIRECRAWL_KEY } from "./config.js";

const ENDPOINT = "https://api.firecrawl.dev/v2/search";

/** One image result, as much of it as we use. */
interface FirecrawlImage {
  imageUrl?: string;
  url?: string;
  title?: string;
}

export const firecrawlEnabled = (): boolean => FIRECRAWL_KEY().length > 0;

/** Name particles and honorifics that carry no identifying signal. */
const PARTICLES = new Set([
  "de", "la", "le", "van", "von", "der", "den", "del", "di", "da", "dos", "bin", "ibn",
  "the", "and", "dr", "prof", "mr", "mrs", "ms", "jr", "sr", "phd", "md",
]);

/** lowercase, strip accents and punctuation — "Jesús San-Miguel" -> "jesus san miguel". */
const flatten = (s: string): string =>
  (s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim();

const nameTokens = (name: string): string[] =>
  flatten(name).split(/\s+/).filter((t) => t.length >= 3 && !PARTICLES.has(t));

/**
 * Does this result's title actually name the person we asked about?
 *
 * This is the check that stops the pipeline's worst failure. Searching "Thomas
 * Ham American hematologist" returns the right man at #1 and #2 (Find a Grave,
 * which blocks hotlinking so both fail to download) and then **Jesús San
 * Miguel, MD** at #3, which downloads cleanly. The vision gate sees only the
 * image — two middle-aged physicians in white coats — and cannot possibly tell
 * them apart. The title can, and it is free.
 *
 * Matching is by 5-character prefix so a title that clips or varies a spelling
 * ("Matin-Asgar" for "Matin-Asgari") still counts. Same-name strangers still
 * pass here; that is the vision gate's job, not this one's.
 */
export function titleNamesPerson(title: string, name: string): boolean {
  const tokens = nameTokens(name);
  if (!tokens.length) return true; // nothing to check against — don't filter
  const haystack = flatten(title);
  if (!haystack) return false; // an untitled result cannot be verified
  return tokens.every((t) => haystack.includes(t.slice(0, Math.min(t.length, 5))));
}

/**
 * Search the web for photographs of `name`, disambiguated by `context` (the
 * subject's Geo description). Returns image URLs in relevance order, best
 * first, de-duplicated. Returns [] when disabled or on any failure.
 */
export async function firecrawlImages(
  name: string, context = "", limit = 6, timeoutMs = 30_000,
): Promise<string[]> {
  const key = FIRECRAWL_KEY();
  const subject = (name ?? "").trim();
  if (!key || !subject) return [];

  const query = `${subject} ${(context ?? "").trim()}`.trim();
  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, sources: ["images"], limit }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return [];

    const j = (await r.json()) as { success?: boolean; data?: { images?: FirecrawlImage[] } };
    const images = j?.data?.images ?? [];
    const urls: string[] = [];
    for (const img of images) {
      const u = (img?.imageUrl ?? img?.url ?? "").trim();
      if (!/^https?:\/\//i.test(u) || urls.includes(u)) continue;
      // Drop results that are about somebody else entirely. Ranking degrades
      // fast past the first hits, and a plausible stranger's photo is the one
      // failure the vision gate cannot catch on its own.
      if (!titleNamesPerson(img?.title ?? "", subject)) continue;
      urls.push(u);
    }
    return urls;
  } catch {
    return []; // unreachable, timed out, or not JSON — just skip the source
  }
}
