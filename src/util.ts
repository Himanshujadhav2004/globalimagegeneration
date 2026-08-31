/**
 * util.ts — small shared helpers (no I/O, no config): sleep, tolerant JSON
 * parsing of model output, slugs, ordinals, text tidying.
 */

/**
 * Sleep, scaled by GEO_IMAGE_SLEEP_SCALE (default 1). Tests set it to 0 so the
 * back-off paths can be exercised without waiting out a 15-second 429 nap.
 */
export function sleep(ms: number): Promise<void> {
  const scale = Number(process.env.GEO_IMAGE_SLEEP_SCALE ?? "1");
  const delay = Number.isFinite(scale) ? ms * scale : ms;
  return new Promise((r) => setTimeout(r, Math.max(0, delay)));
}

const ORD = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth"];

/** "first", "second", … then "9th", "10th" — used to label reference images in the prompt. */
export function ordinal(i: number): string {
  return ORD[i] ?? `${i + 1}th`;
}

/**
 * Extract the first balanced JSON object/array from a model reply.
 * Tolerates ```json fences, leading prose and trailing commentary; respects
 * strings and escapes so a brace inside a string never ends the scan.
 */
function firstJsonBlob(text: string): string | null {
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return text.slice(i, j + 1);
      }
    }
  }
  return null;
}

/**
 * Parse a model's JSON reply. Throws a descriptive Error (never returns
 * undefined) so callers can retry or fail the subject with a real reason.
 */
export function parseJSON<T>(text: string): T {
  const raw = (text ?? "").replace(/^\uFEFF/, "").trim();
  if (!raw) throw new Error("model returned empty output (expected JSON)");

  const unfenced = raw
    .replace(/^```(?:json|JSON)?\s*/m, "")
    .replace(/```\s*$/m, "")
    .trim();

  for (const candidate of [unfenced, raw, firstJsonBlob(unfenced) ?? "", firstJsonBlob(raw) ?? ""]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      /* try the next shape */
    }
  }
  throw new Error(`model did not return JSON: ${raw.slice(0, 120)}`);
}

/** Filesystem-safe, url-safe slug (ASCII, max 80 chars). */
export function slugify(text: string): string {
  return (text ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

/** Collapse whitespace and hard-cap length — dossier lines must stay short. */
export function tidy(s: unknown, max = 240): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

/** Stable de-dupe preserving first-seen order. */
export function uniqueBy<T>(items: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const k = key(it);
    if (k && seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/**
 * Geo ids are 32 lowercase hex chars; the API also accepts (and humans paste)
 * dashed UUIDs. Returns the canonical 32-hex form, or null if it isn't an id.
 */
export function normalizeGeoId(input: string): string | null {
  const s = (input ?? "").trim().toLowerCase().replace(/-/g, "");
  return /^[0-9a-f]{32}$/.test(s) ? s : null;
}

/** True when the string looks like an id rather than a name to search for. */
export const looksLikeGeoId = (s: string): boolean => normalizeGeoId(s) !== null;
