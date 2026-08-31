/**
 * legacy.ts — read a string constant straight out of the original
 * `cover-pipeline.ts` and evaluate it.
 *
 * The news prompt was tuned against real renders; the generalised pipeline must
 * reproduce it EXACTLY for stories. Comparing against the original file (rather
 * than a copy pasted into the test) means the guarantee survives edits to both.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LEGACY = join(ROOT, "cover-pipeline.ts");

let source: string | null | undefined;

function legacySource(): string | null {
  if (source !== undefined) return source;
  try {
    source = readFileSync(LEGACY, "utf8");
  } catch {
    source = null;
  }
  return source;
}

export const hasLegacy = (): boolean => legacySource() !== null;

/**
 * Evaluate `const <name> = <template-literal concatenation>;` from the legacy
 * file. Returns null when the file or the constant is absent.
 */
export function legacyConst(name: string): string | null {
  const src = legacySource();
  if (!src) return null;

  // Constants terminate at the first backtick-semicolon (double-quoted
  // one-liners at a quote-semicolon); none of them contain either sequence.
  const re = new RegExp(`const ${name}\\s*=\\s*([\\s\\S]*?[\`"]);\\s*\\n`);
  const m = re.exec(src);
  if (!m) return null;
  try {
    return new Function(`return ${m[1]}`)() as string;
  } catch {
    return null;
  }
}
