/**
 * cover-pipeline.ts — grounded editorial cover generation (port of factors114.py).
 *
 * Pipeline per story:
 *   1. PLAN     — gpt-5.3 breaks the headline into visual factors + a documentary
 *                 composition sentence (named people extracted for real faces;
 *                 satirical/fictional artifacts marked concept so they're built fresh).
 *   2. REFS     — for each factor, walk the per-kind source chain (cover-refs),
 *                 gate each candidate (LENIENT, person=real-face), keep the first
 *                 that passes (persons try deeper), else describe in-prompt.
 *   3. RENDER   — gpt-image-2 edits (with refs) or generations (none), 1536x640.
 *   4. QC       — gpt-4.1-mini inspects for sharp garbled text / malformed hands;
 *                 on a glitch, regenerate feeding the SPECIFIC defect back in
 *                 (targeted regen), up to QC_RETRIES.
 *
 * Returns the image bytes (base64) + mime + a scene description for the DB.
 */

import { parseJSON } from "./llm.js";
import {
  chatCompletion, dataUrl, requireOpenAIKey, sleep,
  IMAGE_MODEL, PLANNER_MODEL, VISION_MODEL,
} from "./openai.js";
import {
  resolveCandidates, download, refGate, ENTITY_MIN_CONF,
  type RefImage,
} from "./cover-refs.js";

// ── Tunables (match factors114) ─────────────────────────────────────
const MAXREF = 4;
const QC_RETRIES = 2; // detect-and-regenerate passes on a glitchy render
const MAX_REF_TRIES = 2; // ref candidates to gate per factor before describing
const MAX_REF_TRIES_PERSON = 4; // people: try deeper, past bad DB avatars to a real photo
const RENDER_SIZE = "1536x640";
const ORD = ["first", "second", "third", "fourth", "fifth"];

// ── Types ───────────────────────────────────────────────────────────
interface PlanFactor {
  name?: string;
  kind?: string;
  ref_query?: string;
  domain?: string;
  role?: string;
}
interface Plan {
  factors?: PlanFactor[];
  composition?: string;
  poster_text?: string;
}
interface Ref {
  name: string;
  role: string;
  kind: string;
  src: string;
  conf: number;
  buf: Buffer;
  mime: string;
}
interface Described {
  name: string;
  role: string;
}
export interface GroundedCover {
  imageBase64: string;
  mimeType: string;
  sceneDescription: string;
  /** Per-story diagnostic (ref sources + qc result) for logging. */
  trace: string;
}

// ── Stage 1: planner ────────────────────────────────────────────────
const EXTRACT =
  `You break a news headline into its KEY VISUAL FACTORS — the concrete real entities a cover image ` +
  `should depict. Include ONLY factors explicitly NAMED in the headline or DIRECTLY and UNAMBIGUOUSLY ` +
  `implied by it; never tangential or merely-associated elements. Fewer, exact factors beat padding.\n\n` +
  `NAMED PEOPLE: if the headline references a specific real person — directly, or via the X ` +
  `administration, X’s cabinet / team / campaign, or a personal title (President X, Senator X, ` +
  `CEO X) — ALSO include that exact person as a separate kind=person factor (their full name) so ` +
  `their real face is used; never collapse a recognizable named leader into only a government, ` +
  `company or administration entity.\n\n` +
  `FICTIONAL OR SATIRICAL ARTIFACTS: an object that does not really exist — a satirical, mock or ` +
  `hypothetical item, or a non-existent denomination such as a $250 bill — uses kind=concept, so it ` +
  `is described and built fresh in the scene and NEVER matched to a real photograph of a similar ` +
  `real object.\n\n` +
  `Output ONLY JSON:\n` +
  `  "factors": an ordered list (2-4, most important first) of objects:\n` +
  `     "name": the entity.\n` +
  `     "kind": EXACTLY one of: person | company | crypto | government | place | agreement | object | ` +
  `concept. (Use \`company\` for businesses/startups, \`crypto\` for a cryptocurrency/token, \`government\` ` +
  `for an agency/department/court/central bank, \`place\` for a building/landmark/country, \`agreement\` ` +
  `for a treaty/act/bill, \`concept\` for an abstract idea with no canonical image.)\n` +
  `     "ref_query": the canonical name to resolve the entity — a person's exact full name; a ` +
  `company/agency/place's common encyclopedic title; a token's name (e.g. "Stellar Lumens").\n` +
  `     "domain": for kind=company ONLY, the official website domain (e.g. "openai.com"); else "".\n` +
  `     "role": how it physically appears in the single photo as a real person or object (e.g. "the ` +
  `figure at a lectern", "the agency seal on the wall"); do NOT place it on a screen, chart, ticker, ` +
  `or text display.\n` +
  `  "composition": one vivid sentence describing a SINGLE cohesive, real-world documentary scene that ` +
  `combines these factors physically and tells the story through people, places and tangible objects — ` +
  `NOT through screens, charts, tickers, dashboards, holograms or infographics, and ` +
  `inventing no statistics, percentages, prices, index values, dates, captions or any ` +
  `fabricated data figures, and never depicting charts, graphs, tickers, dashboards, ` +
  `infographics or data-visualization overlays of any kind. You MAY, where the story calls for ` +
  `it, propose a physical printed document carrying its real short title, a real seal or badge, ` +
  `or money — banknotes or coins, including a satirical or non-existent denomination such as a ` +
  `face on a "$250 bill" — as tangible props, since a denomination or a short title is not a ` +
  `statistic; but money and documents must never carry or imply invented data figures, charts ` +
  `or tickers.\n` +
  `  "poster_text": OPTIONAL. ONE short editorial caption phrase (1-4 words, UPPERCASE) capturing the ` +
  `single core hook of the story. It is overlaid as a clean caption AFTER rendering (not drawn in the ` +
  `scene), so it need not fit any surface; keep it punchy and specific. Use "" if nothing crisp fits.\n\n` +
  `Output ONLY valid JSON.`;

