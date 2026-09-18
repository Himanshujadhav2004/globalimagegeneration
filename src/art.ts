/**
 * art.ts — art direction: render profiles and prompt assembly.
 *
 * The news pipeline had exactly one look (a wire photograph of an event). Most
 * knowledge-graph subjects are not events, so the rules are split into blocks
 * and recombined per PROFILE:
 *
 *   editorial   an event/scene, Reuters-style       stories, relations, orgs in action
 *   portrait    one subject, environmental portrait people, single named entities
 *   landmark    architecture / geography            places, spaces
 *   still-life  arranged real objects on a surface  properties, abstract concepts
 *   emblem      one object, museum-object lighting  types, icons, marks
 *
 * The `editorial` profile reproduces the validated news prompt verbatim — plus
 * CROP_SAFETY, the one deliberate addition, which every profile carries because
 * every rendered banner is re-cropped by the UI.
 */

import { ordinal } from "./util.js";

// ── Frame ───────────────────────────────────────────────────────────
/**
 * Every image is the same shape: the editorial cover banner (see RENDER_SIZE).
 * This clause closes the look sentence so the composition is planned for that
 * frame rather than cropped into it afterwards.
 */
const FRAME_CLAUSE = "Wide cinematic 21:9 banner.";

/**
 * One render, four views. The UI re-crops this single 1536x640 banner with
 * `object-cover`, so the geometry below is fixed and worth stating exactly:
 *
 *   gallery  aspect-2/1        -> 1280x640 centred, losing 128px (8%) each side
 *   list     64x64  rounded-lg  ┐
 *   explore  60x60  rounded-lg  ├ 1:1 -> the centre 640x640, losing 448px (29%) each side
 *   pill     16x16  rounded-full┘  and the pill rounds that square into a circle
 *
 * So the composition has to work at three scales at once: the full banner, the
 * centre square, and that square as a fingernail-sized circle. Everything that
 * identifies the subject must live in the middle 40% of the width; the outer
 * 30% at each side is atmosphere the crop is free to throw away.
 */
export const CROP_SAFETY =
  `CROP-SAFE COMPOSITION — CRITICAL. This one wide banner is ALSO shown cropped to a centred ` +
  `SQUARE and to a small round avatar, so compose it to survive all three at once. Treat the ` +
  `CENTRAL SQUARE — the middle 40% of the width, full height — as the real picture: the single ` +
  `most identifying element (the subject’s face, the real mark, the hero object) sits INSIDE ` +
  `that square, centred, large and unobstructed, with the frame balanced about it rather than ` +
  `weighted off to one side. Compose it so it still reads when that square is reduced to a ` +
  `fingernail-sized circle: a clear, uncluttered silhouette, strong tonal and colour separation ` +
  `from whatever is behind it, and no busy pattern, crossing limbs, poles or overlapping figures ` +
  `through the centre. Because the small view is a CIRCLE, nothing essential sits in that ` +
  `square’s corners, and there is calm headroom above and below the subject so the square crop ` +
  `never slices its head or its base. The outer 30% at each side is context ONLY — falling ` +
  `light, room, landscape, an out-of-focus crowd — and must be disposable: no part of the ` +
  `subject, no legible sign, mark or title, and no second point of interest lives out there, and ` +
  `nothing important is cut by the left or right edge.`;

// ── Profiles ────────────────────────────────────────────────────────
export type Profile = "editorial" | "portrait" | "landmark" | "still-life" | "emblem";

export const PROFILES: Profile[] = ["editorial", "portrait", "landmark", "still-life", "emblem"];
export const isProfile = (s: string): s is Profile => (PROFILES as string[]).includes(s);

// ── Reference-image instruction lines (per factor kind) ─────────────
export const PERSON_REF_LINE = "a real photo of this person — preserve their exact face and identity";

export const AGREEMENT_REF_LINE =
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

export const ENTITY_REF_LINE =
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

/** The reference line for a factor of this kind. */
export function refLineFor(kind: string): string {
  if (kind === "person") return PERSON_REF_LINE;
  if (kind === "agreement") return AGREEMENT_REF_LINE;
  return ENTITY_REF_LINE;
}

// ── Shared rule blocks ──────────────────────────────────────────────
const SINGLE_FRAME =
  `STRICT — ONE single unified photograph of ONE real physical place, NOT a collage, montage, ` +
  `diptych, split-screen, grid or inset. Every element coexists naturally in the same frame.`;

const NO_SYNTHETIC =
  `NO synthetic / sci-fi elements: no holograms, holographic overlays, glowing or translucent ` +
  `screens, floating icons, network or node graphics, neon glow, digital-particle effects, HUD ` +
  `or futuristic interface, or data-visualization overlays. Nothing glows or floats; render only ` +
  `real physical objects under real, available light.`;

const TEXT_RULES =
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
  `head-on seal whose ring-text dominates. Render all surfaces clean.`;

