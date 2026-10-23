# Hyde Image Decomposer

**Implementation specification — version 1.0 (planning baseline)**  
**Depends on:** the **Hyde Agent Authoring SDK and Automation Interface** specification v1.0 and its native authoring/assembly contracts.  
**Hyde reference:** `Bububooo3/Hyde`, pushed `main` at `9dfb386` (2026-10-22); inspect newer local edits before implementation.  
**Status:** independent post-Hyde product specification. Examples are proposed APIs, not current exports.

## 1. Mission and scope

Build a **standalone, local-first, deterministic, non-machine-learning image decomposition application** that transforms stylized 2D reference artwork into a set of meaningful, independently editable Hyde shapes, textured regions and optionally articulated assemblies. The product is tailored to **Hyde Story Studio's real geometry and attachment constraints**, not a generic bitmap-to-SVG converter.

The default workflow is **automatic first-pass reconstruction** followed by optional guided refinement. Two output strategies are available:

1. **Appearance-first:** Maximize perceptual similarity of the original static artwork while retaining genuine editable parts/regions and sensible layering.
2. **Animation-ready:** Prioritize usable logical parts, independently adjustable pieces, concealed boundaries and plausible attachment/pivot placement while retaining strong visual fidelity.

Neither mode generates animation, keyframes, motion clips, pose interpolation or video from reference poses. Additional references improve identification, geometry, front/back coverage and correspondence between parts. A human or an external agent can later author motion through the separate Hyde SDK.

The decomposer works without a hosted backend, external machine-learning model, model weights, cloud inference service or user account. Its processing is reproducible for equivalent inputs/settings/algorithm versions. It MUST be useful through a GUI without any AI agent and scriptable through conventional/agent-controlled APIs.

## 2. Primary product guarantees

1. **Native editability.** Every output should be composed of native Hyde objects—primitives, Bézier paths, shape masks, asset-backed fills and assemblies—with meaningful independent boundaries. A single original-image rectangle is not acceptable as a completed decomposition.
2. **Non-destructive.** Original references, all annotations, segmentation masks, source-to-object mappings, manual overrides and generated geometry are stored independently. Re-rendering/reconstruction never destroys the only copy of a user's work.
3. **Automatic first, guided when needed.** Importing an image produces an inspectable candidate without requiring hand-painted masks first. Users can correct uncertain part boundaries, labels and relationships.
4. **Explicit uncertainty.** An unseen arm section or ambiguous overlap must not be described as faithfully reconstructed. Estimated geometry carries an inference/uncertainty annotation, with inspectable source evidence and optional user approval.
5. **Part identity survives edits.** Renaming, refining, regenerating or relayering a region does not change its logical part ID. Split/merge operations preserve lineage and report conflicts.
6. **No animation fabrication.** Neither multiple pose references nor the animation-ready setting produces keyframes, clips or inferred motion trajectories.
7. **One Hyde implementation.** Native export uses the SDK's typed commands, validation and serializers. The decomposer does not write ad-hoc Hyde archives or simulate its own animation evaluator.
8. **Meaningful decomposition over arbitrary shape count.** Avoid both one-piece raster cheats and thousands of meaningless fragments. Optimize for editable coherent geometry with a visible quality/complexity tradeoff.
9. **Representation honesty.** Vector regions are editable geometry; textured regions may retain raster detail **inside** editable masks. Flag holes, textures, transparency or unseen surfaces that Hyde cannot represent faithfully.
10. **Contained work.** Processing jobs are cancelable and memory-bounded, with progressive previews, deterministic settings and recoverable documents.

## 3. Target and excluded source material

### 3.1 Intended inputs

- Flat-color icons, stickers, logos, sprites, cartoon characters, illustrated props, stylized backgrounds and similar 2D artwork.
- Opaque artwork, transparent PNGs, antialiased edges, limited gradients and bounded textures.
- One primary reference plus optional additional references (different views, poses, crops or details) with user-declared roles.
- Browser-supported raster sources such as PNG, JPEG and WebP. SVG input may be rasterized deterministically for analysis while its original source is retained; separate SVG structure import is optional and must not be assumed to exist in v1.
- Transparent and opaque canvases. When background ambiguity affects segmentation, users can mark foreground/background or provide a mask.

### 3.2 Not guaranteed

- Photorealistic semantic object parsing, anatomical reasoning, exact missing-side reconstruction or automatic naming of semantic body parts.
- Unseen back surfaces, occluded arms or hidden object geometry with no visual evidence.
- Arbitrarily complex overlapping translucent illustrations reproduced with pure vector geometry.
- Fully automatic high-quality decomposition of every image. The product must still give useful region-level edits and explicit failure explanations where information is insufficient.
- Automatic motion, rigging physics, skeleton synthesis, gesture transfer, inbetweening or text-to-image generation.

### 3.3 Mode controls