async function extract(headline: string, summary: string): Promise<Plan> {
  const txt = await chatCompletion({
    model: PLANNER_MODEL,
    maxTokens: 900,
    jsonMode: true,
    timeoutMs: 120_000,
    messages: [
      { role: "system", content: EXTRACT },
      { role: "user", content: `HEADLINE: ${headline}\nCONTEXT: ${summary}` },
    ],
  });
  return parseJSON<Plan>(txt);
}

// ── Stage 3: compose prompt ─────────────────────────────────────────
const PERSON_REF_LINE = "a real photo of this person — preserve their exact face and identity";

const AGREEMENT_REF_LINE =
  `shown as a real printed document, report, bill or bound paper that carries its REAL ` +
  `SHORT TITLE — at most 1-3 short words (e.g. the act, treaty or bill name such as "USMCA" ` +
  `or "CLARITY ACT") — in large, plain block lettering set head-on and flat across the top ` +
  `or cover, fully legible. The body beneath it is generic, impressionistic printed ` +
  `texture: a soft, out-of-focus suggestion of prose with NO discrete or readable words, ` +
  `NOT ruled lines, columns, tables, grids, forms or ledgers, and NO charts, percentages, ` +
  `statistics or data figures of any kind. Never a blank or text-free sheet. If the title ` +
  `would have to be small, angled, wrapped or partly hidden, render only the part that ` +
  `stays large and head-on and let the rest dissolve into soft texture rather than crisp ` +
  `faux-words. No seal, crest, flag or insignia is printed on the document itself`;

const ENTITY_REF_LINE =
  `identify this entity by its REAL mark, captured the way a wire photo would catch it: a ` +
  `flat logo or wordmark, its short name in large plain block capitals, a building, or its ` +
  `actual seal, crest or badge — integrated naturally, never a floating sticker. If its ` +
  `real mark is a circular seal, crest or badge, you MAY show it: render the CENTRAL emblem ` +
  `(the eagle, star, shield, globe, animal or figure) sharp and correct, and render the ` +
  `encircling ring of text as a SOFT, out-of-focus band of indistinct type-like marks that ` +
  `merely SUGGESTS lettering — not spelled out, never sharp readable glyphs, and never left ` +
  `blank. Reproduce only THIS entity’s own real mark; invent no extra logos, seals, ` +
  `slogans, statistics or fine print. Keep all small, curved or dense lettering as soft ` +
  `impressionistic texture; if any of it would otherwise resolve into sharp garbled glyphs, ` +
  `render it as an out-of-focus tonal band or omit it — never as sharp messy lettering. If this ` +
  `entity’s mark is mainly a written WORDMARK (its name set as type, as with many ` +
  `tech-company logos), PREFER its graphic symbol or icon, a plain building or sign, and ` +
  `render any written name only as a SINGLE short word, very large and head-on — never ` +
  `spelling out a long or multi-word logotype; show the symbol or leave the surface plain ` +
  `rather than risk garbling the name`;

