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
      if (/^https?:\/\//i.test(u) && !urls.includes(u)) urls.push(u);
    }
    return urls;
  } catch {
    return []; // unreachable, timed out, or not JSON — just skip the source
  }
}
