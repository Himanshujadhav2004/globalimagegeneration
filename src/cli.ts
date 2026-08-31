#!/usr/bin/env node
/**
 * cli.ts — `geo-image <kind> <ref> [options]`
 *
 *   geo-image entity "Vitalik Buterin"
 *   geo-image entity 0068f0fc16034c749c991e6eabe37031 --format square
 *   geo-image type City --profile emblem
 *   geo-image property "Date of birth" --dry-run
 *   geo-image space fae5c35a91712b2cae3dd5028d3aba3f --format wide
 *   geo-image relation <relation-id>
 *   geo-image story --headline "…" --summary "…"
 *   geo-image text "a rusted bicycle against a whitewashed wall"
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FORMATS, PROFILES, isFormat, isProfile, type Format, type Profile } from "./art.js";
import { generateImage } from "./pipeline.js";
import type { SubjectKind } from "./geo.js";
import { slugify } from "./util.js";

const KINDS: SubjectKind[] = ["entity", "type", "property", "space", "relation", "story", "text"];

const USAGE = `
geo-image — grounded imagery for any Geo subject

USAGE
  geo-image <kind> <ref> [options]

KINDS
  entity <id|name>     a thing in the graph            geo-image entity "Vitalik Buterin"
  type <id|name>       a class of things               geo-image type City
  property <id|name>   a field on a type               geo-image property "Date of birth"
  space <id>           a curated topic area            geo-image space fae5c35a9171…
  relation <id>        one edge, FROM -[rel]-> TO      geo-image relation 3f0a…
  story                a news story (--headline/--summary)
  text <brief>         a free-text brief

OPTIONS
  --format <f>      ${Object.keys(FORMATS).join(" | ")}            (default banner)
  --profile <p>     auto | ${PROFILES.join(" | ")}   (default auto)
  --space <id>      restrict a name lookup to one space
  --headline <s>    story headline
  --summary <s>     story context / entity extra context
  --out <path>      write the image here (default ./out/<kind>-<slug>.<ext>)
  --model <id>      override the planner model
  --dry-run         plan and print the prompt; never calls the image API
  --with-refs       in a dry run, still resolve reference images
  --print-prompt    print the full image prompt
  --json            print the result as JSON (image bytes omitted)
  -h, --help
`.trimStart();

// ── Arg parsing ─────────────────────────────────────────────────────
export interface CliArgs {
  kind: SubjectKind;
  ref: string;
  format: Format;
  profile: Profile | "auto";
  spaceId?: string;
  headline?: string;
  summary?: string;
  out?: string;
  model?: string;
  dryRun: boolean;
  withRefs: boolean;
  printPrompt: boolean;
  json: boolean;
}

export class UsageError extends Error {}

const FLAGS_WITH_VALUE = new Set([
  "--format", "--profile", "--space", "--headline", "--summary", "--out", "--model",
]);

/** Parse argv (without node/script). Throws UsageError with a readable reason. */
export function parseArgs(argv: string[]): CliArgs {
  const positional: string[] = [];
  const opt: Record<string, string> = {};
  const bool = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);
    if (FLAGS_WITH_VALUE.has(name)) {
      const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
      if (value === undefined) throw new UsageError(`${name} needs a value`);
      opt[name] = value;
    } else {
      bool.add(name);
    }
  }

  const kind = (positional[0] ?? "") as SubjectKind;
  if (!kind) throw new UsageError("a subject kind is required");
  if (!KINDS.includes(kind)) {
    throw new UsageError(`unknown kind "${kind}" — expected one of: ${KINDS.join(", ")}`);
  }

  const ref = positional.slice(1).join(" ").trim();
  const headline = opt["--headline"];
  const summary = opt["--summary"];

  if (kind === "story" && !headline && !ref) throw new UsageError("story needs --headline (or a positional headline)");
  if (kind === "text" && !ref) throw new UsageError("text needs a brief, e.g. geo-image text \"a rusted bicycle\"");
  if (!["story", "text"].includes(kind) && !ref) throw new UsageError(`${kind} needs an id or a name`);
  if (["space", "relation"].includes(kind) && !/^[0-9a-fA-F-]{32,36}$/.test(ref)) {
    throw new UsageError(`${kind} needs an id (32-hex or dashed UUID), got "${ref}"`);
  }

  const format = opt["--format"] ?? "banner";
  if (!isFormat(format)) {
    throw new UsageError(`unknown format "${format}" — expected: ${Object.keys(FORMATS).join(", ")}`);
  }
  const profile = opt["--profile"] ?? "auto";
  if (profile !== "auto" && !isProfile(profile)) {
    throw new UsageError(`unknown profile "${profile}" — expected: auto, ${PROFILES.join(", ")}`);
  }

  return {
    kind,
    ref,
    format,
    profile: profile as Profile | "auto",
    spaceId: opt["--space"],
    headline,
    summary,
    out: opt["--out"],
    model: opt["--model"],
    dryRun: bool.has("--dry-run"),
    withRefs: bool.has("--with-refs"),
    printPrompt: bool.has("--print-prompt") || bool.has("--dry-run"),
    json: bool.has("--json"),
  };
}