const STATIC_CLAUSES =
  `STRICT — ONE single unified photograph of ONE real physical place, NOT a collage, montage, ` +
  `diptych, split-screen, grid or inset. Every element coexists naturally in the same frame.\n\n` +
  `NO synthetic / sci-fi elements: no holograms, holographic overlays, glowing or translucent ` +
  `screens, floating icons, network or node graphics, neon glow, digital-particle effects, HUD ` +
  `or futuristic interface, or data-visualization overlays. Nothing glows or floats; render only ` +
  `real physical objects under real, available light.\n\n` +
  `TEXT — follow ONE governing principle: large, short, flat text and central emblems render ` +
  `FULLY and legibly, while small, dense, curved, angled or fine text renders as soft, ` +
  `realistic impressionistic texture — never as sharp garbled lettering, and never blank. ` +
  `SAFETY VALVE: if any text would resolve into sharp garbled glyphs, render it instead as an ` +
  `out-of-focus tonal band of indistinct marks, or omit it entirely — never spell it out and ` +
  `never draw sharp gibberish. So: a short real word — a short agency name, a document’s real ` +
  `short title, or a banknote denomination — set head-on and flat on a sign, vehicle, uniform, ` +
  `document cover or note renders crisply and legibly (e.g. a cover reading "CLARITY ACT", or a ` +
  `banknote with a large legible "250"); never render loose individual characters with no real ` +
  `word behind them. Anything that would be small, dense, angled, reflected, wrapped, curved or ` +
  `partly hidden — sentences, body copy, fine print, the ring of text around a seal, the ` +
  `inscriptions and engraving on a banknote — is rendered as a soft suggestion of type that ` +
  `reads as real lettering at a glance but is NOT readable up close, not as sharp words. Real ` +
  `seals, crests and badges belonging to a NAMED REFERENCE ENTITY are allowed: render the ` +
  `central emblem sharp and correct and the encircling ring-text as a soft out-of-focus band, ` +
  `not spelled out. Printed currency is allowed, INCLUDING a satirical or non-existent ` +
  `denomination (e.g. a "$250 bill" bearing a face): render the large denomination number and ` +
  `any short, large, head-on lettering legibly, and render the engraving, filigree, ` +
  `treasury/reserve marks, flags and all other dense bank-note inscriptions as soft ` +
  `impressionistic texture — do NOT attempt their tiny lettering; a single plain coin is also ` +
  `fine. When a banknote IS the story’s focal prop, make it the clear hero — large, well-lit ` +
  `and unobstructed, held flat toward the camera, the named person’s portrait as the central ` +
  `engraving, and ONE single consistent denomination (the SAME number, e.g. 250, in the ` +
  `corners and centre — never mixing in a different value such as 50 or 100), every other ` +
  `inscription soft. These permitted titled documents and currency are deliberate props and override the ` +
  `blank-surface rule for non-reference papers, which still applies to all OTHER incidental ` +
  `papers, screens, badges, signs and packaging. STILL BANNED, unconditionally: no invented ` +
  `statistics, percentages, prices, index values or fabricated data figures (a banknote ` +
  `denomination or a short document title is fine; a made-up "+34%" or a free-floating price ` +
  `tag is not); no charts, graphs, tickers, dashboards, infographics, plots, axis labels or any ` +
  `data-visualization overlay; no reproduced watermark, stock-photo mark or source caption. ` +
  `LIMIT & SPELLING: render at most TWO words of legible text in any single sign, title, ` +
  `nameplate or label — if the real name is longer use its shortest 1-2 word form or its ` +
  `symbol, and never spell out three or more words; never repeat or double a word (no "OF ` +
  `OF"); if unsure of a word’s exact spelling, omit it rather than guess, approximate or ` +
  `duplicate it. SEALS SMALL: show any seal, crest or badge small, angled or partly out of ` +
  `frame so its ring of text never fills enough of the image to be read or garbled — the ` +
  `central emblem recognizable, the ring an out-of-focus suggestion; never a large, flat, ` +
  `head-on seal whose ring-text dominates. Render all surfaces clean.\n\n` +
  `PROPS: papers, screens, badges, signs or packaging that are not a named reference entity ` +
  `(other than a permitted titled document or banknote) carry no logo, seal, insignia or ` +
  `text. Every object is ordinary and realistic — no ` +
  `ornamental, jewelled or surreal props.\n\n` +
  `HANDS & POSES — frame people so hands are relaxed, lowered, partly out of frame or not ` +
  `the focal point; avoid close-up, bound, handcuffed, tightly-clasped or intricately-` +
  `gesturing hands. Every visible hand is anatomically correct with five fingers and natural ` +
  `proportions; if a hand cannot be rendered cleanly, keep it out of view or softly out of ` +
  `focus rather than malformed or fused.\n\n` +
  `BACKGROUND PEOPLE — ONLY the named foreground subject(s) are rendered as sharp, detailed ` +
  `faces. Everyone else — crowds, bystanders, press, ranks of officials behind — is kept OUT ` +
  `OF FOCUS, turned away, distant, backlit or in silhouette: a soft, textured mass of ` +
  `motion-blurred figures, NEVER sharp individual background faces. (Small detailed ` +
  `background faces render as melted, distorted glitches, so keep the crowd soft and ` +
  `face-indistinct while the foreground subjects stay crisp.)\n\n` +
  `Shoot it like a real Reuters / AP wire photograph — candid, documentary, natural light, 35mm, ` +
  `shallow depth of field, fine film grain, real texture; not glossy, no CGI sheen. Incidental ` +
  `bystanders are anonymous, no recognizable faces. Wide cinematic 21:9 banner.`;

