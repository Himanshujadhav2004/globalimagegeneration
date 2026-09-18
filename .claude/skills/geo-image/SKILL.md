---
name: geo-image
description: Generate a grounded, photorealistic image for ANY Geo knowledge-graph subject — an entity, a type, a property, a space, a relation, a news story, or a free-text brief. Use when asked to make a cover, banner, header or hero image for something in the Geo graph, or to extend the existing news-cover pipeline to non-news subjects. Always renders one shape: a 1536x640 cover banner.
---

# geo-image

Turns anything in the Geo knowledge graph into one believable photograph.

The original pipeline (`cover-pipeline.ts`) could only illustrate a **news story**:
headline in, wire photo out. This generalises it to every subject the graph
holds, while keeping the story path byte-for-byte identical.

## When to use

- "make a cover for this entity / type / property / space"
- "we need cover images for these people", "a banner for this space"
- "illustrate the relationship between X and Y"
- extending, debugging or tuning the image pipeline itself

Do **not** use it for charts or diagrams — the pipeline deliberately refuses to
render screens, graphs, dashboards and infographics.

## Quick start

```bash
npm install                                  # once

npm run geo-image -- entity "Vitalik Buterin"
npm run geo-image -- entity 0068f0fc16034c749c991e6eabe37031 --profile portrait
npm run geo-image -- type City --profile emblem
npm run geo-image -- property "Date of birth" --dry-run
npm run geo-image -- space 003eaa9b7a56fa847afd6f2e8cc518a6
npm run geo-image -- relation 3f0a…                  # one edge, both endpoints
npm run geo-image -- story --headline "SEC drops its case" --summary "…"
npm run geo-image -- text "a rusted bicycle against a whitewashed wall"
```

`--dry-run` plans the picture and prints the exact prompt **without calling the
image API** — always start there when tuning. Add `--with-refs` to also hunt
reference images during a dry run. `--json` prints a machine-readable result.

Images land in `./out/<kind>-<slug>.png` unless `--out` says otherwise.

## Subjects

| Kind | Lookup | What gets drawn |
|---|---|---|
| `entity` | id **or** name | The thing itself — a person, an org, a place, a product |
| `type` | id **or** name | One generic, unbranded specimen of the class |
| `property` | id **or** name | Ordinary objects that carry the field's meaning |
| `space` | id | The subject matter the space collects |
| `relation` | id | Both endpoints in one frame, staged to show the link |
| `story` | headline + summary | The news scene (unchanged from the old pipeline) |
| `text` | free text | Whatever the brief describes |

Names are resolved through the graph's own search, preferring an exact,
described match. `--space <id>` narrows a name lookup to one space.

## One frame, five looks

**Every image is a cover banner, 1536×640.** There is no size option — that is
the only shape the product uses, and the composition is planned for it rather
than cropped into it afterwards. If the model ever rejects that size, one
fallback render at 1536×1024 still crops to the banner ratio.

**One render serves four views.** The UI re-crops that same banner with
`object-cover`, so the prompt composes for all four at once (`CROP_SAFETY` in
`src/art.ts`):

| View | Crop | What survives |
|---|---|---|
| gallery | `aspect-2/1` | 1280×640 centred — outer **8%** each side is lost |
| list | 64×64 | the centre **640×640** square |
| explore | 60×60 | the centre **640×640** square |
| pill | 16×16 `rounded-full` | that square as a **circle**, fingernail-sized |

So the subject is **centred**: everything that identifies it lives in the middle
40% of the width, with a clean silhouette that still reads at 16px, and the
outer 30% at each side carries only disposable context. A third QC pass
(`PASS 3 CROP`) re-renders an image whose centre square would come up empty.

**Profiles** set the look. `--profile auto` (the default) picks from the subject,
and lets the planner override:

| Profile | Look | Default for |
|---|---|---|
| `editorial` | Reuters/AP candid wire photo | stories, relations, companies |
| `portrait` | 85mm environmental portrait | people |
| `landmark` | architectural / geographic | places |
| `still-life` | ordinary objects on one surface | properties, spaces, abstract entities |
| `emblem` | one object, museum lighting | types |

Profiles differ in camera language **and** in rules: object profiles ban people
outright, and QC checks hands only where people are expected.

