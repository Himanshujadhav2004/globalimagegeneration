/**
 * geo.ts — the knowledge-graph half of the skill.
 *
 * Turns "what should I draw?" into a DOSSIER: a compact, factual brief the
 * planner can reason over, plus the subject's OWN images if the graph has any.
 *
 * Subjects it can resolve (all of them by id OR by name):
 *   entity    — a thing in the graph (Ethereum, Vitalik Buterin, Berlin)
 *   type      — a class of things (City, Drug, Nonprofit organization)
 *   property  — a field on a type (Website, Date of birth, Funding rounds)
 *   space     — a curated topic area / community
 *   relation  — one edge: FROM –[type]→ TO
 *
 * Everything here is read-only and unauthenticated; the only endpoint is the
 * Geo GraphQL API (GEO_GRAPHQL_URL).
 */

import { GEO_GRAPHQL, USER_AGENT } from "./config.js";
import { IPFS_GATEWAYS } from "./config.js";
import { normalizeGeoId, tidy, uniqueBy } from "./util.js";

// ── Well-known ids (verified against api-testnet.geobrowser.io) ─────
export const SYS = {
  NAME: "a126ca530c8e48d5b88882c734c38935",
  DESCRIPTION: "9b1f76ff9711404c861e59dc3fa7d037",
  AVATAR: "1155befffad549b7a2e0da4777b8792c",
  COVER: "34f535072e6b42c5a84443981a77cfa2",
  IPFS_URL: "8a743832c0944a62b6650c3cc2f9c7bc",
  TYPES_REL: "8f151ba4de204e3c9cb499ddf96f48f1",
  PROPERTIES_REL: "01412f8381894ab1836565c7fd358cc1",
  BLOCKS_REL: "beaba5cba67741a8b35377030613fc70",
  TYPE_TYPE: "e7d737c536764c609fa16aa64a8c90ad",
  PERSON_TYPE: "7ed45f2bc48b419e8e4664d5ff680b0d",
} as const;

/** Relations that describe the UI or the schema, never the subject itself. */
const NOISE_RELATIONS = new Set<string>([
  SYS.BLOCKS_REL, SYS.TYPES_REL, SYS.AVATAR, SYS.COVER, SYS.PROPERTIES_REL,
]);
/** Entity types that exist to lay out a page, not to describe the world. */
const BLOCK_TYPES = /^(text block|data block|image|space|block|query|view)$/i;
/** Values already surfaced as name/description — don't repeat them as facts. */
const NOISE_VALUES = new Set<string>([SYS.NAME, SYS.DESCRIPTION]);

// ── Subject / dossier types ─────────────────────────────────────────
export type SubjectKind = "entity" | "type" | "property" | "space" | "relation" | "story" | "text";

/** Ref-chain kinds — what KIND of picture the entity needs (see refs.ts). */
export type RefKind =
  | "person" | "company" | "crypto" | "government" | "place"
  | "agreement" | "object" | "organization" | "concept";

export interface SubjectRef {
  kind: SubjectKind;
  /** Geo id (32-hex or dashed UUID) or a name to search for. */
  ref?: string;
  spaceId?: string;
  /** story/text subjects carry their copy directly. */
  headline?: string;
  summary?: string;
  text?: string;
}

export interface Dossier {
  subject: SubjectKind;
  id?: string;
  name: string;
  description: string;
  /** Geo types this subject is an instance of (entity subjects). */
  typeNames: string[];
  /** "Website: https://ethereum.org" — scalar values worth knowing. */
  facts: string[];
  /** "Blockchain (Related topics)" — named neighbours in the graph. */
  related: string[];
  /**
   * Images the graph already holds, per named entity — one entry for most
   * subjects, two for a relation (both endpoints). Each entry lists the same
   * CID through every configured gateway, best first.
   */
  ownImages: Array<{ name: string; urls: string[] }>;
  /** How to hunt for a reference photo of this subject. */
  refKind: RefKind;
  spaceId?: string;
  /** Extra kind-specific lines (property data type, relation endpoints, …). */
  extra: string[];
}

// ── GraphQL transport ───────────────────────────────────────────────
export class GeoError extends Error {}