| Setting | Appearance-first default | Animation-ready default |
| --- | --- | --- |
| Initial region grouping | Fine-to-moderate, preserve visible colors and curves | Coarser logical movable pieces, avoid cutting one limb into many color-only parts |
| Occlusion handling | Reconstruct only where visibly justified | Attempt conservative hidden continuation and expose uncertainty |
| Segmentation preference | Visual boundaries | Silhouettes, articulation boundaries and attachment opportunities |
| Part labels | Generic editable labels, optional manual names | Generic suggested part hierarchy with explicit user confirmation when ambiguous |
| Pivots/constraints | Optional, minimal | Suggested pivots and Fixed/Hinge/Slider attachments |
| Export | Shapes/optional assembly | Native articulated `.hyproj` as primary option |
| Animation generated | **None** | **None** |

The defaults are presets over one shared engine; switching modes must not invalidate locked edits or replace the decomposition document format.

## 4. Architecture and deliverables

The application has independent modules:

```text
Reference import + decoding + canonical image space
        ↓
Image pyramid / color and alpha analysis
        ↓
Candidate segmentation + boundaries + confidence cues
        ↓
Region graph + front/back/occlusion hypotheses
        ↓
Part grouping + cross-reference correspondence (optional)
        ↓
Editable geometry fitting + textures + hidden continuation
        ↓
Guided correction UI + non-destructive regeneration
        ↓
Hyde adapter → SDK dry-run/validate → native .hyproj/.hyde
```

Separate: (a) **source document**, (b) **algorithm-generated candidate graph**, (c) **user annotations and overrides**, (d) **resolved final geometry and assembly mapping**, and (e) **native exported artifact**. The interface may cache derived views and tiles but may not conflate these layers.

Required deliverables:

- Standalone desktop-capable browser application, statically deployable and fully local-first.
- Deterministic reconstruction engine with tests, callable without the React UI.
- Versioned editable decomposition document format, save/open/migrate.
- Assisted segmentation and vector-geometry editor with part/outliner and source comparison.
- Attachment/pivot editor, motion inspection (manual posing/constraint preview only), and native Hyde export.
- SDK/CLI integration for scripted operations and agent orchestration without duplicating the algorithm.
- Curated fixture set, visual metrics, preview comparisons, documentation and offline package/deployment.

The decomposer can be independently deployed while depending on versioned Hyde SDK/core packages. Reuse Hyde's underlying path/attachment helpers in the adapter. Do not require the complete Story Studio editor UI as a dependency of decomposition analysis.

## 5. Editable document format: `.hydecomp`

Choose a dedicated **`.hydecomp`** archive for working documents, separate from native `.hyde` projects and `.hyproj` assemblies. The exact suffix may be changed once before first release; the following data guarantees are fixed.

A `.hydecomp` file is a ZIP-compatible archive with `manifest.json`, binary references under `references/`, compact masks under `masks/`, optional cached thumbnails under `previews/` and path/annotation records in versioned JSON. All paths are archive-relative. Write atomically; validate content on open. This archive is **not** a new Hyde format and is not meant to be opened by Hyde directly.

### 5.1 Logical schema

```ts
interface DecompositionDocumentV1 {
  format: 'hyde-decomposition';
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  algorithmVersion: string;
  mode: 'appearance' | 'animation-ready';
  settings: ReconstructionSettings;
  sources: SourceReference[];
  regions: RegionRecord[];
  parts: PartRecord[];
  correspondences: CorrespondenceRecord[];
  layers: LayerRecord[];
  exportMapping?: HydeExportMapping;
  history?: EditProvenance[];
}
```

**Sources** include stable ID, role (`primary`, `alternate-view`, `alternate-pose`, `detail`, `mask-guide`), original name/MIME/byte hash, dimensions, orientation, color-space interpretation and image-to-primary transform when aligned. Store original bytes, not just thumbnails or base64 strings.

**Regions** include stable ID, source ID, mask asset ID, boundary/path candidates, bounding box, foreground/background classification, color/texture descriptors, confidence *heuristics*, algorithm provenance, generation status, manual edits, lock state, parent/child lineage IDs and assigned part ID.

**Parts** include stable semantic/logical ID (generic names are acceptable), owned region IDs, parent part ID, local coordinate frame, anchor/pivot proposals, optional attachment type and limits, per-part z-order constraints, style/texture grouping, explicit/user-locked transforms and hidden-geometry state.

**Correspondences** express relationships like `same-part`, `possible-match`, `front-back-evidence`, `source-alignment` and user-declared landmarks between source references. Store evidence, alignment transform, manual/automatic origin and ambiguity notes.

**Layers** record ordering constraints, alpha/blending intent, masking relationships, evidence and unresolved conflicts. Do not treat draw order as necessarily identical to anatomical parenthood.

**Generated geometry** consists of editable path/primitives, optional raster fill or texture patches, provenance/source region IDs, normalized path space, user override/lock data, bounding box, quality metrics, inferred/visible designation and emission mapping to Hyde elements. It can be stored within region/part records or in referenced geometry tables, but must remain independently editable from source masks.

