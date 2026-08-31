import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { chatCompletion, dataUrl, imageEdit, imageGenerate, requireOpenAIKey } from "../src/openai.js";
import { chatRes, errorRes, imageRes, jsonRes, mockFetch, PNG_BYTES, type MockHandle } from "./helpers/mock.js";

let net: MockHandle | null = null;

before(() => {
  process.env.GEO_IMAGE_SLEEP_SCALE = "0"; // exercise back-off without waiting
  process.env.OPENAI_API_KEY ||= "test-key";
});

afterEach(() => {
  net?.restore();
  net = null;
});

// ── key + helpers ───────────────────────────────────────────────────
describe("requireOpenAIKey", () => {
  it("returns the key", () => {
    assert.equal(typeof requireOpenAIKey(), "string");
  });

  it("throws a clear error when it is missing or blank", () => {
    const prev = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "   ";
      assert.throws(() => requireOpenAIKey(), /OPENAI_API_KEY required/);
      delete process.env.OPENAI_API_KEY;
      assert.throws(() => requireOpenAIKey(), /OPENAI_API_KEY required/);
    } finally {
      process.env.OPENAI_API_KEY = prev;
    }
  });
});

describe("dataUrl", () => {
  it("builds a base64 data URL", () => {
    assert.equal(dataUrl(Buffer.from("hi"), "image/png"), "data:image/png;base64,aGk=");
  });
});

// ── chat ────────────────────────────────────────────────────────────
describe("chatCompletion", () => {
  const msg = [{ role: "user" as const, content: "hi" }];

  it("returns the message text", async () => {
    net = mockFetch(() => chatRes("  hello  "));
    assert.equal(await chatCompletion({ model: "gpt-4.1-mini", messages: msg }), "hello");
  });

  it("uses max_completion_tokens for reasoning models and max_tokens otherwise", async () => {
    net = mockFetch(() => chatRes("ok"));
    await chatCompletion({ model: "gpt-5.4", messages: msg, maxTokens: 100 });
    await chatCompletion({ model: "gpt-4.1-mini", messages: msg, maxTokens: 100 });
    assert.equal(net.calls[0].json.max_completion_tokens, 100);
    assert.equal(net.calls[0].json.max_tokens, undefined);
    assert.equal(net.calls[1].json.max_tokens, 100);
    assert.equal(net.calls[1].json.max_completion_tokens, undefined);
  });

  it("sends the auth header and json mode only when asked", async () => {
    net = mockFetch(() => chatRes("ok"));
    await chatCompletion({ model: "gpt-4.1-mini", messages: msg, jsonMode: true });
    await chatCompletion({ model: "gpt-4.1-mini", messages: msg });
    assert.match(net.calls[0].init.headers.Authorization, /^Bearer /);
    assert.deepEqual(net.calls[0].json.response_format, { type: "json_object" });
    assert.equal(net.calls[1].json.response_format, undefined);
  });

  it("retries a 429 and then succeeds", async () => {
    let n = 0;
    net = mockFetch(() => (++n === 1 ? errorRes(429, "rate limited") : chatRes("second time lucky")));
    assert.equal(await chatCompletion({ model: "gpt-4.1-mini", messages: msg }), "second time lucky");
    assert.equal(n, 2);
  });

  it("retries a 500 and a network error", async () => {
    let n = 0;
    net = mockFetch(() => {
      n++;
      if (n === 1) return errorRes(503, "unavailable");
      if (n === 2) return new Error("ECONNRESET");
      return chatRes("recovered");
    });
    assert.equal(await chatCompletion({ model: "gpt-4.1-mini", messages: msg, retries: 3 }), "recovered");
  });

  it("gives up after the retry budget", async () => {
    let n = 0;
    net = mockFetch(() => {
      n++;
      return errorRes(503, "unavailable");
    });
    await assert.rejects(() => chatCompletion({ model: "gpt-4.1-mini", messages: msg, retries: 2 }), /HTTP 503/);
    assert.equal(n, 3, "initial attempt plus two retries");
  });

  it("fails immediately on a non-retryable status", async () => {
    let n = 0;
    net = mockFetch(() => {
      n++;
      return errorRes(400, "bad request");
    });
    await assert.rejects(() => chatCompletion({ model: "gpt-4.1-mini", messages: msg }), /HTTP 400/);
    assert.equal(n, 1, "a 400 must not be retried");
  });

  it("fails immediately when the account is out of credits (a 429 that never clears)", async () => {
    let n = 0;
    net = mockFetch(() => {
      n++;
      return errorRes(429, JSON.stringify({ error: { message: "You have no credits remaining." } }));
    });
    await assert.rejects(() => chatCompletion({ model: "gpt-4.1-mini", messages: msg }), /no credits/);
    assert.equal(n, 1, "retrying a quota failure only wastes time");
  });

  it("also stops on insufficient_quota", async () => {
    let n = 0;
    net = mockFetch(() => {
      n++;
      return errorRes(429, '{"error":{"code":"insufficient_quota"}}');
    });
    await assert.rejects(() => chatCompletion({ model: "gpt-4.1-mini", messages: msg }));
    assert.equal(n, 1);
  });

  it("retries with a bigger budget when reasoning ate the whole allowance", async () => {
    let n = 0;
    net = mockFetch(() => (++n === 1 ? chatRes("", "length") : chatRes("finally")));
    const out = await chatCompletion({ model: "gpt-5.4", messages: msg, maxTokens: 100 });
    assert.equal(out, "finally");
    assert.equal(net.calls[0].json.max_completion_tokens, 100);
    assert.equal(net.calls[1].json.max_completion_tokens, 400, "budget grows once");
  });

  it("does not grow the budget forever", async () => {
    net = mockFetch(() => chatRes("", "length"));
    await assert.rejects(
      () => chatCompletion({ model: "gpt-5.4", messages: msg, maxTokens: 100, retries: 3 }),
      /empty completion/,
    );
    const budgets = net.calls.map((c) => c.json.max_completion_tokens);
    assert.deepEqual(budgets, [100, 400, 400, 400]);
  });

  it("reports an empty completion rather than returning nothing", async () => {
    net = mockFetch(() => jsonRes({ choices: [{ message: {}, finish_reason: "stop" }] }));
    await assert.rejects(() => chatCompletion({ model: "gpt-4.1-mini", messages: msg, retries: 0 }), /empty completion/);
  });
});

