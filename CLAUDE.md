# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A static, no-build employee portal for Enchanted Medical Aesthetics: six standalone HTML files, each fully self-contained (inline `<style>` and `<script>`, no external JS files, no bundler, no package manager). There is no build step, no test suite, and no linter — files are edited directly and served as-is (currently deployed by uploading files through the GitHub web UI, per the commit history).

## Running / previewing

There is no dev server or build command. To preview changes, open the HTML file directly in a browser or serve the directory with any static file server, e.g.:

```
python3 -m http.server 8000
```

There are no tests, lint configs, or CI to run.

## Files

- `index.html` — Landing/staff portal page. Client-side password gate (`sessionStorage` + hardcoded plaintext password in the JS, currently `"Enchanted276"`), then a tile grid linking out to internal tools (TalentHR, Teams, TalentLMS, Allergan training, YouTube) and to the clinical pages below.
- `library.html` — Clinical compound library (neuromodulators, fillers, biostimulators, peptides, GLP-1s, etc.) with search, category filters, and a modal detail view per compound, including a mini reconstitution calculator inside the modal.
- `calculator.html` — Standalone reconstitution/dose calculator across all compound types.
- `glp1-calculator.html` — Dedicated GLP-1/peptide titration calculator (semaglutide, tirzepatide, retatrutide) with dose schedules and conversion tables.
- `sop-library.html` — Standard operating procedures reference (searchable/filterable card + modal, same pattern as `library.html`).
- `lab-values.html` — Lab reference values, organized into tabs (GLP-1 pre-screening panel, quick reference, interpretations, acid-base, memory tricks) rather than cards.

**This content is clinical/medical reference material** (dosing, contraindications, titration schedules, lab ranges) for a licensed medical aesthetics practice. Treat any edits to dosing numbers, units, contraindications, or protocol steps as high-stakes — don't alter clinical values beyond what's explicitly requested, and flag anything that looks like it could be a transcription error rather than silently "fixing" it.

## Shared architecture across pages

Every page past `index.html` repeats the same structure — there is no shared layout, so a change meant to apply "everywhere" (nav links, brand colors, footer text) must be hand-edited into each file individually:

- **Nav bar**: fixed `<nav>` with a `.nav-brand` (SVG logo mark + "Enchanted" wordmark) and a `.nav-links` list linking to `index.html`, `library.html`, `calculator.html`, `glp1-calculator.html`, `sop-library.html`, `lab-values.html`, always in that order with the labels `🏠 Home`, `📚 Library`, `⚗ Calculator`, `💉 GLP-1`, `📋 SOPs`, `🧪 Labs`. The current page's link gets `class="active"`. This block is hand-duplicated in all 5 non-index pages — when adding a new page, add its link (in the right spot in the order above) to the `.nav-links` block in every other page, and give the new page the same 6-link block with its own entry marked active. `index.html`'s "Clinical Reference" tile grid mirrors the same 4 clinical/tool pages (`library.html`, `calculator.html`, `glp1-calculator.html`, `sop-library.html`, `lab-values.html`) as tiles — it's separate markup from `.nav-links`, so a new page needs a tile added there too, not just a nav entry.
- **Design tokens**: CSS custom properties defined per-file in `:root` (`--ink`, `--gold`, `--charcoal`, `--tan`, `--surface`, `--card`, `--border`, etc.) — same palette and naming convention copy-pasted across files, not shared via an external stylesheet. Match existing token names when adding styles rather than inventing new ones.
- **Fonts**: Google Fonts via `@import` — `DM Serif Display` (headings), `Inter` (body), `JetBrains Mono` (numeric/dose values) on the clinical tool pages; `Cormorant Garamond` on `index.html`'s gate/branding.
- **Data-driven UI pattern** (`library.html`, `calculator.html`, `sop-library.html`): content lives in an inline JS array of plain objects near the top of the `<script>` block (`ENTRIES` in `library.html`, `COMPOUNDS` in `calculator.html`, `SOPS` in `sop-library.html`), then rendered into cards/buttons via `.map(...).join("")` + `innerHTML`, with a search box (`oninput="filter…()"`) and category filter buttons (`onclick="setFilter(...)"`) filtering that in-memory array. Detail views open in a `.modal-overlay`/`.modal` pair built from the same object (`openModal(id)` / `openSOP(id)` / `closeModal()`). To add a new compound/SOP entry, add an object to the relevant array — the rendering functions pick it up automatically as long as the object shape matches its siblings (same keys, e.g. `id`, `name`/`title`, `badge`/`category`, `notes`, `titration`).
- **Calculator logic**: in `calculator.html` and inside `library.html`'s modal, dose-volume math is dispatched on an entry's `type` field (`"botox"`, `"glp"`, `"peptide"`, `"b12"`, `"sermorelin"`, `"ref"` for reference-only/no-calc products) — each type has its own input field set (`buildInputs`) and result field set (`buildResults`)/(`buildCalc` in `library.html`) before `calculate()` runs the actual formula. When adding a new compound type, you generally need to extend all three: the input builder, the result builder, and the calculate switch.
- **No framework**: everything is vanilla JS (`var`, `function`, template strings via `+` concatenation, direct `document.getElementById`/`innerHTML`). Match this style — do not introduce ES modules, a framework, or a bundler for a single-file change.

## Security note

`index.html`'s "password gate" is client-side only (a plaintext string compared in JS, gating visibility via CSS class and `sessionStorage`) — it is obscurity, not real access control; the portal HTML and all linked tool URLs are visible to anyone who views source. Don't present it as, or extend it to be, an actual auth mechanism without flagging that limitation.