**Export mapping** relates part IDs/region IDs/geometry IDs to output Hyde IDs, target SDK/native schema versions, options, warnings and snapshot fingerprints. Regeneration preserving logical identity may intentionally maintain output IDs when updating an existing compatible target assembly.

The manifest must declare and validate all binary member sizes/hashes. Unknown future required fields and unsupported `schemaVersion` are rejected without overwriting the original. Optional unknown fields are preserved if safely round-trippable. Derived caches can be rebuilt and need not be kept in every archive.

### 5.2 Immutable originals and provenance

Original reference bytes remain immutable. New annotations and geometry versions are appendable or undoable. Manual correction is a first-class operation, not a temporary editor overlay. Each generated shape has provenance to source evidence or a clearly labeled inferred continuation. A user's manually corrected path is never silently overwritten by a global preset change.

## 6. Image coordinate and compositing contract

- Source-image coordinates use oriented image pixels, origin at top-left and +Y downward. Source annotation tools may expose normalized `(x/width, y/height)` for resolution independence, but all stored pixel masks have an exact source resolution and transform.
- Canonical primary-reference space is specified once per working document. Each alternate source has its own transform and potentially nonrigid manual landmarks; do not assume distinct poses admit one global affine alignment.
- Generated part coordinates use a declared per-part local bounding box and pivot. The Hyde adapter converts to `StoryElement.width/height`, `x/y`, `pivotX/pivotY`, and normalized `ShapePath` handles using actual Hyde semantics.
- Rotation units: degrees in exported Hyde, pixel coordinates for source analysis. Transform order is derived from `src/shapePath.ts` and the real evaluator, not invented for this app.
- Color parsing follows normalized sRGB for comparison and explicit premultiplied/unpremultiplied alpha handling in compositing. Track source color profiles or warn when not supported; don't silently compare gamma-encoded pixel values as linear light for quality metrics.
- Ordering uses a directed *front-of* graph where unambiguous; conflicting cycles are diagnosed and can be resolved manually. This is separate from the parent attachment tree.
- Source-reference holes, antialiasing and partial transparency are represented in masks and source comparison even when the native output must use an approximation.

## 7. Deterministic reconstruction pipeline

### Stage 0: Import, orient and preserve

Decode supported formats, apply orientation and color handling, preserve original bytes, compute checksum, dimensions and alpha statistics, and reject corrupted or oversized sources with useful diagnostics. Identify hard foreground alpha where available; if opaque, estimate likely background using connected border regions and expose user correction. Produce a pyramid of tiles/thumbnails for interactive processing without requiring the full image at display zoom.

External SVG rasterization MUST be treated as untrusted media; disable unwanted remote references and script execution. Do not fetch externally referenced images/fonts without user action. Decoding settings and resulting canonical pixel interpretation must be reproducible.

### Stage 1: Feature evidence extraction

Compute local deterministic image features: alpha transitions, color differences, luminance gradients, boundaries, connected components, enclosed areas, candidate thin lines, strong edges and interior texture variation. Detect likely broad color fields using controlled quantization and adjacency, without pretrained classifiers or trained descriptors. If smoothing is used, retain original pixel data and record scale/parameters. Multiple scales are necessary to avoid treating every texture grain as a part boundary.

Feature maps must include confidence *reasons*: e.g. boundary supported by alpha discontinuity, high local color contrast or repeated contour evidence. Do not represent these as ML probabilities.

### Stage 2: Initial segmentation and region graph

Produce a deterministic oversegmentation from edge-preserving connected components, optional superpixel-like partitioning and region-adjacency analysis. Use explicit graph objectives and controlled merging to generate a hierarchy of candidates. Suggested methods include connected-component labeling, seeded flood-fill, watershed where appropriate, graph cuts for user seeds, and deterministic boundary-aware merging; the implementer may choose among these based on measured results without changing the contract.

Construct a graph with regions as nodes and shared boundaries, overlap/occlusion evidence, similarity and candidate common-part membership as edges. Merge tiny noise islands selectively, preserving semantically meaningful separated highlights or outlines if requested. Allow both split and merge proposals; never assert that one segmentation granularity is universally correct.

Automatically produce **more than a full-image patch** whenever actual segmentation evidence supports it. If only one contiguous graphic primitive exists, one **genuine fitted shape** can be correct; it is not acceptable to call a single unmodified image rectangle a decomposition. If the reference cannot be meaningfully decomposed, return `INSUFFICIENT_STRUCTURE` with preserved source and guided next actions rather than fabricating random components.

### Stage 3: Foreground/background and visible-region topology

Find visible silhouettes, nested color islands, contours, holes and disconnected components with hierarchy. Track transparent regions separately from opaque background-colored pixels. Identify outlines that belong to a larger part versus colored pieces that warrant independent regions; preserve uncertainty. A closed region may have multiple contours internally even if Hyde's current `ShapePath` supports only one simple closed contour per native shape.

