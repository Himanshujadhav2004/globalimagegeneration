/**
 * covers command — Generate grounded editorial cover images for curated stories.
 *
 * Pipeline (lib/cover-pipeline.ts, ported from the validated `factors114`):
 *   plan (gpt-5.3) → resolve entity references (Geo DB / Wikidata / CoinGecko /
 *   Commons …) with a lenient vision gate → render on gpt-image-2 (edits with
 *   refs, else generations) → QC the render for garbled text / malformed hands
 *   and regenerate the specific defect, up to 2 retries.
 *
 * Unlike the previous Gemini renderer this is GROUNDED and PEOPLED: named people
 * get their real face from a reference photo, logos/seals/short titles/currency
 * are allowed under the legibility rules, and the scene depicts the actual event.
 *
 * Usage:
 *   geo-news covers --story <id>
 *   geo-news covers --space crypto
 *   geo-news covers --space ai --limit 5
 *   geo-news covers --space crypto --dry-run
 *
 * Environment:
 *   OPENAI_API_KEY                              — required (planner + vision + image)
 *   ENTITY_DB_HOST/PORT/USER/PASSWORD           — optional; highest-confidence face/logo source
 *   BRANDFETCH_KEY                              — optional; extra company-logo source (off by default)
 *   PLANNER_MODEL / VISION_MODEL / IMAGE_MODEL  — optional model overrides
 */

