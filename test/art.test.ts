import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGREEMENT_REF_LINE, CROP_SAFETY, ENTITY_REF_LINE, PERSON_REF_LINE, PROFILES,
  composePrompt, defaultProfile, expectsPeople, isProfile, refLineFor, retryHint,
  type Profile,
} from "../src/art.js";
import { FALLBACK_SIZE, RENDER_SIZE, SAFE_SQUARE_FRACTION } from "../src/config.js";
import { hasLegacy, legacyConst } from "./helpers/legacy.js";

const base = {
  subject: "Ethereum crosses a milestone",
  composition: "a technician walks past a rack of servers at dawn",
  refs: [] as Array<{ name: string; role: string; kind: string }>,
  described: [] as Array<{ name: string; role: string }>,
  profile: "editorial" as Profile,
};

// ── frame ──────────────────────────────────────────────────────────
describe("frame", () => {
  it("renders one shape only: the cover banner", () => {
    assert.equal(RENDER_SIZE, "1536x640");
    assert.match(FALLBACK_SIZE, /^\d+x\d+$/);
    assert.notEqual(FALLBACK_SIZE, RENDER_SIZE, "a fallback equal to the size would never help");
  });

  it("tells the model the frame in every profile", () => {
    for (const profile of PROFILES) {
      assert.ok(composePrompt({ ...base, profile }).includes("Wide cinematic 21:9 banner."), profile);
    }
  });

  // One render feeds four crops (gallery 2:1, list 64, explore 60, pill 16
  // round), so the centre square has to carry the picture on its own.
  it("asks every profile to keep the subject inside the centred square crop", () => {
    for (const profile of PROFILES) {
      const p = composePrompt({ ...base, profile });
      assert.ok(p.includes("CROP-SAFE COMPOSITION"), `${profile} lost the crop rule`);
      assert.ok(p.includes("middle 40% of the width"), `${profile} lost the safe area`);
    }
  });

  it("states the safe area the square crops actually keep", () => {
    const [w, h] = RENDER_SIZE.split("x").map(Number);
    assert.equal(SAFE_SQUARE_FRACTION, h / w, "the safe square is the full-height centred square");
    assert.ok(Math.abs(SAFE_SQUARE_FRACTION - 0.4) < 0.02, "the prompt's 40% no longer matches");
  });
});

// ── profiles ────────────────────────────────────────────────────────
describe("profiles", () => {
  it("validates profile names", () => {
    assert.equal(isProfile("emblem"), true);
    assert.equal(isProfile("editorial"), true);
    assert.equal(isProfile("cinematic"), false);
    assert.equal(isProfile(""), false);
  });

  it("renders a prompt for every profile", () => {
    for (const profile of PROFILES) {
      const p = composePrompt({ ...base, profile });
      assert.ok(p.length > 2000, `${profile} prompt too short`);
      assert.ok(p.includes("STRICT — ONE single unified photograph"), `${profile} lost the single-frame rule`);
      assert.ok(p.includes("TEXT — follow ONE governing principle"), `${profile} lost the text rules`);
      assert.ok(p.includes("NO synthetic / sci-fi elements"), `${profile} lost the no-synthetic rule`);
    }
  });

  it("only asks for hands care where people belong", () => {
    for (const profile of PROFILES) {
      const p = composePrompt({ ...base, profile });
      if (expectsPeople(profile)) {
        assert.ok(p.includes("HANDS & POSES"), `${profile} should carry the hands rule`);
        assert.ok(p.includes("BACKGROUND PEOPLE"), `${profile} should carry the crowd rule`);
        assert.ok(!p.includes("NO PEOPLE —"), `${profile} should not ban people`);
      } else {
        assert.ok(!p.includes("HANDS & POSES"), `${profile} should not carry the hands rule`);
      }
    }
  });

  it("bans people outright in the object profiles", () => {
    for (const profile of ["still-life", "emblem"] as Profile[]) {
      assert.ok(composePrompt({ ...base, profile }).includes("NO PEOPLE —"));
    }
    assert.ok(composePrompt({ ...base, profile: "landmark" }).includes("PEOPLE — any person in frame is incidental"));
  });

  it("gives each profile its own camera language", () => {
    const looks = PROFILES.map((profile) => composePrompt({ ...base, profile }));
    assert.equal(new Set(looks).size, PROFILES.length, "two profiles produced identical prompts");
    assert.ok(looks[0].includes("Reuters / AP wire photograph"));
    assert.ok(looks[1].includes("environmental portrait"));
    assert.ok(looks[2].includes("architectural or geographic"));
    assert.ok(looks[3].includes("documentary still life"));
    assert.ok(looks[4].includes("museum object photograph"));
  });
});

describe("defaultProfile", () => {
  it("routes each subject kind to a sensible look", () => {
    assert.equal(defaultProfile("story", "concept"), "editorial");
    assert.equal(defaultProfile("relation", "person"), "editorial");
    assert.equal(defaultProfile("property", "concept"), "still-life");
    assert.equal(defaultProfile("type", "concept"), "emblem");
    assert.equal(defaultProfile("space", "concept"), "still-life");
  });

  it("routes an entity by what kind of thing it is", () => {
    assert.equal(defaultProfile("entity", "person"), "portrait");
    assert.equal(defaultProfile("entity", "place"), "landmark");
    assert.equal(defaultProfile("entity", "concept"), "still-life");
    assert.equal(defaultProfile("entity", "company"), "editorial");
    assert.equal(defaultProfile("entity", "object"), "editorial");
  });

  it("always returns a real profile", () => {
    assert.ok(PROFILES.includes(defaultProfile("nonsense", "nonsense")));
  });
});