function composePrompt(headline: string, comp: string, refs: Ref[], described: Described[]): string {
  const lines = refs.map((r, i) => {
    const what =
      r.kind === "person" ? PERSON_REF_LINE : r.kind === "agreement" ? AGREEMENT_REF_LINE : ENTITY_REF_LINE;
    return `  [${ORD[i] ?? `${i + 1}th`} reference] ${r.name} (${r.role}): ${what}.`;
  });

  let body =
    `Using the ${refs.length} reference image(s) provided, create ONE photorealistic editorial ` +
    `news photograph that tells this story: ${headline}.\n\n`;
  if (refs.length) body += "The reference images are, in order:\n" + lines.join("\n") + "\n\n";
  if (described.length) {
    body +=
      "Also depict, rendered naturally from description (generic, no specific real brand " +
      "or logo, no watermark): " +
      described.map((d) => `${d.name} (${d.role})`).join("; ") +
      ".\n\n";
  }
  body += `Compose everything into a single cohesive, believable news scene: ${comp}\n\n` + STATIC_CLAUSES;
  return body;
}

// ── Stage 3: render (gpt-image-2 edits / generations) ───────────────
// `retries` here covers TRANSIENT API failures (network / 5xx / 429) only — the
// outer QC loop re-renders on BAD output, not on failure, so a small transient
// buffer is enough and keeps the worst-case image-call count down.
async function genEdit(prompt: string, refs: Ref[], retries = 2): Promise<Buffer> {
  const key = requireOpenAIKey();
  let last = "";
  for (let a = 0; a <= retries; a++) {
    const form = new FormData();
    form.append("model", IMAGE_MODEL);
    form.append("prompt", prompt);
    form.append("size", RENDER_SIZE);
    form.append("quality", "low");
    form.append("n", "1");
    form.append("moderation", "low");
    refs.forEach((r, i) => {
      const ext = r.mime === "image/png" ? "png" : r.mime === "image/webp" ? "webp" : "jpg";
      // Copy into a fresh Uint8Array<ArrayBuffer> — Buffer's backing buffer is
      // typed ArrayBufferLike and isn't directly assignable to BlobPart.
      form.append("image[]", new Blob([new Uint8Array(r.buf)], { type: r.mime }), `ref${i}.${ext}`);
    });
    try {
      const r = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(300_000),
      });
      if (r.status === 200) {
        const j = (await r.json()) as any;
        return Buffer.from(j.data[0].b64_json, "base64");
      }
      last = `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`;
      if (r.status === 429) {
        await sleep(15_000);
        continue;
      }
    } catch (e: any) {
      last = `request error: ${String(e?.message ?? e).slice(0, 120)}`;
    }
    if (a < retries) await sleep(3_000 * (a + 1));
  }
  throw new Error(last || "gen_edit failed");
}

// Same transient-retry buffer as genEdit — the no-refs / all-described path also
// deserves to survive a 429 / 5xx blip (otherwise one hiccup permanently fails the
// story under MAX_COVER_RUNS=1). Fails fast on a non-retryable status.
async function genGenerate(prompt: string, retries = 2): Promise<Buffer> {
  const key = requireOpenAIKey();
  let last = "";
  for (let a = 0; a <= retries; a++) {
    try {
      const r = await fetch("https://api.openai.com/v1/images/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: IMAGE_MODEL, prompt, n: 1, size: RENDER_SIZE,
          quality: "low", moderation: "low", output_format: "jpeg",
        }),
        signal: AbortSignal.timeout(300_000),
      });
      if (r.status === 200) {
        const j = (await r.json()) as any;
        return Buffer.from(j.data[0].b64_json, "base64");
      }
      last = `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`;
      if (!(r.status === 429 || r.status >= 500)) break; // non-retryable -> surface now
      if (r.status === 429) { await sleep(15_000); continue; }
    } catch (e: any) {
      last = `request error: ${String(e?.message ?? e).slice(0, 120)}`;
    }
    if (a < retries) await sleep(3_000 * (a + 1));
  }
  throw new Error(last || "generations failed");
}