// ── images ──────────────────────────────────────────────────────────
describe("imageGenerate", () => {
  it("returns the decoded bytes", async () => {
    net = mockFetch(() => imageRes(PNG_BYTES));
    const buf = await imageGenerate("a prompt", "1536x640");
    assert.deepEqual(buf, PNG_BYTES);
  });

  it("sends the model, size, quality and jpeg output", async () => {
    net = mockFetch(() => imageRes());
    await imageGenerate("a prompt", "1024x1024");
    const b = net.calls[0].json;
    assert.equal(b.size, "1024x1024");
    assert.equal(b.n, 1);
    assert.equal(b.quality, "low");
    assert.equal(b.output_format, "jpeg");
    assert.equal(b.prompt, "a prompt");
  });

  it("swaps to the fallback size once when the model rejects the size", async () => {
    const sizes: string[] = [];
    net = mockFetch((_u, _i, call) => {
      sizes.push(call.json.size);
      return call.json.size === "1536x640"
        ? errorRes(400, '{"error":{"message":"Invalid value for size: 1536x640"}}')
        : imageRes();
    });
    await imageGenerate("p", "1536x640", "1536x1024");
    assert.deepEqual(sizes, ["1536x640", "1536x1024"]);
  });

  it("does not loop forever if the fallback is rejected too", async () => {
    net = mockFetch(() => errorRes(400, "Invalid value for size"));
    await assert.rejects(() => imageGenerate("p", "1536x640", "1536x1024"), /HTTP 400/);
    assert.equal(net.calls.length, 2, "one swap, then stop");
  });

  it("treats a 400 that is not about size as fatal", async () => {
    net = mockFetch(() => errorRes(400, '{"error":{"message":"content policy"}}'));
    await assert.rejects(() => imageGenerate("p", "1024x1024", "1024x1024"), /content policy/);
    assert.equal(net.calls.length, 1);
  });

  it("retries a 429 and a 5xx", async () => {
    let n = 0;
    net = mockFetch(() => {
      n++;
      if (n === 1) return errorRes(429, "slow down");
      if (n === 2) return errorRes(500, "oops");
      return imageRes();
    });
    await imageGenerate("p", "1024x1024", undefined, 3);
    assert.equal(n, 3);
  });

  it("stops immediately when out of credits", async () => {
    net = mockFetch(() => errorRes(429, "You have no credits remaining."));
    await assert.rejects(() => imageGenerate("p", "1024x1024"), /no credits/);
    assert.equal(net.calls.length, 1);
  });

  it("rejects a 200 with no image payload", async () => {
    net = mockFetch(() => jsonRes({ data: [] }));
    await assert.rejects(() => imageGenerate("p", "1024x1024"), /no b64_json/);
  });

  it("rejects a payload that decodes to nothing", async () => {
    net = mockFetch(() => jsonRes({ data: [{ b64_json: "" }] }));
    await assert.rejects(() => imageGenerate("p", "1024x1024"), /no b64_json/);
  });
});

describe("imageEdit", () => {
  const refs = [{ buf: PNG_BYTES, mime: "image/png" }, { buf: Buffer.from("jpegish"), mime: "image/jpeg" }];

  it("uploads every reference with the right extension", async () => {
    net = mockFetch(() => imageRes());
    await imageEdit("a prompt", refs, "1536x640");
    const form = net.calls[0].form!;
    assert.equal(form.size, "1536x640");
    assert.equal(form.prompt, "a prompt");
    assert.match(form["image[]"], /ref1\.jpg/, "FormData keeps the last value for a repeated key");
    assert.equal(net.calls[0].init.headers.Authorization.startsWith("Bearer "), true);
  });

  it("works with no references at all", async () => {
    net = mockFetch(() => imageRes());
    assert.ok((await imageEdit("p", [], "1024x1024")).length > 0);
  });

  it("swaps size once, then retries transient failures", async () => {
    const sizes: string[] = [];
    let n = 0;
    net = mockFetch((_u, _i, call) => {
      sizes.push(call.form!.size);
      n++;
      if (n === 1) return errorRes(400, "Invalid value for size");
      if (n === 2) return errorRes(429, "slow down");
      return imageRes();
    });
    await imageEdit("p", refs, "1536x640", "1536x1024", 3);
    assert.deepEqual(sizes, ["1536x640", "1536x1024", "1536x1024"]);
  });

  it("surfaces a persistent failure", async () => {
    net = mockFetch(() => new Error("socket hang up"));
    await assert.rejects(() => imageEdit("p", refs, "1024x1024", undefined, 1), /socket hang up/);
  });
});
