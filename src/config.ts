/**
 * config.ts — every tunable, model id and endpoint in one place.
 *
 * Values that a test (or an operator) may want to flip per-call are read from
 * `process.env` LAZILY through a function; the rest are frozen at import.
 */

const env = (k: string, dflt: string): string => (process.env[k] ?? "").trim() || dflt;

// ── Models ──────────────────────────────────────────────────────────
export const PLANNER_MODEL = env("PLANNER_MODEL", "gpt-5.4");
export const VISION_MODEL = env("VISION_MODEL", "gpt-4.1-mini");
export const IMAGE_MODEL = env("IMAGE_MODEL", "gpt-image-2");

// ── Endpoints ───────────────────────────────────────────────────────
export const OPENAI_BASE = () => env("OPENAI_BASE_URL", "https://api.openai.com/v1");
export const GEO_GRAPHQL = () => env("GEO_GRAPHQL_URL", "https://api-testnet.geobrowser.io/graphql");

/** Ordered IPFS gateways — an entity's own avatar/cover is served from one of these. */
export const IPFS_GATEWAYS = (): string[] =>
  env("IPFS_GATEWAYS", "https://ipfs.io/ipfs/,https://dweb.link/ipfs/,https://gateway.pinata.cloud/ipfs/")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.endsWith("/") ? s : s + "/"));

export const BRANDFETCH_KEY = () => env("BRANDFETCH_KEY", "");

/**
 * Optional web image search — the only source that reaches past Wikipedia for
 * people. Accepts either env name; Firecrawl's own docs use both.
 */
export const FIRECRAWL_KEY = () => env("FIRECRAWL_KEY", "") || env("FIRECRAWL_API_KEY", "");

// ── Render size ─────────────────────────────────────────────────────
/** The one output shape: the editorial cover banner. */
export const RENDER_SIZE = "1536x640";
/** Used once if the image model rejects RENDER_SIZE; still crops to a banner. */
export const FALLBACK_SIZE = "1536x1024";

// ── Pipeline tunables (carried over from factors114 / cover-pipeline) ─
export const MAXREF = 4;                 // reference images fed to the edits endpoint
export const QC_RETRIES = 2;             // detect-and-regenerate passes on a glitchy render
export const MAX_REF_TRIES = 2;          // candidates gated per factor before describing
export const MAX_REF_TRIES_PERSON = 6;   // people: dig past bad avatars, 403s and same-name strangers
export const MAX_FACTORS = 6;            // planner factors honoured per subject
export const ENTITY_MIN_CONF = 0.7;      // reject a source below this trust score
export const MAXPX = 2000;               // downsize refs before the edits endpoint

/** Per-source confidence — higher = more trusted likeness/logo. */
export const CONF: Record<string, number> = {
  "geo-own": 0.99, // the entity's OWN Avatar/Cover in the graph — best possible ref
  brandfetch: 0.99,
  coingecko: 0.98,
  geo: 0.97,
  db: 0.96,
  wikidata: 0.95,
  wikipedia: 0.88,
  firecrawl: 0.85, // open-web image search — good ranking, but strangers share names
  commons: 0.8,
};

export const USER_AGENT =
  "geo-image-skill/1.0 (grounded subject imagery; +https://github.com/geo-explorers/news-worker)";

/** sharp is optional — set to 1 to force the no-sharp code paths (tests). */
export const noSharp = (): boolean => env("GEO_IMAGE_NO_SHARP", "") === "1";