Use thin-stroke preservation and size-aware cleanup, and avoid moving boundaries in ways that create obvious halos or cutouts. Retain source mask as reference evidence even if it is later vectorized.

### Stage 4: Layer order and occlusion analysis

Infer candidate front/back relations from T-junctions, contour termination, enclosed silhouettes, texture continuity, shading and multi-reference coverage. These are **heuristics**, not semantic vision. Record edge confidence and conflicts rather than force global ordering when evidence is contradictory.

Where one piece is visibly occluded, reconstruct only a plausible hidden continuation using controlled contour extrapolation, interpolation, bilateral symmetry where supported, or locally sampled texture continuation. Every inferred hidden portion must be clearly marked `inferred`, separately editable, and suppressible. Preserve visible pixels as fixed constraints: generating hidden geometry must not alter the visible silhouette of the original when assembled in the source pose.

Do not treat deterministic fill/inpainting as ground truth. If a complex hidden texture cannot be recovered, prefer a transparent/neutral extension or a constrained texture patch flagged for user correction over invented confident-looking detail.

### Stage 5: Vector fitting and texture selection

For each region or grouped part:

1. Trace boundary from the original mask (e.g. marching squares) using antialias-aware subpixel evidence where available.
2. Simplify closed contours with error-bounded point reduction, preserving corners and high-curvature changes.
3. Fit line segments and cubic Bézier curves with bounded geometric/pixel error; favor primitives (rectangle/ellipse/polygon) only if their image-space fit is sufficiently close.
4. Detect self-intersections, extremely thin triangles, degenerate handles, and pathological point counts; repair or subdivide when possible. Respect Hyde's present `shapePath` constraints (one closed contour and a bounded point count—currently 3–4096).
5. Choose native fills for simple flat/color-gradient approximation where faithfully representable; otherwise generate a cropped raster texture containing authentic source detail, clipped by the editable region mask/path.
6. Record residual edge/color error and complexity, and expose an appearance/complexity slider without fabricating unsupported native effects.

**Vector-first where meaningful, hybrid-vector/raster where necessary.** A raster texture inside a fitted editable mask is a legitimate editable component. A single unsplit original raster stretched over a scene-sized rectangle is not.

### Stage 6: Logical part grouping

Regions are **not** automatically the same as animation parts. Combine regions into parts using continuity of a shared outline, local material/texture coherence, compactness, symmetry, visual connection, and cross-reference correspondence. Allow one part to comprise many regions and one region to split across parts.

Generate generic, stable names (`Part 01`, `Part 02`, `Region 03`) rather than pretending to semantically recognize anatomy without ML. User/agent annotations may rename `Left arm`, `Upper jaw`, etc. Candidate movable-part boundaries may be suggested by narrow joints, contact points, repeated outline direction or alternate-reference changes; low-confidence cases remain unassigned rather than asserting a false rig.

### Stage 7: Optional multiple-reference correspondence

Each source reference is segmented in its own image coordinates. Match candidate regions/parts using deterministic shape, boundary, color, adjacency, landmarks and explicit manually declared correspondence. Distinguish:

- Same logical part seen in a different location/pose.
- Same part viewed from another angle (may require distinct visible regions; do not pretend one 2D path explains all views).
- Different part with similar color/shape.
- A detail/crop supplementing primary geometry.

Resolve unambiguous matches automatically; offer a small ranked list with evidence for uncertain matches. Allow the user to confirm, reject, split or merge cross-reference mappings. Additional views can improve hidden contour inference, z-order and pivot/contact estimates. They **must not** generate pose timelines, inferred velocities or animation clips.

Maintain a canonical primary assembly construction pose (usually the first designated primary image), with additional references used as evidence. Alternative reference poses are not baked as keyframes. The user can manually inspect poses/constraints without saving animation clips.

### Stage 8: Attachment graph and pivots (animation-ready)

Build a proposed logical hierarchy for part assembly, separate from layer order. Prefer one clearly identified root; if no obvious root exists, create a neutral parent group or request a user-defined root. Each part may have **at most one** parent and no cycles, reflecting Hyde's supported attachment system.

Candidates:

- **Fixed** for pieces expected to remain rigidly bound.
- **Hinge** for rotation at a localized contact or pivot.
- **Slider** for apparent linear motion along a supported axis.

Use local boundary proximity, limb overlap, narrow connection/hinge cues and source-visible articulation to suggest anchor locations. Pivots should be consistent with Hyde's existing normalized pivot convention. Default to Fixed or unattached when evidence cannot justify a particular joint; expose warnings and manual adjustment rather than manufacturing elaborate rigs.

Joint limits inferred from a single image are generally uncertain. Use conservative editable defaults; only claim evidence-based limits when an image/reference explicitly supports them. `min`/`max` must mean exactly what Hyde's actual evaluator and editor mean for hinge/slider types.

Motion inspection UI MAY allow drag/rotate/slide in a temporary preview state to check shape continuity and constraints. **No saved keyframes, animation clips or generated pose sequences** result from that inspection unless the user later uses Hyde itself to author them.

