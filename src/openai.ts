/**
 * openai.ts — the only module that talks to OpenAI.
 *
 * Self-contained on purpose: the skill drops into any repo without dragging a
 * client library along, and every network call goes through global `fetch`, so
 * tests stub exactly one thing.
 *
 * Exposes the same surface the news pipeline already imports (`chatCompletion`,
 * `dataUrl`, `requireOpenAIKey`, model ids) plus the two image endpoints.
 */

import { IMAGE_MODEL, OPENAI_BASE, PLANNER_MODEL, VISION_MODEL } from "./config.js";
import { sleep } from "./util.js";

export { IMAGE_MODEL, PLANNER_MODEL, VISION_MODEL };

// ── Types ───────────────────────────────────────────────────────────
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  jsonMode?: boolean;
  timeoutMs?: number;
  retries?: number;
}

export interface ImageRef {
  buf: Buffer;
  mime: string;
}

// ── Key ─────────────────────────────────────────────────────────────
export function requireOpenAIKey(): string {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) throw new Error("OPENAI_API_KEY required");
  return key;
}

/** base64 data URL for a vision message part. */
export const dataUrl = (buf: Buffer, mime: string): string =>
  `data:${mime};base64,${buf.toString("base64")}`;

/** Reasoning-family models bill hidden reasoning against the completion budget. */
const isReasoningModel = (model: string): boolean => /^(gpt-5|o[1-9])/i.test(model);

const retryableStatus = (s: number): boolean => s === 408 || s === 409 || s === 429 || s >= 500;

/**
 * A 429 is usually rate limiting — but "no credits" and "quota exceeded" also
 * arrive as 429 and will never clear on their own. Retrying those just burns
 * three sleeps before failing with the same message.
 */
const permanentFailure = (body: string): boolean =>
  /insufficient_quota|no credits remaining|exceeded your current quota|billing_hard_limit/i.test(body);

// ── Chat / vision ───────────────────────────────────────────────────
/**
 * One chat (or vision) completion, returned as plain text.
 *
 * Retries transient failures (429 / 5xx / network). If a reasoning model burns
 * the whole budget on hidden reasoning and returns empty text, retries ONCE with
 * a doubled cap rather than failing the subject.
 */
