---
name: geo-image
description: Generate a grounded, photorealistic image for ANY Geo knowledge-graph subject — an entity, a type, a property, a space, a relation, a news story, or a free-text brief. Use when asked to make a cover, banner, avatar, thumbnail, illustration or hero image for something in the Geo graph, or to extend the existing news-cover pipeline to non-news subjects.
---

# geo-image

Turns anything in the Geo knowledge graph into one believable photograph.

The original pipeline (`cover-pipeline.ts`) could only illustrate a **news story**:
headline in, wire photo out. This generalises it to every subject the graph
holds, while keeping the story path byte-for-byte identical.

## When to use

- "make a cover for this entity / type / property / space"
- "we need avatars for these people", "a banner for this space"
- "illustrate the relationship between X and Y"
- extending, debugging or tuning the image pipeline itself

Do **not** use it for charts or diagrams — the pipeline deliberately refuses to
render screens, graphs, dashboards and infographics.

## Quick start

```bash
npm install                                  # once

npm run geo-image -- entity "Vitalik Buterin"
npm run geo-image -- entity 0068f0fc16034c749c991e6eabe37031 --format square
npm run geo-image -- type City --profile emblem
npm run geo-image -- property "Date of birth" --dry-run
npm run geo-image -- space 003eaa9b7a56fa847afd6f2e8cc518a6 --format wide
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

## Formats and profiles

**Formats** set the frame: `banner` (1536×640, the news cover shape and the
default), `wide` (1536×1024), `square` (1024×1024), `portrait` (1024×1536).

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
DB → Brandfetch / CoinGecko → Wikidata → Wikipedia → Commons.

## As a library

```ts
import { generateImage } from "./src/pipeline.js";

const img = await generateImage({
  subject: { kind: "entity", ref: "Vitalik Buterin" },
  format: "square",
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
byte-identical prompt. In `covers.ts`, only the import changes:

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