### Stage 9: Global reconciliation and quality analysis

Reassemble the projected layers and render a reference pose using the actual Hyde renderer where available. Compare the reconstructed image against the primary source using multiple metrics: alpha/silhouette overlap, distance between boundaries, color/texture reconstruction error, visible uncovered regions and region complexity. Treat perceptual similarity plus user editability as competing objectives, not a single score to game.

Offer a diagnostic overlay for excess residual pixels, halos, mismatched contours, overlap errors and occlusion contradictions. Explain why a region is raster-backed or inferred. If required resolution/format limitations cannot be met, produce an explicit conversion warning and recommended manual correction.

Do not optimize quality solely by adding hundreds of invisible parts or flattening everything; penalize meaningless segmentation, redundant tiny shapes and giant source-image patches.

## 8. Quality and complexity objective

Use a documented optimization objective to rank candidates, with user-facing controls rather than hidden magic thresholds. A representative form is:

```text
Score = appearanceError
      + λedge * silhouetteBoundaryError
      + λparts * needlessPartFragmentation
      + λpaths * pathControlComplexity
      + λseams * visibleSeamArtifacts
      + λuncertain * unsupportedOcclusionInferences
      + λflat * uneditableFlatteningPenalty
```

Default weights differ by mode. For animation-ready, increase the penalty for splitting one logical part and reward independently usable candidate parts; for appearance-first, weight fidelity and outlines more strongly. Constraints on full-image-patch shortcuts are **hard rules**, not just small weighted penalties.

No initial numerical quality thresholds are frozen before testing on representative stylized-art fixtures. Benchmarks will establish useful tolerances; acceptance requires transparent evidence and visual comparisons, not a universal unsupported “95% fidelity” claim.

## 9. Guided correction UI

The GUI must support automatic reconstruction as a **starting point** and expose all critical manual interventions without forcing the user to rebuild from scratch.

### 9.1 Workspace layout

- Main canvas toggles original, reconstruction, side-by-side and adjustable alpha overlay, with pixel-perfect zoom/pan and optional region/part isolation.
- Left pane: source references, their roles, alignments and image metadata; region/part tree with search, layer order, locks, unresolved issue badges and source correspondence.
- Right pane: selected region/part settings (boundary, mask, geometry, fill, pivot, parent/joint, quality, lock and confidence details).
- Bottom pane: processing status, comparison/quality overlays, undo history and optional preview of assembly manipulation—not an animation timeline.
- Progressive preview while analysis completes; no full UI freeze during compute-heavy stages.

### 9.2 Required editing tools

| Tool | Required behavior |
| --- | --- |
| Add/subtract mask brush | Editable feather/hardness, paint in source pixels, undoable strokes |
| Foreground/background seed | Rerun constrained segmentation locally or globally with deterministic result |
| Boundary/path editor | Move/add/remove anchors and Bézier handles; snap to source edges; lock manual contour |
| Split region | Geometric cut/seed split, new IDs and lineage, preserve unaffected annotations |
| Merge regions | Combine masks/path candidates, record source IDs, detect conflicting part assignments |
| Assign region to part | Group/ungroup without discarding original region segmentation |
| Reorder layers | Explicit front/back constraints and visible conflict warnings |
| Pair references | User confirms/rejects candidate cross-reference matches, edits alignment landmarks |
| Pivot and attachment editor | Stage drag plus numeric normalized/pixel coordinates, fixed/hinge/slider, limits |
| Hidden-area editor | Inspect, mask, reshape or suppress inferred occluded continuation |
| Lock/unlock | Preserve manual mask, geometry, part assignment, transform, pivot and attachment independently |
| Regenerate selected | Apply revised algorithm settings to only selected unlocked regions/parts |
| Inspect geometry | Toggle native-shape outline, raster texture, mask residuals, inferred regions and Hyde export warnings |
| Undo/redo | Complete non-destructive changes with coalesced strokes and stable IDs |

Every automatic suggestion must be accept/rejectable and must not invalidate unrelated manual edits. A “reset generated candidate” action resets only generated data, with explicit confirmation if it would discard accepted manual overrides.

### 9.3 Reconstruction controls

- Mode (appearance-first / animation-ready).
- Segmentation granularity and edge sensitivity.
- Vector fidelity/tolerance vs control-point count.
- Preserve texture/gradient vs prefer flat fill.
- Minimum feature scale and optional thin-line preservation.
- Hidden-contour conservatism; inferred geometry on/off.
- Automatic region grouping strength and joint proposal conservatism.
- Diagnostics overlay visibility and stage/background preview.

Changes should preview quickly on lower-resolution data where possible; final export uses full retained source evidence. Settings remain fully recorded in `.hydecomp`.

## 10. Non-destructive regeneration and editing semantics

The document tracks generated and user-authored geometry separately. All rebuilds are **planned updates** with an impact preview before applying affected locks/conflicts.

