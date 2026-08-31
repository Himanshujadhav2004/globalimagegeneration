/**
 * planner.ts — turn a dossier into a visual plan.
 *
 * One JSON contract for every subject kind:
 *   factors[]     the concrete things to depict (each becomes a reference hunt)
 *   composition   one sentence describing the single real scene
 *   profile       which look fits (honoured only when the caller said --profile auto)
 *   poster_text   an optional short caption for an overlay
 *
 * The `story` prompt is the validated news prompt, unchanged — story covers must
 * keep rendering exactly as they do today. Every other subject kind gets a
 * prompt written for it, because a property or a type is not an event and asking
 * for "the news photo of Date of birth" produces nonsense.
 */

import { MAX_FACTORS, PLANNER_MODEL } from "./config.js";
import { chatCompletion } from "./openai.js";
import { isProfile, type Profile } from "./art.js";
import { dossierText, type Dossier } from "./geo.js";
import { parseJSON, tidy } from "./util.js";

// ── Plan shape ──────────────────────────────────────────────────────
export const FACTOR_KINDS = [
  "person", "company", "crypto", "government", "place",
  "agreement", "object", "organization", "concept",
] as const;
export type FactorKind = (typeof FACTOR_KINDS)[number];

export interface PlanFactor {
  name: string;
  kind: FactorKind;
  refQuery: string;
  domain: string;
  role: string;
}

export interface Plan {
  factors: PlanFactor[];
  composition: string;
  profile?: Profile;
  posterText: string;
}

// ── Shared prompt blocks ────────────────────────────────────────────
const FACTOR_SPEC =
  `  "factors": an ordered list (1-4, MOST IMPORTANT FIRST) of objects:\n` +
  `     "name": the thing.\n` +
  `     "kind": EXACTLY one of: person | company | crypto | government | place | agreement | ` +
  `object | organization | concept. (Use \`company\` for a business/startup/protocol, \`crypto\` ` +
  `for a cryptocurrency or token, \`government\` for an agency/department/court/central bank, ` +
  `\`place\` for a building/landmark/city/country, \`agreement\` for a treaty/act/bill, \`object\` ` +
  `for a real physical thing, and \`concept\` for anything abstract or invented, which is always ` +
  `built fresh in the scene and NEVER matched to a photograph.)\n` +
  `     "ref_query": the canonical name used to look the thing up — a person's exact full name, ` +
  `an organization's common encyclopedic title, a token's name. Use "" for kind=concept.\n` +
  `     "domain": for kind=company ONLY, its official website domain (e.g. "openai.com"); else "".\n` +
  `     "role": how it physically appears in the single photograph (e.g. "the figure at a lectern", ` +
  `"the worn brass plate on the door"); do NOT place it on a screen, chart, ticker or text display.\n`;

const COMPOSITION_RULES =
  `NEVER through screens, charts, tickers, dashboards, holograms, diagrams, UI, code or ` +
  `infographics, and inventing no statistics, percentages, prices, index values, dates, captions ` +
  `or any fabricated data figures. Physical, ordinary, real-world objects only, lit by real light.`;

const PROFILE_FIELD =
  `  "profile": which look best fits, EXACTLY one of: editorial (a candid news scene of something ` +
  `happening) | portrait (one person or one subject, environmental portrait) | landmark (a real ` +
  `place, architecture or geography) | still-life (a small arrangement of ordinary objects on a ` +
  `surface, for an idea with no single photographable form) | emblem (ONE representative object, ` +
  `centred, museum-object lighting).\n`;

const POSTER_FIELD =
  `  "poster_text": OPTIONAL. ONE short caption phrase (1-4 words, UPPERCASE) capturing the core ` +
  `hook. It is overlaid AFTER rendering, not drawn in the scene. Use "" if nothing crisp fits.\n`;

const JSON_ONLY = `\nOutput ONLY valid JSON.`;

// ── Per-subject prompts ─────────────────────────────────────────────

/** VERBATIM from cover-pipeline.ts — the validated news planner. Do not edit. */
const STORY_PROMPT =
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

const ENTITY_PROMPT =
  `You are art-directing ONE photograph of ONE named ENTITY from a knowledge graph. The entity ` +
  `itself is the unmistakable subject of the frame — this is a portrait of a thing, not a news ` +
  `story about it and not an illustration of its category.\n\n` +
  `RULES:\n` +
  `- The FIRST factor is ALWAYS the entity itself, with its own correct kind and its exact ` +
  `canonical name as ref_query, so a real photo, logo or building can be found for it.\n` +
  `- Add AT MOST 2 further factors, and only ones the dossier states as fact (its city, its ` +
  `parent organization, the product it makes). Never invent an association, a colleague, a ` +
  `competitor or a place that is not in the dossier.\n` +
  `- A person: show the real person. An organization or product: show its real mark, building, ` +
  `sign or the physical work it does. A place: show the place. An abstract entity with no ` +
  `physical form: kind=concept and pick ordinary objects that stand for it.\n` +
  `- The dossier is the ONLY source of fact. Do not add dates, figures, slogans or events.\n\n` +
  `Output ONLY JSON:\n` + FACTOR_SPEC +
  `  "composition": one vivid sentence describing a SINGLE real scene in which this entity is ` +
  `plainly the subject, told through physical things, ${COMPOSITION_RULES}\n` +
  PROFILE_FIELD + POSTER_FIELD + JSON_ONLY;

