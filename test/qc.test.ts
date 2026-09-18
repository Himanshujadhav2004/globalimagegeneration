import { describe, it, afterEach, before } from "node:test";
import assert from "node:assert/strict";
import { qcInspect, qcPrompt } from "../src/qc.js";
import { PROFILES } from "../src/art.js";
import { chatRes, errorRes, JPEG_BYTES, mockFetch, PNG_BYTES, type MockHandle } from "./helpers/mock.js";

let net: MockHandle | null = null;
before(() => {
  process.env.GEO_IMAGE_SLEEP_SCALE = "0";
  process.env.OPENAI_API_KEY ||= "test-key";
});
afterEach(() => {
  net?.restore();
  net = null;
});

describe("qcPrompt", () => {
  it("always runs the text pass", () => {
    for (const p of PROFILES) assert.match(qcPrompt(p), /PASS 1 TEXT/, p);
  });

  it("checks hands where people belong and form where they do not", () => {
    assert.match(qcPrompt("editorial"), /PASS 2 HANDS/);
    assert.match(qcPrompt("portrait"), /PASS 2 HANDS/);
    assert.match(qcPrompt("still-life"), /PASS 2 FORM/);
    assert.match(qcPrompt("emblem"), /PASS 2 FORM/);
    assert.match(qcPrompt("landmark"), /PASS 2 FORM/);
  });

  it("checks the centred square crop in every profile", () => {
    for (const p of PROFILES) assert.match(qcPrompt(p), /PASS 3 CROP/, p);
    // Narrow on purpose: off-centre is not a defect, only a subject the crop misses.
    assert.match(qcPrompt("editorial"), /merely a little off-centre.+is NOT a defect/s);
  });

  it("keeps the intentional-softness and satirical-denomination carve-outs", () => {
    const p = qcPrompt("editorial");
    assert.match(p, /Do NOT flag text that is intentionally soft/);
    assert.match(p, /never flag a bill merely because its value is unusual/);
  });

  it("asks for JSON only", () => {
    assert.match(qcPrompt("editorial"), /reply ONLY JSON/);
  });
});

describe("qcInspect", () => {
  it("passes a clean image", async () => {
    net = mockFetch(() => chatRes('{"bad":false,"reason":"clean"}'));
    assert.deepEqual(await qcInspect(PNG_BYTES), { bad: false, reason: "clean" });
  });

  it("reports a defect and its reason", async () => {
    net = mockFetch(() => chatRes('{"bad":true,"reason":"PASS 1 TEXT: crate reads GOCDS"}'));
    const r = await qcInspect(JPEG_BYTES, "editorial");
    assert.equal(r.bad, true);
    assert.match(r.reason, /GOCDS/);
  });

  it("truncates a rambling reason", async () => {
    net = mockFetch(() => chatRes(JSON.stringify({ bad: true, reason: "x".repeat(200) })));
    assert.equal((await qcInspect(PNG_BYTES)).reason.length, 60);
  });

  it("sends the right mime for PNG and JPEG bytes", async () => {
    net = mockFetch(() => chatRes('{"bad":false}'));
    await qcInspect(PNG_BYTES);
    await qcInspect(JPEG_BYTES);
    assert.match(net.calls[0].json.messages[0].content[1].image_url.url, /^data:image\/png/);
    assert.match(net.calls[1].json.messages[0].content[1].image_url.url, /^data:image\/jpeg/);
  });

  it("uses the profile's own prompt", async () => {
    net = mockFetch(() => chatRes('{"bad":false}'));
    await qcInspect(PNG_BYTES, "emblem");
    assert.match(net.calls[0].json.messages[0].content[0].text, /PASS 2 FORM/);
  });

  it("fails OPEN when the vision call errors", async () => {
    net = mockFetch(() => errorRes(500, "down"));
    assert.deepEqual(await qcInspect(PNG_BYTES), { bad: false, reason: "qc-error" });
  });

  it("fails OPEN when the reply is not JSON", async () => {
    net = mockFetch(() => chatRes("looks fine to me"));
    assert.deepEqual(await qcInspect(PNG_BYTES), { bad: false, reason: "qc-error" });
  });

  it("treats a missing bad flag as clean", async () => {
    net = mockFetch(() => chatRes('{"reason":"nothing to report"}'));
    assert.equal((await qcInspect(PNG_BYTES)).bad, false);
  });
});
