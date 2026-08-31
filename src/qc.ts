/**
 * qc.ts — look at the render and decide whether to re-render.
 *
 * Two passes, and both are deliberately narrow: the renderer is *told* to make
 * small text soft and impressionistic, so a QC that flags "unreadable text"
 * would reject every good image. Only real defects count — sharp text that
 * spells something wrong, and (where people are expected) a malformed hand.
 *
 * Fails OPEN: a QC that errors keeps the image. A false "bad" costs a render.
 */

import { chatCompletion, dataUrl, VISION_MODEL } from "./openai.js";
import { expectsPeople, type Profile } from "./art.js";
import { parseJSON } from "./util.js";

const PASS1_TEXT =
  `PASS 1 TEXT: flag ONLY text that is sharply rendered but WRONG — clearly-formed letters that ` +
  `spell a misspelled, doubled, backwards or nonsense word, or a real word with a wrong or ` +
  `substituted character (for example ANTHROPIC with a slash in place of the I, OF doubled into ` +
  `OF OF, or GOODS rendered as GOCDS). Do NOT flag text that is intentionally soft, blurred, ` +
  `small, impressionistic, partial or out-of-focus — that is by design — and do NOT flag ` +
  `correctly-spelled text. ` +
  `A satirical or non-standard banknote DENOMINATION is INTENTIONAL in this product — never flag a ` +
  `bill merely because its value is unusual or "not a real denomination" (e.g. a "$250 bill" or a ` +
  `"250" note are fine); judge banknote text ONLY by spelling and letter-formation — flag a real ` +
  `MISSPELLING like "TWO HENDRED FIFTY", but never the denomination value "250" itself nor a ` +
  `correctly-spelled "TWO HUNDRED FIFTY". `;

const PASS2_HANDS =
  `PASS 2 HANDS: flag ONLY a prominent, clearly-visible hand that is obviously MALFORMED (fused ` +
  `fingers, a mitten-like blob, extra or missing fingers, wrong finger count, a warped thumb); a ` +
  `tiny, distant or motion-blurred background hand is NOT a defect. `;

const PASS2_FORM =
  `PASS 2 FORM: this image must read as ONE real photograph of real physical objects. Flag ONLY a ` +
  `glaring breach: it is a collage, split-screen, grid or inset of separate pictures; or it is ` +
  `plainly not a photograph but a screenshot, user interface, chart, diagram, icon, clip-art or 3D ` +
  `render; or a hand or human face is prominent AND obviously malformed. Soft focus, plain ` +
  `backgrounds, unusual objects and empty space are NOT defects. `;

const CLOSING =
  `Set bad=true only if a pass finds a clear, glaring defect a reader would notice at a glance; ` +
  `otherwise bad=false. Name the pass and what you saw in reason.`;

const HEADER =
  `Strict QA on an AI-generated photograph. Examine it in two passes, then reply ONLY JSON ` +
  `{"bad": true|false, "reason": "..."}. `;

export function qcPrompt(profile: Profile): string {
  return HEADER + PASS1_TEXT + (expectsPeople(profile) ? PASS2_HANDS : PASS2_FORM) + CLOSING;
}

export interface QcResult {
  bad: boolean;
  reason: string;
}

/** Inspect one rendered image. Never throws. */
export async function qcInspect(img: Buffer, profile: Profile = "editorial"): Promise<QcResult> {
  const mime = img.length >= 8 && img[0] === 0x89 && img[1] === 0x50 ? "image/png" : "image/jpeg";
  try {
    const txt = await chatCompletion({
      model: VISION_MODEL,
      maxTokens: 80,
      jsonMode: true,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: qcPrompt(profile) },
          { type: "image_url", image_url: { url: dataUrl(img, mime) } },
        ],
      }],
    });
    const j = parseJSON<{ bad?: boolean; reason?: string }>(txt);
    return { bad: !!j.bad, reason: String(j.reason ?? "").slice(0, 60) };
  } catch {
    return { bad: false, reason: "qc-error" }; // fail-OPEN
  }
}