// ── reference lines ─────────────────────────────────────────────────
describe("refLineFor", () => {
  it("uses the identity line for people and the document line for agreements", () => {
    assert.equal(refLineFor("person"), PERSON_REF_LINE);
    assert.equal(refLineFor("agreement"), AGREEMENT_REF_LINE);
  });

  it("uses the mark line for everything else", () => {
    for (const kind of ["company", "crypto", "government", "place", "object", "organization", "concept", ""]) {
      assert.equal(refLineFor(kind), ENTITY_REF_LINE, kind);
    }
  });
});

// ── prompt assembly ─────────────────────────────────────────────────
describe("composePrompt", () => {
  it("lists references in order with ordinal labels", () => {
    const p = composePrompt({
      ...base,
      refs: [
        { name: "Vitalik Buterin", role: "at the lectern", kind: "person" },
        { name: "Ethereum Foundation", role: "the sign behind", kind: "company" },
      ],
    });
    assert.ok(p.includes("Using the 2 reference image(s) provided"));
    assert.ok(p.includes("[first reference] Vitalik Buterin (at the lectern): a real photo of this person"));
    assert.ok(p.includes("[second reference] Ethereum Foundation (the sign behind): identify this entity"));
    assert.ok(p.indexOf("[first reference]") < p.indexOf("[second reference]"));
  });

  it("labels a sixth reference numerically", () => {
    const refs = Array.from({ length: 6 }, (_, i) => ({ name: `E${i}`, role: "r", kind: "object" }));
    const p = composePrompt({ ...base, refs });
    assert.ok(p.includes("[sixth reference] E5"));
  });

  it("omits the reference section entirely when there are none", () => {
    const p = composePrompt({ ...base, refs: [] });
    assert.ok(!p.includes("The reference images are, in order"));
    assert.ok(p.includes("Using the 0 reference image(s) provided"));
  });

  it("lists described factors and drops an empty role", () => {
    const p = composePrompt({
      ...base,
      described: [{ name: "a $250 bill", role: "held flat to camera" }, { name: "a plain ledger", role: "" }],
    });
    assert.ok(p.includes("a $250 bill (held flat to camera); a plain ledger."));
  });

  it("omits the described section when there is nothing to describe", () => {
    assert.ok(!composePrompt(base).includes("Also depict, rendered naturally"));
  });

  it("carries the composition sentence", () => {
    assert.ok(composePrompt(base).includes(base.composition));
  });

  it("appends the retry hint last", () => {
    const p = composePrompt({ ...base, extra: retryHint("PASS 1 TEXT: GOCDS on the crate") });
    assert.ok(p.trimEnd().endsWith("Change nothing else."));
    assert.ok(p.includes("GOCDS on the crate"));
  });

  it("survives an empty composition and empty names", () => {
    const p = composePrompt({ ...base, composition: "", described: [{ name: "", role: "" }] });
    assert.ok(p.length > 2000);
  });
});

describe("retryHint", () => {
  it("names the defect and forbids other changes", () => {
    const h = retryHint("fused fingers on the left hand");
    assert.ok(h.includes("fused fingers on the left hand"));
    assert.ok(h.includes("Change nothing else."));
  });
});

// ── regression guard against the validated news prompt ──────────────
//
// The editorial prompt is the legacy news prompt VERBATIM plus exactly one
// addition: CROP_SAFETY, appended last. That addition is deliberate — the news
// covers are shown in the same gallery/list/explore/pill views as every other
// subject, so they need the same centred composition. Nothing else may drift.
describe("the editorial profile reproduces the legacy news prompt", { skip: !hasLegacy() }, () => {
  it("keeps the reference lines byte-identical", () => {
    assert.equal(PERSON_REF_LINE, legacyConst("PERSON_REF_LINE"));
    assert.equal(AGREEMENT_REF_LINE, legacyConst("AGREEMENT_REF_LINE"));
    assert.equal(ENTITY_REF_LINE, legacyConst("ENTITY_REF_LINE"));
  });

  it("keeps the static clause block byte-identical, with only the crop rule appended", () => {
    const legacy = legacyConst("STATIC_CLAUSES");
    assert.ok(legacy, "could not read STATIC_CLAUSES from cover-pipeline.ts");
    const prompt = composePrompt({ ...base, profile: "editorial" });
    assert.ok(
      prompt.endsWith(legacy + "\n\n" + CROP_SAFETY),
      "the editorial profile no longer ends with the legacy clause block plus the crop rule",
    );
  });

  it("produces the whole legacy prompt for a story", () => {
    const legacyStatic = legacyConst("STATIC_CLAUSES")!;
    const headline = "SEC drops its case";
    const comp = "a lawyer leaves a courthouse at dusk";
    const refs = [{ name: "SEC", role: "the seal on the wall", kind: "government" }];
    const described = [{ name: "a $250 bill", role: "held to camera" }];

    // Rebuilt exactly as cover-pipeline.ts's composePrompt does, plus the crop rule.
    const expected =
      `Using the 1 reference image(s) provided, create ONE photorealistic editorial ` +
      `news photograph that tells this story: ${headline}.\n\n` +
      "The reference images are, in order:\n" +
      `  [first reference] SEC (the seal on the wall): ${legacyConst("ENTITY_REF_LINE")}.\n\n` +
      "Also depict, rendered naturally from description (generic, no specific real brand " +
      "or logo, no watermark): a $250 bill (held to camera).\n\n" +
      `Compose everything into a single cohesive, believable news scene: ${comp}\n\n` +
      legacyStatic + "\n\n" + CROP_SAFETY;

    const actual = composePrompt({
      subject: headline, composition: comp, refs, described, profile: "editorial",
    });
    assert.equal(actual, expected);
  });
});