import { existsSync, lstatSync, mkdirSync, readlinkSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import sharp from "sharp";
import { NewsDB, type Story } from "../db/sqlite.js";
import { getR2Config, uploadFile } from "../lib/r2.js";
import { findProjectRoot } from "../lib/spaces.js";
import { generateGroundedCover } from "../lib/cover-pipeline.js";
import { closeEntityDb } from "../lib/entity-db.js";
import { IMAGE_MODEL } from "../lib/openai.js";

// ── Options ─────────────────────────────────────────────────────────

export interface CoversOptions {
  dbPath: string;
  parentRunId?: number;
  storyId?: string;
  space?: string;
  limit?: number;
  dryRun?: boolean;
  model?: string;
  outputDir?: string;
}

export interface CoversResult {
  generated: number;
  failed: number;
  skipped: number;
  stories: Array<{
    id: string;
    headline: string;
    coverPath?: string;
    error?: string;
  }>;
}

// ── Constants ───────────────────────────────────────────────────────

const TARGET_WIDTH = 2384;
const TARGET_HEIGHT = 640;
const MAX_COVER_RUNS = 1;

// ── Image Processing ────────────────────────────────────────────────

async function cropAndResize(rawPath: string, outputPath: string): Promise<void> {
  const image = sharp(rawPath);
  const metadata = await image.metadata();
  const srcW = metadata.width ?? TARGET_WIDTH;
  const srcH = metadata.height ?? TARGET_HEIGHT;

  // Center-crop to target aspect ratio, then resize
  const targetRatio = TARGET_WIDTH / TARGET_HEIGHT;
  const srcRatio = srcW / srcH;

  let cropW = srcW;
  let cropH = srcH;
  if (srcRatio > targetRatio) {
    // Too wide — crop sides
    cropW = Math.round(srcH * targetRatio);
  } else {
    // Too tall — crop top/bottom
    cropH = Math.round(srcW / targetRatio);
  }

  const left = Math.round((srcW - cropW) / 2);
  const top = Math.round((srcH - cropH) / 2);

  await sharp(rawPath)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(TARGET_WIDTH, TARGET_HEIGHT, { fit: "fill" })
    .png()
    .toFile(outputPath);
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

// ── Main ────────────────────────────────────────────────────────────

export async function runCovers(opts: CoversOptions): Promise<CoversResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey && !opts.dryRun) {
    throw new Error("OPENAI_API_KEY required");
  }

  const db = new NewsDB(opts.dbPath);
  // The image renderer is gpt-image-2 (IMAGE_MODEL); recorded per-cover. opts.model
  // is honored for the DB record / run metadata but the pipeline reads its model
  // ids from the environment.
  const model = opts.model ?? IMAGE_MODEL;
  let runId: number | null = null;
  let targetSpace = opts.space ?? "adhoc";

  // Output directory
  const r2Config = getR2Config();
  const projectRoot = findProjectRoot();
  const coversDir = opts.outputDir ?? join(projectRoot, "covers");

  // If coversDir is a symlink (e.g. Docker: /app/covers -> /data/covers),
  // ensure the target directory exists before creating subdirectories.
  try {
    const stat = lstatSync(coversDir);
    if (stat.isSymbolicLink()) {
      mkdirSync(readlinkSync(coversDir), { recursive: true });
    }
  } catch {}

  const rawDir = join(coversDir, "raw");
  const finalDir = join(coversDir, "final");
  mkdirSync(rawDir, { recursive: true });
  mkdirSync(finalDir, { recursive: true });

  const result: CoversResult = {
    generated: 0,
    failed: 0,
    skipped: 0,
    stories: [],
  };

  try {
    // Determine which stories need covers
    let stories: Story[];

    if (opts.storyId) {
      const story = db.getStoryById(opts.storyId);
      if (!story) {
        const all = db.getStories("");
        const matches = all.filter((s) => s.id.includes(opts.storyId!));
        if (matches.length === 1) {
          stories = matches;
        } else {
          throw new Error(`Story not found: ${opts.storyId}`);
        }
      } else {
        stories = [story];
        targetSpace = story.space;
      }
    } else if (opts.space) {
      stories = db.getStories(opts.space, { status: "curated" });
      if (opts.limit) stories = stories.slice(0, opts.limit);
      targetSpace = opts.space;
    } else {
      throw new Error("Provide --story <id> or --space <name>");
    }

    // Filter out stories that already have covers or exceeded retry limit
    let alreadyHave = 0;
    const needsCovers: typeof stories = [];
    const maxedOut: typeof stories = [];

    for (const s of stories) {
      if (db.hasCover(s.id)) {
        alreadyHave++;
      } else {
        const err = db.getCoverError(s.id);
        if (err && err.attempts >= MAX_COVER_RUNS) {
          db.updateStoryStatus(s.id, "rejected");
          maxedOut.push(s);
        } else {
          needsCovers.push(s);
        }
      }
    }

    if (alreadyHave > 0) {
      console.log(`  ⊘ ${alreadyHave} already have covers`);
    }
    if (maxedOut.length > 0) {
      console.log(`  ✗ ${maxedOut.length} rejected (cover generation failed)`);
    }

    console.log(`  🖼️  ${needsCovers.length} stories need covers\n`);

    runId = db.startRun(targetSpace, "covers", {
      parentRunId: opts.parentRunId,
      itemsTotal: needsCovers.length,
      metadata: { dryRun: !!opts.dryRun, model },
    });
    db.createRunItems(runId, needsCovers.map((story) => ({
      itemKey: story.id,
      label: story.headline,
    })));

    if (needsCovers.length === 0) {
      result.skipped = alreadyHave;
      db.completeRun(runId, { stories_created: 0, errors: [] });
      return result;
    }

    for (const story of needsCovers) {
      const slug = slugify(story.headline);
      const rawPath = join(rawDir, `${slug}.png`);
      const finalPath = join(finalDir, `${slug}.png`);

      process.stdout.write(`  📰 ${story.headline.slice(0, 65)}... `);

      if (opts.dryRun) {
        console.log(`→ Would generate: ${finalPath}`);
        result.stories.push({ id: story.id, headline: story.headline, coverPath: finalPath });
        result.generated++;
        db.updateRunItem(runId, story.id, {
          status: "skipped",
          lastError: "dry run",
          metadata: { coverPath: finalPath },
        });
        db.refreshRunProgress(runId, story.headline);
        continue;
      }

      try {
        db.updateRun(runId, { currentItem: story.headline });
        db.updateRunItem(runId, story.id, { status: "running", incrementAttempts: true });

        // Grounded pipeline: plan → refs → gpt-image-2 → QC/regen
        const { imageBase64, sceneDescription, trace } = await generateGroundedCover(
          story.headline, story.summary,
        );

        // Write raw image (PNG or JPEG bytes — sharp detects the format on read)
        writeFileSync(rawPath, Buffer.from(imageBase64, "base64"));

        // Crop and resize
        await cropAndResize(rawPath, finalPath);

        // Upload to R2 if configured
        let r2Key: string | undefined;
        if (r2Config) {
          try {
            r2Key = `covers/${slug}.png`;
            await uploadFile(finalPath, r2Key, r2Config);
          } catch (e: any) {
            console.log(`(R2 upload failed: ${e.message?.slice(0, 60)})`);
            r2Key = undefined;
          }
        }

        // Save to DB
        db.saveCover(story.id, {
          path: finalPath,
          r2_key: r2Key,
          scene_description: sceneDescription,
          model,
        });

        console.log(`✓ ${trace}`);
        result.stories.push({ id: story.id, headline: story.headline, coverPath: finalPath });
        result.generated++;
        db.updateRunItem(runId, story.id, {
          status: "completed",
          metadata: { coverPath: finalPath, model, trace },
        });
      } catch (e: any) {
        console.log(`✗ ${e.message?.slice(0, 80)}`);
        result.stories.push({ id: story.id, headline: story.headline, error: e.message });
        result.failed++;
        db.saveCoverError(story.id, e.message ?? "unknown error", model);
        db.updateStoryStatus(story.id, "rejected");
        db.updateRunItem(runId, story.id, {
          status: "failed",
          lastError: e.message,
        });
        try {
          if (existsSync(finalPath)) unlinkSync(finalPath);
        } catch {}
      } finally {
        db.refreshRunProgress(runId, story.headline);
        try {
          if (existsSync(rawPath)) unlinkSync(rawPath);
        } catch {}
      }
    }
    db.completeRun(runId, {
      stories_created: result.generated,
      errors: result.stories.flatMap((story) => story.error ? [story.error] : []),
    });
  } catch (err: any) {
    if (runId != null) {
      db.failRun(runId, err.message?.slice(0, 200) ?? "covers failed", {
        stories_created: result.generated,
        errors: result.stories.flatMap((story) => story.error ? [story.error] : []),
      });
    }
    throw err;
  } finally {
    db.close();
    await closeEntityDb(); // end pg pools so the CLI exits without node-pg's idle delay
  }

  return result;
}
