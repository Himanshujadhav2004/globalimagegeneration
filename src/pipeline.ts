/**
 * pipeline.ts — resolve → plan → reference → render → QC, for any subject.
 *
 *   1. RESOLVE  the subject into a factual dossier (geo.ts). A story or a free
 *               text brief skips the graph and carries its own copy.
 *   2. PLAN     the picture: factors + one composition sentence + a suggested
 *               look (planner.ts).
 *   3. REFS     hunt a real photo/logo/mark for each factor, gating each
 *               candidate; anything unfound is described in-prompt (refs.ts).
 *   4. RENDER   edits (with refs) or generations (without), at the one cover
 *               size (openai.ts).
 *   5. QC       inspect for sharp-but-wrong text and malformed hands; on a
 *               defect, re-render feeding the SPECIFIC defect back in.
 */

import { FALLBACK_SIZE, MAXREF, QC_RETRIES, RENDER_SIZE } from "./config.js";
import { composePrompt, defaultProfile, retryHint, type Profile } from "./art.js";
import { resolveSubject, type Dossier, type SubjectRef } from "./geo.js";
import { imageEdit, imageGenerate } from "./openai.js";
import { plan as planSubject, type Plan, type PlanFactor } from "./planner.js";
import { qcInspect } from "./qc.js";
import { resolveRefs, type Factor, type ResolvedRef } from "./refs.js";

// ── Public shape ────────────────────────────────────────────────────
export interface GenerateOptions {
  subject: SubjectRef;
  /** Pin a look, or "auto" to let the subject and the planner choose. */
  profile?: Profile | "auto";
  plannerModel?: string;
  /** Plan and compose the prompt but never call the image API. */
  dryRun?: boolean;
  /** In a dry run, still resolve references (costs downloads + vision calls). */
  resolveRefsInDryRun?: boolean;
  /** Stage callback for CLI progress lines. */
  onStage?: (stage: string, detail: string) => void;
}

export interface GeneratedImage {
  /** Empty on a dry run. */
  imageBase64: string;
  mimeType: string;
  /** The composition sentence — what the picture shows, for the DB. */
  sceneDescription: string;
  /** Optional short overlay caption the planner proposed ("" if none). */
  posterText: string;
  profile: Profile;
  /** Always RENDER_SIZE — kept in the result so logs record what was asked for. */
  size: string;
  subject: { kind: string; id?: string; name: string };
  /** The exact prompt sent to the image model. */
  prompt: string;
  /** ref sources + qc outcome, one line, for logs. */
  trace: string;
  dossier: Dossier;
  plan: Plan;
  refs: Array<{ name: string; kind: string; src: string; conf: number }>;
  described: Array<{ name: string; role: string }>;
}

// ── Factor preparation ──────────────────────────────────────────────
const norm = (s: string): string =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Attach the graph's own images to the factors they belong to.
 *
 * The planner is told to make the subject the first factor, but it is a language
 * model: match by name first, and only fall back to "the first factor is the
 * subject" for subjects that ARE a single entity.
 */
export function attachOwnImages(factors: PlanFactor[], dossier: Dossier): Factor[] {
  const out: Factor[] = factors.map((f) => ({
    name: f.name,
    kind: f.kind,
    role: f.role,
    refQuery: f.refQuery,
    domain: f.domain,
    ownImageUrls: [] as string[],
  }));

  for (const own of dossier.ownImages) {
    if (!own.urls.length) continue;
    const target = norm(own.name);
    let hit = out.find((f) => norm(f.name) === target);
    if (!hit && target) {
      hit = out.find((f) => norm(f.name).includes(target) || target.includes(norm(f.name)));
    }
    // A single-entity subject's own picture belongs to the lead factor even when
    // the planner renamed it ("Ethereum" -> "the Ethereum logo").
    if (!hit && out.length && ["entity", "type", "property", "space"].includes(dossier.subject)) {
      hit = out[0];
    }
    if (hit) hit.ownImageUrls = [...(hit.ownImageUrls ?? []), ...own.urls];
  }
  return out;
}

/** A plan with no factors still needs something to hunt a reference for. */
function fallbackFactors(dossier: Dossier): PlanFactor[] {
  if (!dossier.name) return [];
  return [{
    name: dossier.name,
    kind: dossier.refKind,
    refQuery: dossier.refKind === "concept" ? "" : dossier.name,
    domain: "",
    role: "the subject of the photograph",
  }];
}