const PROPS =
  `PROPS: papers, screens, badges, signs or packaging that are not a named reference entity ` +
  `(other than a permitted titled document or banknote) carry no logo, seal, insignia or ` +
  `text. Every object is ordinary and realistic — no ` +
  `ornamental, jewelled or surreal props.`;

const HANDS =
  `HANDS & POSES — frame people so hands are relaxed, lowered, partly out of frame or not ` +
  `the focal point; avoid close-up, bound, handcuffed, tightly-clasped or intricately-` +
  `gesturing hands. Every visible hand is anatomically correct with five fingers and natural ` +
  `proportions; if a hand cannot be rendered cleanly, keep it out of view or softly out of ` +
  `focus rather than malformed or fused.`;

const BACKGROUND_PEOPLE =
  `BACKGROUND PEOPLE — ONLY the named foreground subject(s) are rendered as sharp, detailed ` +
  `faces. Everyone else — crowds, bystanders, press, ranks of officials behind — is kept OUT ` +
  `OF FOCUS, turned away, distant, backlit or in silhouette: a soft, textured mass of ` +
  `motion-blurred figures, NEVER sharp individual background faces. (Small detailed ` +
  `background faces render as melted, distorted glitches, so keep the crowd soft and ` +
  `face-indistinct while the foreground subjects stay crisp.)`;

const NO_PEOPLE =
  `NO PEOPLE — the frame contains no human faces at all. If a hand must appear to hold or ` +
  `place an object, show only fingers, in focus, anatomically correct with five fingers; ` +
  `otherwise keep people entirely out of the picture.`;

const DISTANT_PEOPLE =
  `PEOPLE — any person in frame is incidental and distant: out of focus, turned away, in ` +
  `silhouette or motion-blurred, never a sharp recognizable face. (Small detailed background ` +
  `faces render as melted glitches.)`;

/**
 * No photograph of this person could be verified, so any face we drew would be
 * an invented stranger wearing their name. Photograph their work instead.
 */
function unverifiedClause(names: string[]): string {
  return (
    `IDENTITY — CRITICAL. No verified photograph exists for: ${names.join(", ")}. They MUST NOT ` +
    `appear in the image. Do not invent a face for them, do not substitute a look-alike, model or ` +
    `stand-in, and do not show ANY sharp, identifiable human face anywhere in the frame — an ` +
    `invented face captioned with a real person's name is a fabrication. Ignore any part of the ` +
    `scene description that places them in the picture, and instead photograph the place, the work ` +
    `and the objects around them with the person absent: their desk, their instruments, their ` +
    `books, their workshop, their setting. An empty chair, a workspace caught mid-use, or the view ` +
    `across their desk is exactly right. If a human presence is unavoidable it must be distant, ` +
    `turned away, silhouetted or cropped so no face is readable.`
  );
}

// ── Per-profile look + lead-in sentences ────────────────────────────
interface ProfileSpec {
  /** "create ONE photorealistic … that <lead> …" */
  lead: (subject: string) => string;
  /** The sentence introducing the planner's composition. */
  composeLead: string;
  /** Camera / lighting clause; the frame clause is appended to it. */
  look: string;
  /** Rule blocks between PROPS and the look clause. */
  people: "cast" | "none" | "distant";
  /** QC should look for malformed hands only where people are expected. */
  expectsPeople: boolean;
}

const SPECS: Record<Profile, ProfileSpec> = {
  editorial: {
    lead: (s) => `create ONE photorealistic editorial news photograph that tells this story: ${s}.`,
    composeLead: "Compose everything into a single cohesive, believable news scene:",
    look:
      `Shoot it like a real Reuters / AP wire photograph — candid, documentary, natural light, 35mm, ` +
      `shallow depth of field, fine film grain, real texture; not glossy, no CGI sheen. Incidental ` +
      `bystanders are anonymous, no recognizable faces.`,
    people: "cast",
    expectsPeople: true,
  },
  portrait: {
    lead: (s) =>
      `create ONE photorealistic environmental PORTRAIT whose single unmistakable subject is: ${s}.`,
    composeLead:
      "The subject fills the frame and everything else is context that explains who or what they are:",
    look:
      `Shoot it like a magazine environmental portrait — one subject, eye-level, 85mm, natural ` +
      `available light, shallow depth of field so the background reads as place without competing, ` +
      `fine film grain, real skin and fabric texture; not glossy, no CGI sheen, no studio backdrop ` +
      `and no retouched beauty lighting. The subject is calm and un-posed, looking at or just past ` +
      `the camera.`,
    people: "cast",
    expectsPeople: true,
  },
  landmark: {
    lead: (s) => `create ONE photorealistic photograph of this real place: ${s}.`,
    composeLead: "Frame the place so its character and scale are immediately legible:",
    look:
      `Shoot it like an architectural or geographic documentary photograph — 24-35mm, straight ` +
      `verticals, overcast or low golden-hour daylight, deep depth of field, fine film grain, real ` +
      `weathering and material texture; not a render, not glossy, no CGI sheen, no drone-gloss HDR.`,
    people: "distant",
    expectsPeople: false,
  },
  "still-life": {
    lead: (s) =>
      `create ONE photorealistic STILL-LIFE photograph of real, ordinary physical objects that ` +
      `stand for this idea: ${s}.`,
    composeLead:
      "Arrange the objects on one real surface so the idea reads at a glance, with no words needed:",
    look:
      `Shoot it like a documentary still life — a small deliberate arrangement of used, ordinary ` +
      `objects on one real surface (worn wood, paper, linen, stone or steel), soft directional ` +
      `window light from one side, honest shadows, 50mm, shallow-to-medium depth of field, fine ` +
      `film grain, real material texture; not a stock photo, not glossy product lighting, no CGI ` +
      `sheen, nothing floating or perfectly new.`,
    people: "none",
    expectsPeople: false,
  },
  emblem: {
    lead: (s) =>
      `create ONE photorealistic photograph of a SINGLE representative real object that stands ` +
      `for: ${s}.`,
    composeLead: "One object, centred and isolated, photographed as a museum would photograph it:",
    look:
      `Shoot it like a museum object photograph — one object centred on a plain seamless surface ` +
      `in a neutral tone, soft broad directional light, one honest contact shadow, 100mm, the whole ` +
      `object sharp, fine film grain, real material texture; a real physical thing on a real ` +
      `surface — not an icon, not a cut-out, not a 3D render, no glow, no gradient background.`,
    people: "none",
    expectsPeople: false,
  },
};