// ── Main ────────────────────────────────────────────────────────────
export async function main(argv: string[]): Promise<number> {
  if (!argv.length || argv.includes("-h") || argv.includes("--help")) {
    console.log(USAGE);
    return 0;
  }

  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e: any) {
    console.error(`error: ${e.message}\n\n${USAGE}`);
    return 2;
  }

  const started = Date.now();
  const result = await generateImage({
    subject: {
      kind: args.kind,
      ref: args.ref,
      spaceId: args.spaceId,
      headline: args.headline ?? args.ref,
      summary: args.summary,
      text: args.ref,
    },
    format: args.format,
    profile: args.profile,
    plannerModel: args.model,
    dryRun: args.dryRun,
    resolveRefsInDryRun: args.withRefs,
    onStage: (stage, detail) => process.stderr.write(`  · ${stage.padEnd(7)} ${detail}\n`),
  });

  if (args.printPrompt) {
    console.log("\n─── PROMPT ───────────────────────────────────────────\n");
    console.log(result.prompt);
    console.log("\n──────────────────────────────────────────────────────\n");
  }

  let outPath: string | undefined;
  if (result.imageBase64) {
    const ext = result.mimeType === "image/png" ? "png" : "jpg";
    outPath = resolve(args.out ?? join(process.cwd(), "out", `${args.kind}-${slugify(result.subject.name)}.${ext}`));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, Buffer.from(result.imageBase64, "base64"));
  }

  if (args.json) {
    console.log(JSON.stringify({
      subject: result.subject,
      profile: result.profile,
      format: result.format,
      sceneDescription: result.sceneDescription,
      posterText: result.posterText,
      refs: result.refs,
      described: result.described,
      trace: result.trace,
      bytes: result.imageBase64 ? Buffer.byteLength(result.imageBase64, "base64") : 0,
      path: outPath,
    }, null, 2));
  } else {
    console.log(`\n  ${result.subject.kind}: ${result.subject.name}`);
    console.log(`  profile: ${result.profile}   format: ${result.format} (${FORMATS[result.format].size})`);
    console.log(`  scene:   ${result.sceneDescription}`);
    if (result.posterText) console.log(`  poster:  ${result.posterText}`);
    console.log(`  trace:   ${result.trace}`);
    if (outPath) console.log(`  wrote:   ${outPath}`);
    console.log(`  took:    ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return 0;
}

// ── Entry ───────────────────────────────────────────────────────────
const invokedDirectly = process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  try {
    process.loadEnvFile?.(resolve(process.cwd(), ".env"));
  } catch {
    /* no .env — rely on the ambient environment */
  }
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e: any) => {
      console.error(`\n  ✗ ${e?.message ?? e}`);
      process.exit(1);
    });
}
