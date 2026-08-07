# Slides to PDF

A Figma plugin to export frames (slides) as PDF — with options to merge, compress, and reorder slides, all inside Figma. No external services, no redirects.

## Features

- Export any frames from the current Figma page as PDF
- Click a **section** to pull in every frame inside it, nested sections included
- Slides are ordered by visual reading order — left-to-right, then top-to-bottom
- Drag to reorder slides before exporting
- Select/deselect individual slides
- Merge all slides into a single PDF
- Compress PDF using object streams
- Everything runs locally inside the plugin — no internet required

## How slides are collected

Selecting a **section** expands it into the frames inside, recursing through
nested sections to any depth. Frames are never descended into — a frame inside a
frame is slide content, not a separate slide. Selecting both a section and a
frame within it won't produce a duplicate page.

Collected slides are sorted into visual reading order rather than layer order.
Rows are banded with a tolerance of half the median slide height, so slides
nudged a few pixels out of alignment still group into the same row. Drag-reorder
always overrides the computed order.

## Export pipeline

Frames are streamed from the sandbox to the UI one at a time, and the next frame
is not exported until the UI has folded the previous one into the output and
acknowledged it. Only a single frame's bytes plus the document being built are
held in memory at once.

This matters for large decks. The previous version expanded every frame's
`Uint8Array` into a plain `number[]` to cross the plugin bridge — roughly a 10x
memory blowup, paid twice — and accumulated every frame before merging any of
them. On a 52 MB, 40-slide test deck that peaked at 788 MB and failed; streaming
brings the same deck to 260 MB. Run `npm run bench` to reproduce.

## Development Setup

**Prerequisites:** Node.js 18+

```bash
npm install
npm run build
```

For live rebuilding while developing:

```bash
npm run watch
```

Checks:

```bash
npm run typecheck   # tsc --noEmit
npm test            # dist freshness + selection expansion + export protocol
npm run bench       # old vs new export memory comparison
```

### `dist/` is committed

Unusually for a JS project, the built output in `dist/` is checked in. `manifest.json`
points at `dist/code.js` and `dist/ui.html`, so committing them is what lets the plugin
be imported straight from a downloaded ZIP with no build step.

The cost is that `dist/` can drift from `src/`. **Any change to `src/` needs
`npm run build` and the rebuilt `dist/` committed alongside it.** `npm test` runs
`test/dist-current.test.js` first, which rebuilds into a temp directory and diffs the
result against what's committed, so a stale `dist/` fails the suite rather than shipping
silently. Note that `npm run watch` produces an unminified build and will also trip the
check — run `npm run build` before committing.

## Loading the Plugin in Figma

No build step needed — `dist/` ships in the repo.

1. Download the repo (**Code → Download ZIP**, or clone it) and extract it
2. Open Figma Desktop
3. Go to **Plugins → Development → Import plugin from manifest**
4. Select the `manifest.json` file from the extracted folder
5. The plugin will appear under **Plugins → Development → Slides to PDF**

### Troubleshooting

**`Unable to load code: ... ENOENT: no such file or directory, lstat '.../dist/code.js'`**

Figma can't find the built plugin. Either `dist/` is missing from your copy, or the
plugin entry in Figma points at a folder you've since moved or deleted. Re-extract the
ZIP, remove the stale entry under **Plugins → Development**, and re-import the manifest
from the folder you actually have. If you're working from a checkout where `dist/` was
deleted, run `npm install && npm run build` to regenerate it.

## Project Structure

```
slidestopdf/
├── manifest.json       # Figma plugin config
├── build.js            # esbuild build script
├── package.json
├── tsconfig.json
├── src/
│   ├── code.ts         # Plugin sandbox code (Figma API, selection + export)
│   ├── ui.ts           # Plugin UI logic (pdf-lib, merge + download)
│   └── ui.html         # UI template
├── test/
│   ├── dist-current.test.js # guards dist/ against drifting from src/
│   ├── selection.test.js   # section expansion, ordering, dedupe
│   ├── export.test.js      # streaming handshake, failure handling
│   └── merge.bench.js      # export memory benchmark
└── dist/               # Built output — COMMITTED, rebuild before committing src changes
    ├── code.js
    └── ui.html
```

## Tech Stack

- [Figma Plugin API](https://www.figma.com/plugin-docs/) — frame export
- [pdf-lib](https://pdf-lib.js.org/) — PDF merging & compression (bundled, no CDN)
- [esbuild](https://esbuild.github.io/) — bundler
- TypeScript