const TYPE_PROMPT =
  `You are art-directing ONE photograph that stands for a TYPE — a CLASS of things in a knowledge ` +
  `graph (like "City", "Drug", "Nonprofit organization"), not any one member of it.\n\n` +
  `RULES:\n` +
  `- Depict ONE archetypal, GENERIC, unbranded specimen of the class, or a small group of them: ` +
  `the thing a reader would picture if you said the type's name aloud.\n` +
  `- Name NO real company, person, product or place. Every factor is kind=concept with ref_query ` +
  `"" — a type must never be matched to a photograph of one specific real member, which would ` +
  `wrongly imply that member IS the category.\n` +
  `- The type's property list tells you what the class is made of; use it to pick objects that ` +
  `show what instances of this class actually are. Never draw the property list, a schema, a ` +
  `form, a database or a diagram.\n` +
  `- No text, no labels, no signage carrying the type's name.\n\n` +
  `Output ONLY JSON:\n` + FACTOR_SPEC +
  `  "composition": one vivid sentence describing a SINGLE real scene of generic physical objects ` +
  `that reads instantly as this class of thing, ${COMPOSITION_RULES}\n` +
  PROFILE_FIELD + POSTER_FIELD + JSON_ONLY;

const PROPERTY_PROMPT =
  `You are art-directing ONE photograph that stands for a PROPERTY — a single FIELD that entities ` +
  `in a knowledge graph carry (like "Website", "Date of birth", "Funding rounds"). A property is ` +
  `an abstract slot; there is no photograph of one, so it must be built out of ordinary objects ` +
  `that carry the same MEANING.\n\n` +
  `RULES:\n` +
  `- Translate the property's MEANING into 1-3 ordinary, tangible, slightly used objects a person ` +
  `would recognize instantly (a birth date -> a worn paper calendar and a hospital wristband; a ` +
  `website -> a printed business card and a shop-window address plate; funding -> banded cash and ` +
  `a signed cheque).\n` +
  `- NEVER depict a screen, monitor, phone, browser, form, spreadsheet, database, table, chart, ` +
  `code, UI or any digital interface — that is the single most common failure for this subject.\n` +
  `- Every factor is kind=concept with ref_query "": a property is never a real named thing.\n` +
  `- The property's DATA TYPE is a hint about its meaning (Text, Number, Date, Relation, ` +
  `Checkbox, Point), not something to draw literally.\n` +
  `- No lettering that spells the property's name.\n\n` +
  `Output ONLY JSON:\n` + FACTOR_SPEC +
  `  "composition": one vivid sentence describing a SINGLE quiet arrangement of these real objects ` +
  `on one real surface, reading instantly as the property's meaning, ${COMPOSITION_RULES}\n` +
  PROFILE_FIELD + POSTER_FIELD + JSON_ONLY;

const SPACE_PROMPT =
  `You are art-directing ONE photograph that stands for a SPACE — a curated area of a knowledge ` +
  `graph where a person or community collects everything about one subject.\n\n` +
  `RULES:\n` +
  `- Depict the SUBJECT MATTER the space is about (from its description, the types it catalogues ` +
  `and its example entries) — the real-world work, place or craft behind the collection.\n` +
  `- Never depict the software: no screens, apps, databases, graphs, node diagrams, cards or ` +
  `dashboards. A space about medicine looks like medicine, not like a medical app.\n` +
  `- Prefer kind=concept and generic objects. Name a real organization or place ONLY if the ` +
  `space is explicitly and entirely about that one thing.\n` +
  `- No lettering that spells the space's name.\n\n` +
  `Output ONLY JSON:\n` + FACTOR_SPEC +
  `  "composition": one vivid sentence describing a SINGLE real scene that says what this ` +
  `collection is about, told through physical things, ${COMPOSITION_RULES}\n` +
  PROFILE_FIELD + POSTER_FIELD + JSON_ONLY;

const RELATION_PROMPT =
  `You are art-directing ONE photograph of a RELATION — one edge of a knowledge graph, ` +
  `FROM -[relation]-> TO.\n\n` +
  `RULES:\n` +
  `- BOTH endpoints must be present in the one frame as the first two factors, each with its own ` +
  `correct kind and canonical ref_query so real faces and marks can be found.\n` +
  `- The PHYSICAL ARRANGEMENT carries the relation: who holds what, who stands where, what passes ` +
  `between them, what one is built out of. Never draw an arrow, a line, a link, a diagram or any ` +
  `graph visualization — the relation is expressed by staging, not by graphics.\n` +
  `- Add at most ONE further factor, and only if the relation is meaningless without it.\n` +
  `- Invent no event, date, figure or quote that the dossier does not state.\n\n` +
  `Output ONLY JSON:\n` + FACTOR_SPEC +
  `  "composition": one vivid sentence describing a SINGLE real scene where the arrangement of ` +
  `these two subjects makes the relation obvious, ${COMPOSITION_RULES}\n` +
  PROFILE_FIELD + POSTER_FIELD + JSON_ONLY;