export async function chatCompletion(opts: ChatOptions): Promise<string> {
  const key = requireOpenAIKey();
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 90_000;
  let budget = opts.maxTokens ?? 800;
  let grew = false;
  let last = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    const body: Record<string, unknown> = { model: opts.model, messages: opts.messages };
    if (isReasoningModel(opts.model)) body.max_completion_tokens = budget;
    else body.max_tokens = budget;
    if (opts.jsonMode) body.response_format = { type: "json_object" };

    try {
      const r = await fetch(`${OPENAI_BASE()}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (r.status === 200) {
        const j = (await r.json()) as any;
        const choice = j?.choices?.[0];
        const text = String(choice?.message?.content ?? "").trim();
        if (text) return text;
        // Empty body: budget exhausted by reasoning tokens -> one bigger try.
        if (!grew && choice?.finish_reason === "length") {
          grew = true;
          budget = Math.min(budget * 4, 16_000);
          continue;
        }
        last = `empty completion (finish_reason=${choice?.finish_reason ?? "?"})`;
      } else {
        const text = await r.text().catch(() => "");
        last = `HTTP ${r.status}: ${text.slice(0, 160)}`;
        if (!retryableStatus(r.status) || permanentFailure(text)) throw new Error(last);
        if (r.status === 429) {
          await sleep(10_000);
          continue;
        }
      }
    } catch (e: any) {
      if (e?.message && String(e.message).startsWith("HTTP ")) throw e; // non-retryable
      last = `request error: ${String(e?.message ?? e).slice(0, 140)}`;
    }
    if (attempt < retries) await sleep(2_000 * (attempt + 1));
  }
  throw new Error(last || "chat completion failed");
}

// ── Images ──────────────────────────────────────────────────────────
const extFor = (mime: string): string =>
  mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";

/** A size the API rejected is not worth three more attempts — swap once and move on. */
function sizeRejected(status: number, bodyText: string): boolean {
  return status === 400 && /\bsize\b/i.test(bodyText);
}

/**
 * `/images/edits` — render WITH reference images so real faces, logos and seals
 * carry through. `retries` covers TRANSIENT failures only (network / 5xx / 429);
 * bad-looking output is handled by the QC loop, not here.
 */
export async function imageEdit(
  prompt: string, refs: ImageRef[], size: string, fallbackSize?: string, retries = 2,
): Promise<Buffer> {
  const key = requireOpenAIKey();
  let useSize = size;
  let swapped = false;
  let last = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    const form = new FormData();
    form.append("model", IMAGE_MODEL);
    form.append("prompt", prompt);
    form.append("size", useSize);
    form.append("quality", "low");
    form.append("n", "1");
    form.append("moderation", "low");
    refs.forEach((r, i) => {
      // Copy into a fresh Uint8Array<ArrayBuffer> — Buffer's backing buffer is
      // typed ArrayBufferLike and isn't directly assignable to BlobPart.
      form.append("image[]", new Blob([new Uint8Array(r.buf)], { type: r.mime }), `ref${i}.${extFor(r.mime)}`);
    });

    try {
      const r = await fetch(`${OPENAI_BASE()}/images/edits`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(300_000),
      });
      if (r.status === 200) return decodeImage(await r.json());

      const text = await r.text().catch(() => "");
      last = `HTTP ${r.status}: ${text.slice(0, 160)}`;
      if (!swapped && fallbackSize && fallbackSize !== useSize && sizeRejected(r.status, text)) {
        useSize = fallbackSize;
        swapped = true;
        continue; // retry immediately at a size this model accepts
      }
      if (!retryableStatus(r.status) || permanentFailure(text)) break;
      if (r.status === 429) {
        await sleep(15_000);
        continue;
      }
    } catch (e: any) {
      last = `request error: ${String(e?.message ?? e).slice(0, 140)}`;
    }
    if (attempt < retries) await sleep(3_000 * (attempt + 1));
  }
  throw new Error(last || "image edit failed");
}

/** `/images/generations` — no references; everything is described in-prompt. */
export async function imageGenerate(
  prompt: string, size: string, fallbackSize?: string, retries = 2,
): Promise<Buffer> {
  const key = requireOpenAIKey();
  let useSize = size;
  let swapped = false;
  let last = "";

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${OPENAI_BASE()}/images/generations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: IMAGE_MODEL, prompt, n: 1, size: useSize,
          quality: "low", moderation: "low", output_format: "jpeg",
        }),
        signal: AbortSignal.timeout(300_000),
      });
      if (r.status === 200) return decodeImage(await r.json());

      const text = await r.text().catch(() => "");
      last = `HTTP ${r.status}: ${text.slice(0, 160)}`;
      if (!swapped && fallbackSize && fallbackSize !== useSize && sizeRejected(r.status, text)) {
        useSize = fallbackSize;
        swapped = true;
        continue;
      }
      if (!retryableStatus(r.status) || permanentFailure(text)) break; // non-retryable -> surface now
      if (r.status === 429) {
        await sleep(15_000);
        continue;
      }
    } catch (e: any) {
      last = `request error: ${String(e?.message ?? e).slice(0, 140)}`;
    }
    if (attempt < retries) await sleep(3_000 * (attempt + 1));
  }
  throw new Error(last || "image generation failed");
}

function decodeImage(j: any): Buffer {
  const b64 = j?.data?.[0]?.b64_json;
  if (typeof b64 !== "string" || !b64) throw new Error("image response carried no b64_json");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error("image response decoded to zero bytes");
  return buf;
}