// ── Orchestration ───────────────────────────────────────────────────
/** Generate one image for any Geo subject. Throws on an unrenderable subject. */
export async function generateImage(opts: GenerateOptions): Promise<GeneratedImage> {
  const stage = opts.onStage ?? (() => {});

  stage("resolve", `${opts.subject.kind}: ${opts.subject.ref ?? opts.subject.headline ?? opts.subject.text ?? ""}`);
  const dossier = await resolveSubject(opts.subject);

  stage("plan", dossier.name);
  const plan = await planSubject(dossier, { model: opts.plannerModel });

  const pinned = opts.profile && opts.profile !== "auto" ? opts.profile : undefined;
  const profile: Profile = pinned ?? plan.profile ?? defaultProfile(dossier.subject, dossier.refKind);

  const planFactors = plan.factors.length ? plan.factors : fallbackFactors(dossier);
  const factors = attachOwnImages(planFactors, dossier);

  let refs: ResolvedRef[] = [];
  let described: Array<{ name: string; role: string }> = factors.map((f) => ({ name: f.name, role: f.role }));
  let scores: string[] = factors.map((f) => `${f.name}=plan-only`);

  if (!opts.dryRun || opts.resolveRefsInDryRun) {
    stage("refs", `${factors.length} factor(s)`);
    const resolved = await resolveRefs(factors);
    refs = resolved.refs.slice(0, MAXREF);
    described = resolved.described;
    scores = resolved.scores;
  }

  const base = {
    subject: dossier.subject === "story" ? dossier.name : `${dossier.name}`,
    composition: plan.composition,
    refs: refs.map((r) => ({ name: r.name, role: r.role, kind: r.kind })),
    described,
    profile,
  };

  const summary = {
    sceneDescription: plan.composition || dossier.name,
    posterText: plan.posterText,
    profile,
    size: RENDER_SIZE,
    subject: { kind: dossier.subject, id: dossier.id, name: dossier.name },
    dossier,
    plan,
    refs: refs.map((r) => ({ name: r.name, kind: r.kind, src: r.src, conf: r.conf })),
    described,
  };

  if (opts.dryRun) {
    const prompt = composePrompt(base);
    return {
      ...summary,
      imageBase64: "",
      mimeType: "",
      prompt,
      trace: `${scores.join(" ")} [qc:dry-run] [profile:${profile}]`,
    };
  }

  // ── render + QC ──
  let data: Buffer | null = null;
  let prompt = "";
  let qc = "";
  let lastReason = "";

  for (let attempt = 0; attempt <= QC_RETRIES; attempt++) {
    prompt = composePrompt({ ...base, extra: attempt && lastReason ? retryHint(lastReason) : "" });
    stage("render", `attempt ${attempt + 1}, ${refs.length} ref(s), ${RENDER_SIZE}`);
    data = refs.length
      ? await imageEdit(prompt, refs.map((r) => ({ buf: r.buf, mime: r.mime })), RENDER_SIZE, FALLBACK_SIZE)
      : await imageGenerate(prompt, RENDER_SIZE, FALLBACK_SIZE);

    const { bad, reason } = await qcInspect(data, profile);
    if (!bad) {
      qc = `clean@${attempt}`;
      break;
    }
    lastReason = reason;
    qc = `glitch@${attempt}:${reason}`;
    stage("qc", `defect: ${reason}`);
  }
  if (!data) throw new Error("render produced no image");

  const mimeType = data.length >= 2 && data[0] === 0x89 && data[1] === 0x50 ? "image/png" : "image/jpeg";
  return {
    ...summary,
    imageBase64: data.toString("base64"),
    mimeType,
    prompt,
    trace: `${scores.join(" ")} [qc:${qc}] [profile:${profile}]`,
  };
}

// ── Back-compat: the news pipeline's entry point ────────────────────
export interface GroundedCover {
  imageBase64: string;
  mimeType: string;
  sceneDescription: string;
  trace: string;
}

/**
 * Drop-in replacement for `generateGroundedCover` in cover-pipeline.ts —
 * same signature, same editorial profile, same banner size, so `covers.ts` can
 * switch import path and nothing else.
 */
export async function generateGroundedCover(headline: string, summary: string): Promise<GroundedCover> {
  const r = await generateImage({
    subject: { kind: "story", headline, summary },
    profile: "editorial",
  });
  return {
    imageBase64: r.imageBase64,
    mimeType: r.mimeType,
    sceneDescription: r.sceneDescription,
    trace: r.trace,
  };
}