| Change | Mandatory result |
| --- | --- |
| Rerun entire automatic first pass | Preserve immutable source; keep all locked overrides; show remapping of changed candidate IDs |
| Refine region mask | Preserve region ID and assigned logical part |
| Refine region path | Preserve custom handles/locks during unrelated recalculation |
| Split region | New child region IDs and lineage, old ID becomes historical/parent entry; report any ambiguous part mapping |
| Merge regions | New or designated surviving region ID with lineage to sources; preserve nonconflicting metadata |
| Change part label | Does not regenerate geometry or invalidate references |
| Change pivot or joint type | Does not automatically regenerate pixel segmentation |
| Change fidelity preset | Regenerate unlocked candidates, never silently replace locked contours/parts |
| Change primary reference | Requires explicit remapping/migration preview; never silently discard correspondence |
| Export to an existing Hyde assembly | Prefer stable mapping for compatible surviving parts; make destructive replacements explicit |

Use dependency invalidation: edited mask affects its boundary/shape and impacted local layer relations, not every unrelated region. Distinguish transaction history/undo from auto-generated algorithm provenance. On canceled regeneration, keep last complete candidate available.

## 11. Native Hyde adapter and export contract

### 11.1 Assembly conversion

For every final logical part:

1. Create a native Hyde group/parent where necessary with stable output identity mapping.
2. Convert fitted geometry to native `rectangle`, `ellipse`, `polygon` or a shape with `ShapePath` normalized to each element's width/height. Honor Hyde's existing shape point and bounds validation.
3. Attach corresponding source-authentic raster crops as media/texture fills **inside** region masks when vector fill alone is insufficient. Package all needed image assets.
4. Preserve z-order and internal relationships distinctly from attachment parenting.
5. Convert approved pivots, parent IDs and Fixed/Hinge/Slider relationships using existing `Attachment` and transform contracts; reject cycles and invalid limits.
6. Set useful editable names/parts/organization and render hints (`auto` unless there is evidence to select another).
7. Do **not** insert keyframes, reusable animation clips, motion behaviors or synthetic audio unless the user separately requested them in a different authoring workflow.
8. Submit conversion as an SDK transaction, inspect warnings and **dry-run validation**, then export using canonical native serializer.

Outputs:

- **`.hyproj`**: complete editable assembled object with art and dependencies; main animation-ready deliverable.
- **`.hyde`** (or `.hy`): complete project placing the constructed artwork/assembly on a stage with user-chosen dimensions, scene timing and optional source comparison background (not a flattened substitute).
- **`.hydecomp`**: editable working source document preserving references, masks, annotations, region/part identities and regeneration settings.
- **Optional** ordinary image/SVG previews or visual diagnostic report—non-authoritative artifacts.

Hyde output is self-contained and editable without the decomposer. The decomposer working document is the only guaranteed way to reconstruct original annotations/generation history. If the user wants provenance packaged alongside delivery, provide a bundle containing **both** `.hydecomp` and `.hyproj` rather than inventing undocumented fields inside Hyde archives.

### 11.2 Compatibility constraints

- Current Hyde `ShapePath` is one closed cubic contour. Multiple components, holes or compound paths require multiple supported shapes/masks or an explicitly agreed backward-compatible model extension. Never silently delete holes or falsely label a flattened bitmap as faithful vector geometry.
- A path exceeding native point limits must be refit/split or rejected with a clear error; no malformed archive.
- Because `Attachment` currently describes type, parent and limits, do not export custom rigid-body/multi-bone metadata as though Hyde understands it.
- The adapter must obey Hyde's scene/element local timing and transform conventions; test neutral construction pose against the real renderer, not a lookalike canvas drawing.
- If textures depend on external source images, archive them as native embedded assets. The final project must work offline even if original local files are later moved.
- If a required effect cannot be represented by the deployed Hyde version, present an export-impact summary and require an explicit compatible approximation or fail safely.

## 12. Programming and agent-facing API

The engine is callable without UI. Suggested interface:

```ts
interface DecomposerEngine {
  importSources(inputs: SourceInput[], options?: ImportOptions): Promise<DecompositionSession>;
}
interface DecompositionSession {
  readonly revision: number;
  capabilities(): DecomposerCapabilities;
  analyze(options?: { mode?: 'appearance'|'animation-ready'; signal?: AbortSignal }): Promise<JobHandle>;
  inspect(query: DecompositionInspectQuery): Promise<DecompositionInspectResult>;
  execute(request: DecompositionEditBatch): Promise<EditResult>;
  compare(options?: CompareOptions): Promise<QualityReport>;
  saveDocument(): Promise<Uint8Array>;                    // .hydecomp
  exportHyde(options: HydeExportOptions): Promise<Uint8Array>; // .hyproj or .hyde through SDK
  close(): Promise<void>;
}
```

