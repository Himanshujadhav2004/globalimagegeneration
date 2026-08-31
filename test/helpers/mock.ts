/**
 * mock.ts — one place to fake the network.
 *
 * Every module in src/ reaches the outside world through global `fetch`, so a
 * single stub covers the Geo API, Wikipedia/Wikidata/Commons, IPFS gateways and
 * OpenAI. `mockFetch` records what was sent so tests can assert on the request,
 * not just the reply.
 */

export interface RecordedCall {
  url: string;
  method: string;
  /** Parsed JSON body when the request sent JSON, else undefined. */
  json?: any;
  /** FormData fields when the request sent multipart, else undefined. */
  form?: Record<string, string>;
  init: any;
}

export type MockHandler = (url: string, init: any, call: RecordedCall) => any;

export interface MockHandle {
  calls: RecordedCall[];
  restore: () => void;
  /** Calls whose URL contains `needle`. */
  to: (needle: string) => RecordedCall[];
}

// Every test file imports this module, and the runner gives each file its own
// process — so this is the one place that guarantees the same test environment
// everywhere: no real key, and no real waiting in the back-off paths.
process.env.GEO_IMAGE_SLEEP_SCALE ??= "0";
process.env.OPENAI_API_KEY ||= "test-key";

const realFetch = globalThis.fetch;

/** Install a fetch stub. The handler may return a Response, or a spec object. */
export function mockFetch(handler: MockHandler): MockHandle {
  const calls: RecordedCall[] = [];

  globalThis.fetch = (async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    const call: RecordedCall = { url, method: (init.method ?? "GET").toUpperCase(), init };

    if (typeof init.body === "string") {
      try {
        call.json = JSON.parse(init.body);
      } catch {
        /* not JSON */
      }
    } else if (init.body instanceof FormData) {
      const form: Record<string, string> = {};
      for (const [k, v] of init.body.entries()) {
        form[k] = typeof v === "string" ? v : `[blob ${(v as File).size}b ${(v as File).name}]`;
      }
      call.form = form;
    }
    calls.push(call);

    const out = await handler(url, init, call);
    if (out instanceof Response) return out;
    if (out instanceof Error) throw out;
    if (out === undefined || out === null) return new Response("not found", { status: 404 });
    return out as Response;
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = realFetch;
    },
    to: (needle: string) => calls.filter((c) => c.url.includes(needle)),
  };
}

// ── Response builders ───────────────────────────────────────────────
export const jsonRes = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const textRes = (body: string, status = 200, contentType = "text/plain"): Response =>
  new Response(body, { status, headers: { "content-type": contentType } });

export const bytesRes = (buf: Buffer, contentType = "application/octet-stream", status = 200): Response =>
  new Response(new Uint8Array(buf), { status, headers: { "content-type": contentType } });

export const errorRes = (status: number, body = "boom"): Response => new Response(body, { status });

// ── Byte fixtures ───────────────────────────────────────────────────
/** A real 1x1 PNG. */
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** A real 1x1 JPEG. */
export const JPEG_BYTES = Buffer.from(
  "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==",
  "base64",
);

/** A tiny GIF87a (needs sharp to become a usable ref). */
export const GIF_BYTES = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

export const SVG_BYTES = Buffer.from(
  `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#c33"/></svg>`,
);

/** What ipfs.io actually returns for a CID holding a saved error page. */
export const HTML_BYTES = Buffer.from(
  `<!DOCTYPE html>\n<html lang="en">\n<meta charset="utf-8">\n<title>Wikimedia Error</title>\n<body>nope</body></html>`,
);

export const WEBP_BYTES = (() => {
  const b = Buffer.alloc(20);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(12, 4);
  b.write("WEBPVP8 ", 8, "ascii");
  return b;
})();

// ── OpenAI reply builders ───────────────────────────────────────────
export const chatRes = (content: string, finishReason = "stop"): Response =>
  jsonRes({ choices: [{ message: { content }, finish_reason: finishReason }] });

export const imageRes = (buf: Buffer = PNG_BYTES): Response =>
  jsonRes({ data: [{ b64_json: buf.toString("base64") }] });

// ── Geo reply builders ──────────────────────────────────────────────
export const geoRes = (data: unknown): Response => jsonRes({ data });
export const geoErrRes = (message: string): Response => jsonRes({ errors: [{ message }] });

/** Minimal entity row shaped like the live API's. */
export function entityRow(over: Partial<Record<string, any>> = {}): any {
  return {
    id: "0068f0fc16034c749c991e6eabe37031",
    name: "Ethereum",
    description: "A decentralized, open-source blockchain platform.",
    spaceIds: ["fae5c35a91712b2cae3dd5028d3aba3f"],
    types: [{ id: "484a18c5030a499cb0f2ef588ff16d50", name: "Project" }],
    valuesList: [],
    relationsList: [],
    ...over,
  };
}

/** Set the env for a test and restore it afterwards. */
export function withEnv(vars: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  const out = fn();
  if (out instanceof Promise) return out.finally(restore);
  restore();
  return out;
}