const TEXT_PROMPT =
  `You are art-directing ONE photograph from a short free-text brief.\n\n` +
  `RULES:\n` +
  `- Depict only what the brief states or unambiguously implies; invent no extra named people, ` +
  `organizations or events.\n` +
  `- Anything real and named gets its true kind and a canonical ref_query; anything invented, ` +
  `hypothetical or abstract is kind=concept.\n\n` +
  `Output ONLY JSON:\n` + FACTOR_SPEC +
  `  "composition": one vivid sentence describing a SINGLE cohesive real scene, ` +
  `${COMPOSITION_RULES}\n` +
  PROFILE_FIELD + POSTER_FIELD + JSON_ONLY;

export const PROMPTS: Record<string, string> = {
  story: STORY_PROMPT,
  entity: ENTITY_PROMPT,
  type: TYPE_PROMPT,
  property: PROPERTY_PROMPT,
  space: SPACE_PROMPT,
  relation: RELATION_PROMPT,
  text: TEXT_PROMPT,
};

// ── Normalisation ───────────────────────────────────────────────────
const KIND_ALIASES: Record<string, FactorKind> = {
  people: "person", human: "person", individual: "person",
  business: "company", startup: "company", corporation: "company", protocol: "company",
  token: "crypto", cryptocurrency: "crypto", coin: "crypto",
  agency: "government", gov: "government", regulator: "government", court: "government",
  city: "place", country: "place", building: "place", location: "place", landmark: "place",
  treaty: "agreement", act: "agreement", law: "agreement", bill: "agreement",
  org: "organization", nonprofit: "organization", institution: "organization",
  thing: "object", product: "object", item: "object",
  abstract: "concept", idea: "concept", topic: "concept", "": "concept",
};

function normalizeKind(raw: unknown): FactorKind {
  const k = String(raw ?? "").trim().toLowerCase();
  if ((FACTOR_KINDS as readonly string[]).includes(k)) return k as FactorKind;
  return KIND_ALIASES[k] ?? "concept"; // unknown -> built fresh, never mis-matched
}

/** Poster text is an overlay: at most 4 short words, uppercase, no punctuation noise. */
function normalizePoster(raw: unknown): string {
  const words = String(raw ?? "")
    .replace(/["""'`]/g, "")
    .replace(/[^\p{L}\p{N}\s&%$+.-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  return words.join(" ").toUpperCase().slice(0, 40);
}

/**
 * Coerce whatever the model returned into a usable Plan. Never throws on shape:
 * a plan with no factors is legal (everything is then carried by `composition`),
 * and an empty composition falls back to the dossier.
 */
export function normalizePlan(raw: any, dossier: Dossier): Plan {
  const rawFactors = Array.isArray(raw?.factors) ? raw.factors : [];
  const factors: PlanFactor[] = [];

  for (const f of rawFactors) {
    // A model that returns ["Ethereum", "Vitalik"] instead of objects still works.
    const obj = typeof f === "string" ? { name: f } : (f ?? {});
    const name = tidy(obj.name ?? obj.entity ?? "", 120);
    if (!name) continue;
    const kind = normalizeKind(obj.kind);
    factors.push({
      name,
      kind,
      refQuery: kind === "concept" ? "" : tidy(obj.ref_query ?? obj.refQuery ?? name, 120),
      domain: kind === "company" ? tidy(obj.domain ?? "", 80).replace(/^https?:\/\//, "").replace(/\/.*$/, "") : "",
      role: tidy(obj.role ?? "", 160),
    });
    if (factors.length >= MAX_FACTORS) break;
  }

  const composition =
    tidy(raw?.composition ?? "", 900) ||
    tidy(dossier.description, 600) ||
    `a single real scene that stands for ${dossier.name}`;

  const profileRaw = String(raw?.profile ?? "").trim().toLowerCase();
  return {
    factors,
    composition,
    profile: isProfile(profileRaw) ? profileRaw : undefined,
    posterText: normalizePoster(raw?.poster_text ?? raw?.posterText),
  };
}

// ── Entry point ─────────────────────────────────────────────────────
/** Ask the planner for a visual plan for this dossier. */
export async function plan(dossier: Dossier, opts: { model?: string } = {}): Promise<Plan> {
  const system = PROMPTS[dossier.subject] ?? TEXT_PROMPT;
  const user =
    dossier.subject === "story"
      ? `HEADLINE: ${dossier.name}\nCONTEXT: ${dossier.description}`
      : dossierText(dossier);

  const txt = await chatCompletion({
    model: opts.model ?? PLANNER_MODEL,
    maxTokens: 900,
    jsonMode: true,
    timeoutMs: 120_000,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });
  return normalizePlan(parseJSON<any>(txt), dossier);
}