## How it works

1. **Resolve** (`src/geo.ts`) — build a factual *dossier*: name, description,
   types, scalar facts, named neighbours, and the subject's **own** Avatar/Cover
   image from the graph.
2. **Plan** (`src/planner.ts`) — a per-subject prompt turns the dossier into
   visual *factors*, one composition sentence, and a suggested profile.
3. **Reference** (`src/refs.ts`) — for each factor, walk a per-kind source chain,
   download and normalise each candidate, and gate it with a lenient vision
   check. First one that passes wins; anything unfound is described in-prompt.
4. **Render** (`src/openai.ts`) — `/images/edits` when there are references,
   `/images/generations` when there are none.
5. **QC** (`src/qc.ts`) — inspect for sharp-but-misspelled text and malformed
   hands; on a defect, re-render feeding that **specific** defect back in, twice.

Reference priority: the entity's own graph image (0.99) → the host app's entity
DB → Brandfetch / CoinGecko → Wikidata → Wikipedia → Firecrawl → Commons.

For **people** the chain is `geo-own → db → geo name search → Wikipedia →
Firecrawl → Commons`. Firecrawl searches the name **plus the subject's Geo
description** — a bare name finds whoever is most famous, the description finds
the person the graph means. It returns several candidates, because the top hit
is often hotlink-protected and the list reliably contains strangers who share
the name; the vision gate checks each against the dossier and keeps the first
that can actually be them.

## As a library

```ts
import { generateImage } from "./src/pipeline.js";

const img = await generateImage({
  subject: { kind: "entity", ref: "Vitalik Buterin" },
  profile: "auto",
});
// img.imageBase64, .mimeType, .sceneDescription, .posterText, .profile, .trace
```

To keep the news worker's highest-confidence face/logo source, register its
database once at startup:

```ts
import { setDbImageResolver } from "./src/refs.js";
import { dbImage } from "../lib/entity-db.js";
setDbImageResolver(dbImage);
```

### Replacing the old news path

`generateGroundedCover(headline, summary)` is re-exported from
`src/pipeline.js` with the identical signature and return shape, and produces a
byte-identical prompt, at the same 1536×640. In `covers.ts`, only the import
changes:

```diff
-import { generateGroundedCover } from "../lib/cover-pipeline.js";
+import { generateGroundedCover } from "../lib/geo-image/pipeline.js";
```

A test asserts that equality against `cover-pipeline.ts` itself, so the
guarantee survives edits to either file.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | — | **Required** for planning, gating, QC and rendering |
| `PLANNER_MODEL` | `gpt-5.4` | Plans the picture |
| `VISION_MODEL` | `gpt-4.1-mini` | Reference gate + QC |
| `IMAGE_MODEL` | `gpt-image-2` | Renderer |
| `GEO_GRAPHQL_URL` | testnet geobrowser | Graph endpoint |
| `IPFS_GATEWAYS` | ipfs.io, dweb.link, pinata | Tried in order for own images |
| `BRANDFETCH_KEY` | — | Optional extra company-logo source |
| `FIRECRAWL_API_KEY` | — | Optional open-web image search; the only source that finds a face Wikipedia has no portrait for |
| `GEO_IMAGE_NO_SHARP` | — | `1` forces the no-sharp paths |

`sharp` is an **optional** dependency: without it, SVG and GIF references are
skipped rather than crashing.

## Testing

```bash
npm test          # 247 unit tests, fully mocked — no network, no spend
npm run check:live # real Geo API + IPFS + an OpenAI reachability probe
npm run typecheck
```

## Known constraints

- `entities(spaceId:…)` costs the Geo API roughly a second per row and errors
  past ~30 rows, so a space is sampled (15 rows) **only** when it has no
  description of its own.
- Some Avatar CIDs in the graph hold a saved HTML error page rather than an
  image. `download()` rejects markup even when the content-type claims otherwise.
- A 429 saying "no credits" is permanent, not rate limiting — it fails fast
  instead of sleeping through three retries.

## Reference

- `reference/geo-api.md` — the GraphQL queries, filters and well-known ids
- `reference/art-direction.md` — why each prompt rule exists; edit with care