`execute` is revision-checked and transactional, with operations such as `region.refineMask`, `region.split`, `region.merge`, `region.setPath`, `part.create`, `part.assignRegion`, `part.reparent`, `part.setPivot`, `part.setAttachment`, `layer.reorder`, `reference.add`, `reference.correspond`, `annotation.lock`, `regenerate.selected`. Binary masks and images pass through handles rather than JSON base64.

`inspect` supports source IDs, part/region tree, bounding boxes, masks, detected contours, uncertain matches, quality metrics, current image tile renders and export warnings. It offers bounded JSON so an external agent can inspect targeted areas without consuming massive context.

**Agent workflow:** analyze → inspect uncertainty/regions → request focused diagnostic tiles → apply targeted corrections → preview constraints → dry-run native export → render native assembly in Hyde → revise if warranted → save `.hydecomp` and `.hyproj`. Agents use the same deterministic algorithms and explicit operations as human users; the application does not contain an independent LLM.

### 12.1 CLI

Optional but part of scriptability deliverable: `hyde-decompose import/analyze/inspect/edit/compare/export` with JSON request/response flags and file outputs. No implicit network activity, raw image data on stdout or uncontrolled file overwrite. GUI may run entirely in a web browser; CLI may use Node and a headless browser host where actual Hyde preview is requested.

## 13. Diagnostics and uncertainty

Structured diagnostic codes include:

- `UNSUPPORTED_SOURCE`, `IMAGE_TOO_LARGE`, `DECODE_FAILURE`, `COLOR_SPACE_WARNING`.
- `BACKGROUND_AMBIGUOUS`, `INSUFFICIENT_STRUCTURE`, `LOW_CONTRAST_BOUNDARY`, `AMBIGUOUS_REGION`.
- `CORRESPONDENCE_AMBIGUOUS`, `LAYER_CONFLICT`, `OCCLUSION_UNDERCONSTRAINED`, `HIDDEN_GEOMETRY_INFERRED`.
- `PATH_SELF_INTERSECTS`, `PATH_TOO_COMPLEX`, `HOLE_NOT_REPRESENTABLE`, `TEXTURE_APPROXIMATION`.
- `PART_PARENT_CYCLE`, `INVALID_JOINT_LIMIT`, `UNSUPPORTED_NATIVE_FEATURE`, `EXPORT_VALIDATION_FAILED`.
- `DOCUMENT_VERSION_UNSUPPORTED`, `DOCUMENT_CONFLICT`, `CANCELED`, `RESOURCE_LIMIT`.

Diagnostics include region/part/source ID, affected bounding box, severity, explanation, recommended correction and optionally quality impact. A heuristic confidence indicator MUST disclose its nature (supporting evidence, not calibrated statistical certainty). Export previews should show impacted pixels for unresolved fidelity issues.

## 14. Performance, determinism and resilience

- Use deterministic tie-breaking, seeded stochastic techniques only when a seed is explicitly stored, and versioned algorithms/settings. Document browser-dependent raster decode/color differences; identical input bytes + settings + engine version should yield reproducible structure within documented numeric tolerance.
- Processing stages run in web workers or worker threads where appropriate, with visible progress, cancellable jobs and bounded in-flight tiles/buffers. Avoid large synchronous main-thread segmentation passes.
- Use coarse image pyramids for initial interactions, then source-resolution masks and localized refinement. Do not permanently discard original pixels to reduce memory.
- Defer concrete maximum image dimensions and latency targets until representative benchmarks; enforce configurable safe resource limits with graceful diagnostic failures.
- Persist/checkpoint only complete document states. On cancellation/crash, preserve last committed annotation state and last valid generated candidate; rollback temporary assets.
- Cap excessive path point growth and tiny-region generation using complexity budgets justified by fixture results.
- Never allow large source images to be sent through agent text interfaces as embedded base64 by default.
- Maintain local-only processing; no CDN/inference calls. If bundled dependencies or fonts are used, ensure the deployed app remains genuinely offline-capable for its core workflows.

## 15. Fixture suite and objective acceptance

### 15.1 Representative fixtures

Keep a curated dataset with source images and manually judged expected decomposition *qualities*, not necessarily one exact ground-truth segmentation:

1. Transparent flat-color icon with one true geometric shape (tests honest one-part exception).
2. Multicolor cartoon prop with outlines and overlapping panels.
3. Stylized character with separated head, torso, arms and legs and visible pivots.
4. Partially occluded articulated character with hidden-region uncertainty.
5. Sticker with complex antialiasing, gradients and texture.
6. Shape with transparent holes and disconnected colored islands.
7. Multiple reference images showing a different pose/view of common parts.
8. Symmetric repetitive parts and ambiguous identity matches.
9. Small low-resolution pixel art with sharp edges and no unintended smoothing.
10. Busy/detailed or nearly photographic input outside target: return useful partial result or explicit insufficiency, not fake success.
11. Malformed input, huge dimensions, corrupt archive and adversarial SVG/path complexity.

Ensure fixtures do not rely on copyrighted assets without appropriate rights; generated/public-domain/user-licensed references are suitable.

### 15.2 Required automated checks

