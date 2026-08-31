# geo-image

Grounded image generation for **any** Geo knowledge-graph subject — an entity, a
type, a property, a space, a relation, a news story or a free-text brief.

The full guide is the skill itself:
[`.claude/skills/geo-image/SKILL.md`](.claude/skills/geo-image/SKILL.md), with
[`reference/geo-api.md`](.claude/skills/geo-image/reference/geo-api.md) and
[`reference/art-direction.md`](.claude/skills/geo-image/reference/art-direction.md).

```bash
npm install
npm run geo-image -- entity "Vitalik Buterin" --format square
npm run geo-image -- property "Date of birth" --dry-run   # plan only, no spend
npm test                                                  # 247 tests, all mocked
npm run check:live                                        # real Geo API + IPFS
```

## Layout

| Path | Purpose |
|---|---|
| `src/geo.ts` | Graph client, subject resolution, dossier building |
| `src/planner.ts` | Per-subject visual planning prompts |
| `src/refs.ts` | Reference hunting, download/normalisation, vision gate |
| `src/art.ts` | Formats, render profiles, prompt assembly |
| `src/openai.ts` | Chat, vision and both image endpoints |
| `src/qc.ts` | Post-render defect inspection |
| `src/pipeline.ts` | Orchestration + the legacy `generateGroundedCover` |
| `src/cli.ts` | `geo-image <kind> <ref> [options]` |
| `cover-pipeline.ts`, `cover-refs.ts`, `covers.ts` | The original news-only pipeline, kept as the reference implementation |

`src/` supersedes the three root files; the story path through it produces a
byte-identical prompt, which `test/art.test.ts` asserts against
`cover-pipeline.ts` itself.