async function render(headline: string, comp: string, refs: Ref[], described: Described[], extra = ""): Promise<Buffer> {
  let cp = composePrompt(headline, comp, refs, described);
  if (extra) cp += "\n\n" + extra;
  return refs.length ? genEdit(cp, refs) : genGenerate(cp);
}

// ── Stage 4: QC (detect garbled text / malformed hands) ─────────────
const QC_PROMPT =
  `Strict QA on an AI-generated news photo. Examine it in two passes, then reply ONLY JSON ` +
  `{"bad": true|false, "reason": "..."}. ` +
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
  `correctly-spelled "TWO HUNDRED FIFTY". ` +
  `PASS 2 HANDS: flag ONLY a prominent, clearly-visible hand that is obviously MALFORMED (fused ` +
  `fingers, a mitten-like blob, extra or missing fingers, wrong finger count, a warped thumb); a ` +
  `tiny, distant or motion-blurred background hand is NOT a defect. ` +
  `Set bad=true only if a pass finds a clear, glaring defect a reader would notice at a glance; ` +
  `otherwise bad=false. Name the pass and what you saw in reason.`;

async function qcInspect(img: Buffer): Promise<{ bad: boolean; reason: string }> {
  const mime = img.length >= 8 && img[0] === 0x89 && img[1] === 0x50 ? "image/png" : "image/jpeg";
  try {
    const txt = await chatCompletion({
      model: VISION_MODEL,
      maxTokens: 80,
      jsonMode: true,
      messages: [{ role: "user", content: [{ type: "text", text: QC_PROMPT }, { type: "image_url", image_url: { url: dataUrl(img, mime) } }] }],
    });
    const j = parseJSON<{ bad?: boolean; reason?: string }>(txt);
    return { bad: !!j.bad, reason: String(j.reason ?? "").slice(0, 60) };
  } catch {
    return { bad: false, reason: "qc-error" }; // fail-OPEN
  }
}

// ── Orchestration ───────────────────────────────────────────────────
/**
 * Generate one grounded cover for a story. `summary` is the story's enriched
 * summary (planner context). Returns image bytes + scene description, or throws
 * if the planner yields nothing usable / the render fails after retries.
 */
export async function generateGroundedCover(headline: string, summary: string): Promise<GroundedCover> {
  const plan = await extract(headline, summary || "");
  const factors = (plan.factors ?? []).slice(0, 6);

  const refs: Ref[] = [];
  const described: Described[] = [];
  const scores: string[] = [];

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
      for await (const cand of resolveCandidates(kind, name, f.ref_query ?? "", f.domain ?? "")) {
        if (cand.conf < ENTITY_MIN_CONF) continue;
        if (tries >= cap) break; // depth cap -> describe
        const img = await download(cand.url);
        if (!img) continue; // dead URL -> next source (no try burned)
        tries++;
        const g = await refGate(img.buf, img.mime, name, kind); // LENIENT; gates db too
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
    }
  }

  if (!refs.length && !described.length) {
    throw new Error("planner produced no usable factors");
  }

  const comp = plan.composition ?? "";
  let data: Buffer | null = null;
  let qc = "";
  let lastReason = "";
  for (let attempt = 0; attempt <= QC_RETRIES; attempt++) {
    let hint = "";
    if (attempt && lastReason) {
      hint =
        "CRITICAL RETRY — the previous render had this specific defect: " + lastReason +
        ". Regenerate the SAME scene, subjects and composition, but FIX EXACTLY that defect — " +
        "spell any flagged word correctly or omit it entirely, and redraw any flagged hand " +
        "cleanly with five natural fingers or move it out of view. Change nothing else.";
    }
    data = await render(headline, comp, refs, described, hint);
    const { bad, reason } = await qcInspect(data);
    if (!bad) {
      qc = `clean@${attempt}`;
      break;
    }
    lastReason = reason;
    qc = `glitch@${attempt}:${reason}`;
  }
  if (!data) throw new Error("render produced no image");

  const mimeType = data.length >= 2 && data[0] === 0x89 && data[1] === 0x50 ? "image/png" : "image/jpeg";
  const trace = `${scores.join(" ")} [qc:${qc}]`;
  return {
    imageBase64: data.toString("base64"),
    mimeType,
    sceneDescription: comp || headline,
    trace,
  };
}
