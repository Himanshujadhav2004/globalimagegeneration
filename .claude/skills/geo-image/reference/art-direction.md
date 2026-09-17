# Art direction — why every rule is there

The prompt in `src/art.ts` looks over-specified. It is not: nearly every clause
buys back a specific, repeatable failure mode of the image model. Read this
before shortening anything.

## The one governing principle: text

Image models render **short, large, flat** text correctly and **small, dense,
curved** text as convincing gibberish. The prompt therefore never says "no
text" (which produces blank, dead surfaces) and never says "add text" (which
produces garbage). It splits the difference:

- short real word, head-on, flat → render it crisply ("CLARITY ACT", "250")
- anything small, angled, wrapped, curved, reflected → soft impressionistic
  texture that reads as lettering at a glance
- **safety valve**: if it would resolve into sharp garbled glyphs, render a
  soft tonal band or omit it — never sharp gibberish

Consequences encoded in the prompt: at most two legible words per sign; never
repeat a word ("OF OF"); omit a word rather than guess its spelling; keep seals
small and angled so their ring-text cannot be read or garbled.

## Deliberate carve-outs

Money and titled documents are **allowed props**, including satirical
denominations (a "$250 bill"), because a denomination or a short title is not a
statistic. When a banknote is the hero, one consistent denomination number, the
portrait as the central engraving, every other inscription soft.

Real seals, crests and badges of a *named reference entity* are allowed: central
emblem sharp, encircling ring-text an out-of-focus band.

## Permanent bans

No invented statistics, percentages, prices or index values. No charts, graphs,
tickers, dashboards, infographics, plots or axis labels. No holograms, glowing
screens, floating icons, node graphics, neon or HUD. No collage, montage,
diptych, split-screen, grid or inset. No stock-photo watermark or source caption.

These are not stylistic preferences — a fabricated figure in an editorial image
is a factual claim the graph never made.

## People

- **Hands** are the model's second-worst failure. Frame them relaxed, lowered or
  out of frame; never close-up, bound or intricately gesturing.
- **Background faces** render as melted glitches at small sizes. Only named
  foreground subjects are sharp; everyone else is out of focus, turned away,
  distant or in silhouette.
- Object profiles (`still-life`, `emblem`) ban people entirely; `landmark`
  allows only distant, blurred figures.

## Profiles

Every profile shares the frame, synthetic, text and props rules, and differs in
its camera clause and its people rule.

| Profile | Camera | People |
|---|---|---|
| `editorial` | Reuters/AP candid, 35mm, natural light, film grain | full cast |
| `portrait` | 85mm environmental portrait, available light, un-posed | full cast |
| `landmark` | 24–35mm architectural, straight verticals, deep focus | distant only |
| `still-life` | 50mm, one surface, one-side window light, used objects | none |
| `emblem` | 100mm, seamless neutral ground, one contact shadow | none |

Every profile renders at one size — 1536×640, the cover banner — and closes its
look sentence with "Wide cinematic 21:9 banner." so the scene is composed for
that frame. The `editorial` profile reproduces the legacy news prompt **byte for
byte**; a test asserts this against `cover-pipeline.ts` directly.

## Per-subject planner rules

Each subject fails differently, so each gets its own planner prompt:

- **entity** — the entity is the first factor and the unmistakable subject.
  Supporting factors must be facts from the dossier, never invented associates.
- **type** — one *generic, unbranded* specimen. Naming a real member would
  imply that member **is** the category, so every factor is `concept` with an
  empty `ref_query`. Never draw the property list as a schema or form.
- **property** — the dominant failure is drawing a screen, form, spreadsheet or
  UI. The prompt bans all of them and asks for ordinary objects that carry the
  same meaning (birth date → a worn calendar and a hospital wristband).
- **space** — depict the subject matter, never the software. A space about
  medicine looks like medicine, not like a medical app.
- **relation** — both endpoints in one frame; the *staging* carries the
  relation. Arrows, lines, links and graph visualisations are banned.
- **story** — verbatim from the validated news planner. Do not edit.

## Reference lines

What the render is told about each reference image:

- **person** — "preserve their exact face and identity". The gate that admits
  a person reference checks IDENTITY, not just "is this a face": it is given
  the subject's Geo description and rejects a photograph that cannot be them
  (wrong era, wrong apparent age, another walk of life). Without that check a
  web search happily returns a different real person of the same name.
- **agreement** — a printed document whose real short title is legible, body
  copy as soft texture, no seal on the document
- **everything else** — the entity's real mark, integrated naturally; prefer a
  symbol over a long wordmark; ring-text soft

## QC

Two narrow passes, because the renderer is *told* to make small text soft — a QC
that flagged "unreadable text" would reject every good image.

1. **TEXT** — flag only sharp text that is *wrong*: misspelled, doubled,
   backwards, or a substituted character. Never flag intentional softness, and
   never flag a satirical denomination for being unusual.
2. **HANDS** (people profiles) — only a prominent, obviously malformed hand.
   **FORM** (object profiles) — only a collage, or something that is plainly not
   a photograph.

QC **fails open**: an error keeps the image. A false positive costs a render.
On a real defect the retry names *that specific defect* and forbids any other
change — a blind re-roll usually reintroduces it.