export const expectsPeople = (profile: Profile): boolean => SPECS[profile].expectsPeople;

/** Default profile for a subject kind before the planner gets a say. */
export function defaultProfile(subjectKind: string, refKind: string): Profile {
  if (subjectKind === "story" || subjectKind === "relation") return "editorial";
  if (subjectKind === "property") return "still-life";
  if (subjectKind === "type") return "emblem";
  if (subjectKind === "space") return "still-life";
  if (refKind === "person") return "portrait";
  if (refKind === "place") return "landmark";
  if (refKind === "concept") return "still-life";
  return "editorial";
}

// ── Prompt assembly ─────────────────────────────────────────────────
export interface PromptRef {
  name: string;
  role: string;
  kind: string;
}

export interface PromptDescribed {
  name: string;
  role: string;
}

export interface ComposeInput {
  /** Headline, entity name or whatever the image is "of". */
  subject: string;
  /** The planner's one-sentence scene. */
  composition: string;
  refs: PromptRef[];
  described: PromptDescribed[];
  profile: Profile;
  /** People with no verified likeness — they must stay out of the frame. */
  unverified?: string[];
  /** Appended verbatim — the QC retry hint. */
  extra?: string;
}

/**
 * Build the full image prompt. For the `editorial` profile this is
 * byte-identical to the news pipeline's prompt, so story covers are unaffected.
 */
export function composePrompt(input: ComposeInput): string {
  const spec = SPECS[input.profile];
  const { refs, described } = input;

  let body =
    `Using the ${refs.length} reference image(s) provided, ` + spec.lead(input.subject) + "\n\n";

  if (refs.length) {
    const lines = refs.map(
      (r, i) => `  [${ordinal(i)} reference] ${r.name} (${r.role}): ${refLineFor(r.kind)}.`,
    );
    body += "The reference images are, in order:\n" + lines.join("\n") + "\n\n";
  }
  if (described.length) {
    body +=
      "Also depict, rendered naturally from description (generic, no specific real brand " +
      "or logo, no watermark): " +
      described.map((d) => (d.role ? `${d.name} (${d.role})` : d.name)).join("; ") +
      ".\n\n";
  }

  const unverified = input.unverified ?? [];
  const peopleBlocks = unverified.length
    ? [NO_PEOPLE, unverifiedClause(unverified)]
    : spec.people === "cast" ? [HANDS, BACKGROUND_PEOPLE]
    : spec.people === "none" ? [NO_PEOPLE]
    : [DISTANT_PEOPLE];

  const clauses = [
    SINGLE_FRAME,
    NO_SYNTHETIC,
    TEXT_RULES,
    PROPS,
    ...peopleBlocks,
    `${spec.look} ${FRAME_CLAUSE}`,
    CROP_SAFETY,
  ].join("\n\n");

  body += `${spec.composeLead} ${input.composition}\n\n` + clauses;
  if (input.extra) body += "\n\n" + input.extra;
  return body;
}

/** The defect-feedback block fed back into a re-render after a failed QC pass. */
export function retryHint(defect: string): string {
  return (
    "CRITICAL RETRY — the previous render had this specific defect: " + defect +
    ". Regenerate the SAME scene, subjects and composition, but FIX EXACTLY that defect — " +
    "spell any flagged word correctly or omit it entirely, and redraw any flagged hand " +
    "cleanly with five natural fingers or move it out of view. If the defect is about the " +
    "crop or the centre, keep the same scene and simply re-frame it: move the camera so the " +
    "subject sits square in the middle 40% of the width, whole and unobstructed, and let the " +
    "outer thirds fall away into context. Change nothing else."
  );
}