/** POST one query. Returns `data`, or throws GeoError with the first message. */
export async function gql<T = any>(
  query: string, variables: Record<string, unknown> = {}, timeoutMs = 30_000,
): Promise<T> {
  let r: Response;
  try {
    r = await fetch(GEO_GRAPHQL(), {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e: any) {
    throw new GeoError(`geo api unreachable: ${String(e?.message ?? e).slice(0, 120)}`);
  }
  if (!r.ok) throw new GeoError(`geo api HTTP ${r.status}`);

  let j: any;
  try {
    j = await r.json();
  } catch {
    throw new GeoError("geo api returned non-JSON");
  }
  if (Array.isArray(j?.errors) && j.errors.length) {
    throw new GeoError(`geo api error: ${tidy(j.errors[0]?.message, 160)}`);
  }
  if (!j || typeof j.data !== "object" || j.data === null) throw new GeoError("geo api returned no data");
  return j.data as T;
}

// ── Kind inference (Geo type names -> ref-chain kind) ───────────────
const KIND_RULES: Array<[RegExp, RefKind]> = [
  [/\b(person|human|people|author|founder|politician|athlete|player|artist|musician|actor|journalist|scientist|researcher|executive|ceo)\b/i, "person"],
  [/\b(token|cryptocurrency|crypto ?asset|coin|stablecoin|memecoin)\b/i, "crypto"],
  [/\b(government|agency|regulator|regulatory|ministry|department|bureau|commission|court|central bank|parliament|military)\b/i, "government"],
  [/\b(city|country|region|state|place|location|building|landmark|venue|stadium|address|territory|continent|planet)\b/i, "place"],
  // Events before agreements: a conference whose blurb happens to mention
  // "policy" is not a treaty. Their best reference is branding, so they follow
  // the organization chain (logo first).
  [/\b(event|conference|convention|summit|festival|expo|exhibition|hackathon|symposium|congress)\b/i, "organization"],
  [/\b(law|act|bill|treaty|agreement|regulation|statute|policy|accord|pact|licen[cs]e)\b/i, "agreement"],
  [/\b(company|project|protocol|startup|business|brand|corporation|exchange|nonprofit|dao|institution|university|school|team|club|publisher|studio|lab)\b/i, "company"],
  [/\b(organization|organisation|association|foundation|union|party|group|network)\b/i, "organization"],
  [/\b(product|device|vehicle|drug|medication|book|film|movie|album|song|artwork|software|tool|model|dataset|machine|equipment|food|plant|animal|species|gene|protein|muscle)\b/i, "object"],
  [/\b(topic|concept|idea|category|tag|skill|field|discipline|theme|goal|value|claim|method|process|role)\b/i, "concept"],
];

/**
 * Pick the ref-chain kind from the subject's Geo types (then its name and
 * description as a weak fallback). Unknown things become `object`: the
 * Wikidata/Commons chain gets a shot and the vision gate throws out a wrong hit.
 */
export function inferRefKind(typeNames: string[], name = "", description = ""): RefKind {
  for (const t of typeNames) {
    for (const [re, kind] of KIND_RULES) if (re.test(t)) return kind;
  }
  const blob = `${name} ${description}`;
  for (const [re, kind] of KIND_RULES) if (re.test(blob)) return kind;
  return "object";
}

// ── IPFS helpers ────────────────────────────────────────────────────
/** `ipfs://CID` (or a bare CID) -> one https URL per configured gateway. */
export function ipfsUrls(ref: string): string[] {
  const s = (ref ?? "").trim();
  if (!s) return [];
  if (/^https?:\/\//i.test(s)) return [s];
  const cid = s.replace(/^ipfs:\/\//i, "").replace(/^\/?ipfs\//i, "").replace(/^\/+/, "");
  if (!cid) return [];
  return IPFS_GATEWAYS().map((g) => g + cid);
}

// ── Queries ─────────────────────────────────────────────────────────
const ENTITY_FIELDS = `
  id name description spaceIds
  types(first:8){ id name }
  valuesList(first:60){
    propertyId text boolean decimal integer float date datetime unit
    property{ name dataTypeName renderableTypeName }
  }
  relationsList(first:80){ typeId type{ name } toEntity{ id name } }
`;

const Q_ENTITY = `query($id:UUID!){ entity(id:$id){ ${ENTITY_FIELDS} } }`;

const Q_SEARCH = `query($q:String,$space:UUID,$first:Int){
  search(query:$q, spaceId:$space, first:$first){
    id name description spaceIds types(first:6){ id name }
  }
}`;

const Q_TYPES_BY_NAME = `query($q:String,$space:UUID){
  typesList(first:8, spaceId:$space, filter:{name:{includesInsensitive:$q}}){
    id name description
  }
}`;

const Q_PROPERTY = `query($id:UUID){
  property(id:$id){ id name description dataTypeName renderableTypeName format isType }
}`;

const Q_PROPS_BY_NAME = `query($q:String,$space:UUID){
  properties(first:8, spaceId:$space, filter:{name:{includesInsensitive:$q}}){
    id name description dataTypeName renderableTypeName format isType
  }
}`;

const Q_SPACE = `query($id:UUID!){
  space(id:$id){ id type address page{ id name description } }
}`;

const Q_RELATION = `query($id:UUID!){
  relation(id:$id){
    id typeId spaceId verified
    type{ name description }
    fromEntity{ id name description types(first:5){ id name } }
    toEntity{ id name description types(first:5){ id name } }
  }
}`;

// ── Value / relation rendering ──────────────────────────────────────
interface RawValue {
  propertyId?: string;
  text?: string | null;
  boolean?: boolean | null;
  decimal?: string | number | null;
  integer?: string | number | null;
  float?: number | null;
  date?: string | null;
  datetime?: string | null;
  unit?: string | null;
  property?: { name?: string | null; dataTypeName?: string | null; renderableTypeName?: string | null } | null;
}

/** First non-empty scalar on a Value row, as display text. */
function scalarOf(v: RawValue): string {
  for (const k of ["text", "date", "datetime", "integer", "decimal", "float"] as const) {
    const raw = v[k];
    if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
      return String(raw).trim() + (v.unit ? ` ${v.unit}` : "");
    }
  }
  if (typeof v.boolean === "boolean") return v.boolean ? "yes" : "no";
  return "";
}

function factsFrom(values: RawValue[]): string[] {
  const out: string[] = [];
  const perLabel = new Map<string, number>();
  for (const v of values ?? []) {
    if (v.propertyId && NOISE_VALUES.has(v.propertyId)) continue;
    const label = tidy(v.property?.name ?? "", 60);
    const val = tidy(scalarOf(v), 120);
    if (!label || !val) continue;
    // Multi-valued properties are real (two founders, three tags) but a row of
    // near-identical social URLs is noise — keep at most two per label.
    const key = label.toLowerCase();
    const seen = perLabel.get(key) ?? 0;
    if (seen >= 2) continue;
    perLabel.set(key, seen + 1);
    out.push(`${label}: ${val}`);
  }
  return uniqueBy(out, (s) => s.toLowerCase()).slice(0, 18);
}

interface RawRelation {
  typeId?: string;
  type?: { name?: string | null } | null;
  toEntity?: { id?: string | null; name?: string | null } | null;
}

function relatedFrom(relations: RawRelation[]): string[] {
  const out: string[] = [];
  for (const r of relations ?? []) {
    if (r.typeId && NOISE_RELATIONS.has(r.typeId)) continue;
    const to = tidy(r.toEntity?.name ?? "", 70);
    if (!to) continue; // unnamed block/child entity — nothing to say about it
    const via = tidy(r.type?.name ?? "", 40);
    out.push(via ? `${to} (${via})` : to);
  }
  return uniqueBy(out, (s) => s.toLowerCase()).slice(0, 14);
}

/** Avatar first, then Cover — an avatar is tighter and survives a re-crop better. */
function ownImagesFrom(values: RawValue[], relations: any[]): string[] {
  const urls: string[] = [];
  for (const wanted of [SYS.AVATAR, SYS.COVER]) {
    for (const r of relations ?? []) {
      if (r?.typeId !== wanted) continue;
      for (const v of r?.toEntity?.valuesList ?? []) {
        if (v?.propertyId === SYS.IPFS_URL && v?.text) urls.push(...ipfsUrls(String(v.text)));
      }
    }
  }
  // Some spaces store the image as a plain URL value on the entity itself.
  for (const v of values ?? []) {
    const isImage = (v.property?.renderableTypeName ?? "").toLowerCase() === "image";
    if (isImage && v.text) urls.push(...ipfsUrls(String(v.text)));
  }
  return uniqueBy(urls, (u) => u).slice(0, 8);
}

/** Second hop: fetch the IPFS URL held by each Avatar/Cover target entity. */
const Q_OWN_IMAGES = `query($id:UUID!){
  entity(id:$id){
    relationsList(first:12, filter:{typeId:{in:["${SYS.AVATAR}","${SYS.COVER}"]}}){
      typeId
      toEntity{ id valuesList(first:6, filter:{propertyId:{is:"${SYS.IPFS_URL}"}}){ propertyId text } }
    }
  }
}`;

/** Gateway URLs for an entity's own Avatar/Cover. Never throws — [] on failure. */
export async function ownImageUrls(entityId: string): Promise<string[]> {
  const id = normalizeGeoId(entityId);
  if (!id) return [];
  try {
    const d = await gql<{ entity: { relationsList: any[] } | null }>(Q_OWN_IMAGES, { id });
    return ownImagesFrom([], d.entity?.relationsList ?? []);
  } catch {
    return [];
  }
}

// ── Subject resolution ──────────────────────────────────────────────
const dedupeTypes = (types: any[]): string[] =>
  uniqueBy((types ?? []).map((t) => tidy(t?.name ?? "", 60)).filter(Boolean), (s) => s.toLowerCase());

/**
 * Find an entity by id, or by name via `search`.
 * Name matches prefer an exact (case-insensitive) hit, then one that has a
 * description, then the first result — the same order a human would pick.
 */
export async function findEntity(ref: string, spaceId?: string): Promise<any | null> {
  const id = normalizeGeoId(ref);
  if (id) {
    const d = await gql<{ entity: any }>(Q_ENTITY, { id });
    return d.entity ?? null;
  }
  const name = (ref ?? "").trim();
  if (!name) return null;

  const d = await gql<{ search: any[] }>(Q_SEARCH, {
    q: name, space: normalizeGeoId(spaceId ?? "") ?? null, first: 8,
  });
  const hits = d.search ?? [];
  if (!hits.length) return null;

  const lower = name.toLowerCase();
  const exact = hits.filter((h) => String(h?.name ?? "").toLowerCase() === lower);
  const pool = exact.length ? exact : hits;
  const described = pool.filter((h) => tidy(h?.description ?? "").length > 0);
  const chosen = (described.length ? described : pool)[0];

  // search() returns a summary — re-read the full row so facts/relations exist.
  const full = await gql<{ entity: any }>(Q_ENTITY, { id: chosen.id });
  return full.entity ?? chosen;
}

async function entityDossier(ref: string, spaceId: string | undefined, subject: SubjectKind): Promise<Dossier> {
  const e = await findEntity(ref, spaceId);
  if (!e) throw new GeoError(`no ${subject} found for "${tidy(ref, 60)}"`);

  const typeNames = dedupeTypes(e.types);
  const name = tidy(e.name ?? "", 120) || tidy(ref, 120);
  const description = tidy(e.description ?? "", 600);
  return {
    subject,
    id: e.id,
    name,
    description,
    typeNames,
    facts: factsFrom(e.valuesList ?? []),
    related: relatedFrom(e.relationsList ?? []),
    ownImages: [{ name, urls: await ownImageUrls(e.id) }],
    refKind: inferRefKind(typeNames, name, description),
    spaceId: normalizeGeoId(spaceId ?? "") ?? (e.spaceIds ?? [])[0],
    extra: [],
  };
}

async function typeDossier(ref: string, spaceId?: string): Promise<Dossier> {
  const id = normalizeGeoId(ref);
  if (!id) {
    // Name lookup goes through typesList so "City" resolves to the CLASS, not
    // to some city that happens to be called City.
    const d = await gql<{ typesList: any[] }>(Q_TYPES_BY_NAME, {
      q: (ref ?? "").trim(), space: normalizeGeoId(spaceId ?? "") ?? null,
    });
    const hits = d.typesList ?? [];
    const lower = (ref ?? "").trim().toLowerCase();
    const exact = hits.find((h) => String(h?.name ?? "").toLowerCase() === lower);
    const chosen = exact ?? hits[0];
    if (!chosen) throw new GeoError(`no type found for "${tidy(ref, 60)}"`);
    return typeDossier(chosen.id, spaceId);
  }

  const dossier = await entityDossier(id, spaceId, "type");
  // A type's `Properties` relations are its schema — the most telling fact
  // about a class, and dropped by the generic relation filter.
  const d = await gql<{ entity: any }>(
    `query($id:UUID!){ entity(id:$id){ relationsList(first:40, filter:{typeId:{is:"${SYS.PROPERTIES_REL}"}}){ toEntity{ name } } } }`,
    { id },
  );
  const props = uniqueBy(
    (d.entity?.relationsList ?? []).map((r: any) => tidy(r?.toEntity?.name ?? "", 50)).filter(Boolean),
    (s: string) => s.toLowerCase(),
  ).slice(0, 16);
  if (props.length) dossier.extra.push(`PROPERTIES OF THIS TYPE: ${props.join(", ")}`);
  dossier.refKind = "concept"; // a class is abstract: build it, never photo-match it
  return dossier;
}

async function propertyDossier(ref: string, spaceId?: string): Promise<Dossier> {
  const id = normalizeGeoId(ref);
  let info: any = null;

  if (id) {
    info = (await gql<{ property: any }>(Q_PROPERTY, { id })).property;
  } else {
    const d = await gql<{ properties: any[] }>(Q_PROPS_BY_NAME, {
      q: (ref ?? "").trim(), space: normalizeGeoId(spaceId ?? "") ?? null,
    });
    const hits = d.properties ?? [];
    const lower = (ref ?? "").trim().toLowerCase();
    info = hits.find((h) => String(h?.name ?? "").toLowerCase() === lower) ?? hits[0] ?? null;
  }
  if (!info) throw new GeoError(`no property found for "${tidy(ref, 60)}"`);

  const extra = [
    `DATA TYPE: ${tidy(info.dataTypeName ?? "unknown", 40)}`,
    info.renderableTypeName ? `RENDERED AS: ${tidy(info.renderableTypeName, 40)}` : "",
    info.format ? `FORMAT: ${tidy(info.format, 40)}` : "",
    info.isType ? "This property is itself used as a type." : "",
  ].filter(Boolean);

  return {
    subject: "property",
    id: info.id,
    name: tidy(info.name ?? "", 120) || tidy(ref, 120),
    description: tidy(info.description ?? "", 600),
    typeNames: ["Property"],
    facts: [],
    related: [],
    ownImages: info.id ? [{ name: tidy(info.name ?? "", 120), urls: await ownImageUrls(info.id) }] : [],
    refKind: "concept", // a field in a schema has no photograph — always built
    spaceId: normalizeGeoId(spaceId ?? "") ?? undefined,
    extra,
  };
}

/** What a space is ABOUT: sample its contents, drop page-layout blocks, count types. */
async function spaceContents(id: string): Promise<{ entities: string[]; types: string[] }> {
  try {
    // Deliberately small: `entities(spaceId:…)` costs the API about a second
    // per row and errors outright past ~30, so this is a taste of the space,
    // not an inventory.
    const d = await gql<{ entities: any[] }>(
      `query($id:UUID){ entities(spaceId:$id, first:15){ name types(first:4){ name } } }`, { id }, 25_000,
    );
    const names: string[] = [];
    const counts = new Map<string, number>();
    for (const e of d.entities ?? []) {
      const types = dedupeTypes(e?.types).filter((t) => !BLOCK_TYPES.test(t));
      if (!types.length) continue; // untyped or pure layout block
      const n = tidy(e?.name ?? "", 60);
      if (n) names.push(n);
      for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const types = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
    return { entities: uniqueBy(names, (s) => s.toLowerCase()).slice(0, 12), types: types.slice(0, 10) };
  } catch {
    return { entities: [], types: [] }; // a space we can't sample is still renderable
  }
}

async function spaceDossier(ref: string, spaceIdHint?: string): Promise<Dossier> {
  const id = normalizeGeoId(ref) ?? normalizeGeoId(spaceIdHint ?? "");
  if (!id) throw new GeoError(`a space needs its id (32-hex or UUID); got "${tidy(ref, 60)}"`);

  const d = await gql<{ space: any }>(Q_SPACE, { id });
  const space = d.space;
  if (!space) throw new GeoError(`no space found for ${id}`);

  // The space's "page" entity carries its human name and description. Spaces
  // created by an import often have none — fall back to the system entity that
  // shares the space id, then to the id itself.
  const page = space.page ?? {};
  let name = tidy(page.name ?? "", 120);
  let description = tidy(page.description ?? "", 600);
  if (!name || !description) {
    try {
      const sys = (await gql<{ entity: any }>(Q_ENTITY, { id })).entity;
      name ||= tidy(sys?.name ?? "", 120);
      description ||= tidy(sys?.description ?? "", 600);
    } catch {
      /* optional */
    }
  }
  // "System entity for space <uuid>" is a placeholder, not a description of
  // anything — treat it as absent so the contents sample runs instead.
  if (/^system entity for space\b/i.test(description)) description = "";
  name ||= `Space ${id.slice(0, 8)}`;

  // Most spaces describe themselves on their page, and that description is a
  // far better brief than a list of type names. Only pay for the slow contents
  // sample when the space tells us nothing about itself.
  const extra: string[] = [];
  if (!description) {
    const { entities, types } = await spaceContents(id);
    if (types.length) extra.push(`WHAT IT CATALOGUES (most common types): ${types.join(", ")}`);
    if (entities.length) extra.push(`EXAMPLE ENTRIES: ${entities.join(", ")}`);
  }

  return {
    subject: "space",
    id,
    name,
    description,
    typeNames: [], // a space is not an instance of a type; `extra` carries the topic
    facts: [`Space kind: ${tidy(space.type ?? "", 20) || "unknown"}`],
    related: [],
    ownImages: page.id ? [{ name, urls: await ownImageUrls(page.id) }] : [],
    refKind: "concept",
    spaceId: id,
    extra,
  };
}

async function relationDossier(ref: string, spaceId?: string): Promise<Dossier> {
  const id = normalizeGeoId(ref);
  if (!id) throw new GeoError(`a relation needs its id (32-hex or UUID); got "${tidy(ref, 60)}"`);

  const d = await gql<{ relation: any }>(Q_RELATION, { id });
  const rel = d.relation;
  if (!rel) throw new GeoError(`no relation found for ${id}`);

  const from = rel.fromEntity ?? {};
  const to = rel.toEntity ?? {};
  const via = tidy(rel.type?.name ?? "", 60) || "related to";
  const fromName = tidy(from.name ?? "", 100) || "(unnamed)";
  const toName = tidy(to.name ?? "", 100) || "(unnamed)";

  return {
    subject: "relation",
    id: rel.id,
    name: `${fromName} — ${via} → ${toName}`,
    description: tidy(rel.type?.description ?? "", 400),
    typeNames: [...dedupeTypes(from.types), ...dedupeTypes(to.types)],
    facts: [
      `FROM: ${fromName}${from.description ? ` — ${tidy(from.description, 160)}` : ""}`,
      `RELATION: ${via}`,
      `TO: ${toName}${to.description ? ` — ${tidy(to.description, 160)}` : ""}`,
    ],
    related: [],
    ownImages: [
      ...(from.id ? [{ name: fromName, urls: await ownImageUrls(from.id) }] : []),
      ...(to.id ? [{ name: toName, urls: await ownImageUrls(to.id) }] : []),
    ].filter((x) => x.urls.length),
    refKind: "concept", // the EDGE is abstract; both endpoints get their own refs
    spaceId: normalizeGeoId(spaceId ?? "") ?? rel.spaceId,
    extra: [
      `The image must show BOTH endpoints in one frame and make the relation "${via}" physically legible.`,
    ],
  };
}

/** Resolve any subject into a dossier. Throws GeoError when nothing matches. */
export async function resolveSubject(sub: SubjectRef): Promise<Dossier> {
  const ref = (sub.ref ?? "").trim();
  switch (sub.kind) {
    case "entity":
      return entityDossier(ref, sub.spaceId, "entity");
    case "type":
      return typeDossier(ref, sub.spaceId);
    case "property":
      return propertyDossier(ref, sub.spaceId);
    case "space":
      return spaceDossier(ref, sub.spaceId);
    case "relation":
      return relationDossier(ref, sub.spaceId);
    case "story":
      return {
        subject: "story",
        name: tidy(sub.headline ?? ref, 600),
        description: tidy(sub.summary ?? "", 1200),
        typeNames: [],
        facts: [],
        related: [],
        ownImages: [],
        refKind: "concept",
        extra: [],
      };
    case "text":
      return {
        subject: "text",
        name: tidy(sub.text ?? ref, 400),
        description: tidy(sub.summary ?? "", 800),
        typeNames: [],
        facts: [],
        related: [],
        ownImages: [],
        refKind: "concept",
        extra: [],
      };
    default:
      throw new GeoError(`unknown subject kind "${String((sub as any).kind)}"`);
  }
}

/** Render a dossier as the planner's user message. */
export function dossierText(d: Dossier): string {
  const lines = [`${d.subject.toUpperCase()}: ${d.name}`];
  if (d.typeNames.length) lines.push(`TYPES: ${d.typeNames.slice(0, 8).join(", ")}`);
  if (d.description) lines.push(`DESCRIPTION: ${d.description}`);
  for (const x of d.extra) lines.push(x);
  if (d.facts.length) lines.push(`FACTS:\n${d.facts.map((f) => `  - ${f}`).join("\n")}`);
  if (d.related.length) lines.push(`CONNECTED TO: ${d.related.join(", ")}`);
  return lines.join("\n");
}
