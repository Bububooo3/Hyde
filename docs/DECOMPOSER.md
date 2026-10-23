# Hyde Image Decomposer

The standalone application starts with `npm run decomposer:build` and `npx vite preview --config vite.decomposer.config.ts`. It runs locally, uses a worker for deterministic image analysis, and needs no account, model weights or hosted service. Open `decomposer.html` in the preview server, import PNG/JPEG/WebP references, analyze, correct regions and parts, compare the actual Hyde render, and save the recoverable `.hydecomp` working document. Native `.hyde` projects and `.hyproj` assemblies are emitted through Hyde's SDK command transactions and archive codec.

## Scriptable workflow

`src/decomposer/index.ts` exports `DecompositionSession` for conventional TypeScript callers. `importSources`, `analyze`, `inspect`, `execute`, `compare`, `saveDocument`, `openDocument`, `exportHyde` and `close` use the same model as the GUI. Edits have an `expectedRevision`, commit atomically, and support dry-run. Binary masks are staged through handles. The source byte and decoded-pixel getters return copies.

The `hyde-decompose` executable is built at `dist/decomposer-cli/hyde-decompose.mjs`. It writes JSON to stdout and binary artifacts only to explicit paths. Existing destinations are refused unless `--overwrite` is given; replacement retains a `.bak` sibling.

```sh
node dist/decomposer-cli/hyde-decompose.mjs import --source art.png --output art.hydecomp --json
node dist/decomposer-cli/hyde-decompose.mjs analyze art.hydecomp --output art.hydecomp --overwrite --mode animation-ready --json
node dist/decomposer-cli/hyde-decompose.mjs inspect art.hydecomp --target regions --limit 25 --json
node dist/decomposer-cli/hyde-decompose.mjs compare art.hydecomp --native --overlay residual.png --json
node dist/decomposer-cli/hyde-decompose.mjs export art.hydecomp --format hyproj --output art.hyproj --json
```

For multiple references, `import --request manifest.json` accepts `{ "name": "Art", "mode": "appearance", "sources": [{ "path": "primary.png", "role": "primary" }, { "path": "side.png", "role": "alternate-view" }] }`. `edit --request edits.json` accepts `{ "expectedRevision": 1, "edits": [{ "op": "part.rename", "partId": "...", "name": "Arm" }] }`. An optional `masks` array supplies raw binary 0/1 files with `name`, `path`, `width` and `height`, plus optional `alphaPath` containing 0–255 coverage within the binary mask; a `region.refineMask` edit refers to that name as its handle. `compare --native` builds a neutral-pose `.hyde` candidate and renders through Hyde's private offline Chromium host. Its JSON omits the binary residual overlay; `--overlay` saves it separately.

## Source and quality contract

The `.hydecomp` ZIP stores exact original bytes, canonical decoded RGBA, masks, geometry, user edits, locks, lineage and correspondence with member hashes. PNG decoding is shared by Node and browser; JPEG/WebP use the browser decoder, with canonical pixels persisted so a reopened document is stable. SVG import is currently unsupported. Each reference is analyzed separately; alternate poses remain evidence and never become motion keys or clips.

Appearance-first and animation-ready use the same region graph with different deterministic settings. Connected color/alpha regions become separate editable paths; broad shared boundaries can group multiple paint regions into one logical part. Authentic source crops back textured paths. A transparent hole in a single path needs explicit `allowHoleApproximation` approval, and the loss of inner vector topology is warned about. Very busy images that yield mostly tiny fragments are reported as insufficient structure and require guided correction before native export.

The native comparison reports thresholded silhouette IoU, boundary distance, overlap sRGB error, missing/extra/halo pixels and structural complexity. It compares canonical source pixels with an actual Hyde browser-rendered PNG at source resolution and writes a colored residual overlay. This is objective pixel evidence, not a claim of subjective part usefulness. Synthetic rights-clear fixtures and measured boundaries are in `tests/decomposer-synthetic-acceptance.md`; the acceptance inventory is in `docs/ACCEPTANCE.md`.

Current guided tools include mask brushes with editable radius and hardness, bounded color/edge-aware foreground/background seeds, editable path anchors and Bézier handles with optional edge snap, source zoom/pan, region split/merge, part assignment/rename/pivot/reparent/attachment, front/back relations, paired landmarks and source alignment, locks, regeneration and undo/redo. Soft brush coverage is stored per pixel beside binary contour topology in `.hydecomp` and survives undo/reopen; Hyde native export places that coverage in texture alpha within the editable shape. Animation-ready analysis proposes a conservative two-pixel-inset hidden continuation only under a fully opaque enclosed foreground; each inferred path remains editable, visibly uncertain and individually suppressible/restorable without losing source evidence. Multi-reference matching ranks contour, color, size, neighborhood and optional declared alignment, preserves manual decisions, and leaves close alternatives unresolved. Animation-ready analysis also offers unapproved Fixed/Hinge parent and contact-pivot proposals when visible parts touch. The part inspector shows the evidence and accepts or rejects each suggestion; accepted attachments persist through `.hydecomp` reopen and native export. A single still cannot establish joint type or motion limits, so these remain reviewable heuristics and generate no motion.

Soft coverage is constrained to the editable binary contour; the native path clips outward feathering. Hyde's single native path cannot represent an interior hole as vector topology, so holes require explicit raster-alpha approximation approval. The enclosed-overlap rule does not recover general unseen surfaces or complex textures. Contact-based proposals do not infer Slider motion or joint limits, and temporary posing/constraint preview remains open. Broader visual-quality fixtures and bounded owner visual review also remain open.