- Deterministic analysis on all fixtures, with stable region/part IDs or explicit stable remap rules across identical runs.
- Source and decomposition-document round trip preserves original bytes, masks, correspondence, user edits, locks, inferred geometry and lineage.
- Initial automatic output includes genuinely distinct editable geometry where the source warrants it; rejects full-image rectangle-as-decomposition cheats. A true simple single-contour icon may remain one editable path.
- Representative silhouette/edge/color comparisons and path complexity budgets; no arbitrary universal 100% reconstruction guarantee.
- Split/merge, mask strokes, path edits, locks and selected regeneration preserve unrelated part IDs/geometry and undo correctly.
- Multi-reference matching respects manual correspondences and does not invent animation or transform disparate poses as if identical.
- Layer/attachment graphs reject cycles, enforce one parent and faithfully preserve visible primary image pose.
- Occluded/inferred geometry is separately marked, editable and user-controllable.
- For all valid supported fixtures, SDK dry-run passes; `.hyproj` imports into Hyde and remains editable, and `.hyde` opens as a standalone editable project.
- Actual Hyde screenshot of native assembly at reference pose compared with decomposer preview and source within documented relevant tolerances.
- After rebuilding/regenerating, manually pinned pivots, locked region geometry and approved joint limits survive.
- All export artifacts package necessary textures/assets and open without original source-directory access or a backend.
- Browser cancellation, worker cleanup, bad images, memory limits and interrupted `.hydecomp` writes leave prior recoverable document intact.

### 15.3 Subjective review (bounded)

Prepare at most three curated comparisons for the owner: (a) appearance-first original vs exported Hyde render, (b) animation-ready part isolation plus manual joint movement, (c) multi-reference ambiguous regions and manually corrected mapping. The review judges **part usefulness and visual quality**, not auto-generated movement.

### 15.4 Completion threshold

The product is ready when automatic first pass, guided annotation, region/part editing, non-destructive regeneration, optional reference correspondence and native Hyde export operate end to end with a representative fixture suite and honest limitation diagnostics. It is not necessary to eliminate every ambiguous reference scenario, solve photorealistic understanding or exhaustively benchmark every resolution.

## 16. Implementation workstreams (dependency-led)

**A. Document and engine foundation.** Implement `.hydecomp` schema/codec, source decoding, pyramid/mask representation, region graph and deterministic segmentation. Save/open and cancellation first; avoid implementing UI-specific image algorithms.

**B. Reconstruction and geometry.** Boundary extraction, region merging, primitive/Bézier fitting, texture residual handling, occlusion heuristics and measurable previews. Reject trivial flattening at the quality/representation layer.

**C. Guided editing.** Mask/seed tools, path editor, region/part hierarchy, source alignment, correspondence, locks, lineage, undo and incremental regeneration. Begin with a minimal usable vertical slice but retain the full product scope.

**D. Animation-ready assemblies.** Part hierarchy, pivot and Fixed/Hinge/Slider suggestions, manual constraint inspection, occluded geometry continuation. Keep motion/keyframe generation explicitly out of this workstream.

**E. SDK adapter and round trips.** Typed command generation, dry-run, native geometry/asset conversion, `.hyproj`/`.hyde` export, Hyde render comparison, restore-and-edit compatibility.

**F. Quality/release.** Curated fixtures, user-oriented diagnostics, agent/CLI APIs, performance/resource tests, offline static deployment, concise documentation, owner comparisons.

Independent stages can proceed in parallel once their contracts and source/identity semantics are fixed. Prefer integration slices that reconstruct a source, allow a human edit and export native Hyde rather than months of isolated segmentation research.

## 17. Explicit non-goals and rejection criteria

- No neural networks, pre-trained segmentation/vision models, external inference API, LLM interpretation, learned classifiers or model-based inpainting inside the reconstruction engine.
- No synthesized keyframes, rig movement, pose generation, motion clips or reconstructed animations from input reference poses.
- No scene-wide full-resolution bitmap treated as the only decomposition output.
- No forced arbitrary part splits solely to achieve a shape-count target.
- No silent loss of masks, source images, manually corrected geometry, hole topology or project IDs.
- No irreversible baked-art workflow in place of editable parts.
- No general full-3D inference, physics, advanced skeletal animation or photorealistic restoration.
- No duplicate Hyde serializer/evaluator, remote Hyde storage, mandatory account or backend.
- No claims of exact occluded reconstruction when underlying input does not contain that information.

## 18. Definition of done

A user can import one or more stylized references, receive a genuinely decomposed automatic result, refine masks and parts, inspect/adjust layers and pivots, save/reopen a `.hydecomp` source document without losing their corrections, and export a native editable `.hyproj` (and optionally `.hyde`) that opens and renders correctly in Story Studio. The algorithm is deterministic and entirely non-ML. An agent can drive the same operations through structured APIs without relying on brittle UI automation. Native outputs never contain invented animation, and ambiguous/missing geometry is explicitly disclosed rather than fabricated as certainty.
