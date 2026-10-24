# Hyde Agent Authoring SDK and Automation Interface

**Implementation specification — version 1.0 (planning baseline)**  
**Depends on:** Hyde Story Studio's completed authoring model and native archive implementation.  
**Repository audited:** `Bububooo3/Hyde`, pushed `main` at `9dfb386` (2026-10-22). Later local changes must be inspected before coding.  
**Status:** specification; API examples are proposed, not implemented Hyde exports.

## 1. Mission and acceptance statement

Enable a program—including an AI agent—to build, inspect, validate, revise, preview, and export fully editable native Hyde stories and assemblies, without using brittle UI clicks for routine authoring. A project written by the SDK must remain indistinguishable, in validity and editability, from a project authored in the Hyde editor. The SDK is **not** a generative model, hosted service, second renderer, independent archive implementation, or excuse to narrow Hyde's feature set.

A successful first release allows a client to (a) construct an animated, textured, multi-scene story; (b) import source media and assemblies; (c) inspect and revise selected objects; (d) save `.hyde` and `.hyproj`; (e) open its output in the editor without loss; (f) obtain true Hyde previews and supported exports through a browser host; and (g) edit the same live project through an explicitly enabled bridge with undoable changes.

### Normative language

**MUST** is required for acceptance; **SHOULD** is a preferred design with a documented alternative allowed; **MAY** is optional. Commands and TypeScript examples show a proposed public contract. Final implementation names may change to match extracted Hyde functions, but observable behavior must remain.

## 2. Non-negotiable invariants

1. **One source of creative truth.** Hyde's current `Project`, `Assembly`, `StoryElement`, `Sequence`, `Asset`, `Track`, `Attachment`, and archive semantics remain authoritative. No second canonical authoring schema or duplicated scene evaluator.
2. **One validation authority.** Extract/reuse archive and model validation from Hyde. Each command validates preconditions; every committed project passes full integrity validation. Never weaken validation to make agent output pass.
3. **No silent flattening.** Programmatic content remains editable in the same form as hand-authored content. Rasterization, baking or conversion is explicit and reported; playback/export artifacts do not substitute for native projects.
4. **Transactions over ad-hoc mutation.** Public mutation operations use atomic commands and revision-checked batches. One accepted batch is one logical undo action in the editor.
5. **Local-first.** Headless authoring and archive operations work offline. Rendering/export may require a local browser, but never requires a Hyde server/account. No implicit telemetry, external network calls, GitHub pushes or publication.
6. **Actual-engine inspection.** Pixel/audio preview and media export use Hyde's browser-backed renderer/evaluator/audio/export stack, not a simplified clone.
7. **Safe incompatibility.** Unknown future required semantics or unsupported schema versions must generate explicit errors; never silently remove unsupported features on round-trip.
8. **Conservation of user work.** Invalid commands, failed imports, canceled jobs, rejected migrations and revision conflicts must not corrupt the last committed project or its underlying assets.
9. **Broad creative coverage.** The SDK covers every important authorable feature in the finished `PLAN.md`, including the advanced combinations; it is not limited to rectangles, keyframes and a minimal demo.
10. **Agent efficiency.** Offer narrow queries, selection, pagination, revision deltas, binary handles and structured diagnostics; never require agents to print full base64 media or entire projects to inspect small changes.

## 3. Grounding in the current Hyde code

These are confirmed existing implementation surfaces, not a mandate to preserve their current file layout:

| Existing source | Reuse/extraction target |
| --- | --- |
| `src/model.ts` | Native project/assembly types, element and project creation, unique IDs, timing and identity semantics |
| `src/editing.ts` | Assembly creation/insertion, hierarchy changes, duplication and timing |
| `src/sceneOperations.ts`, `src/scenePlacement.ts` | Scene moving/retiming and linked/nested compositions |
| `src/assemblyClips.ts`, `src/assemblyClipEditing.ts` | Definitions, instances, gaps, overlap priorities and texture conflicts |
| `src/shapePath.ts`, `src/projectivePin.ts`, `src/mediaTransform.ts` | Editable paths, transforms and media placement |
| `src/engine.ts`, `src/motion.ts` | Evaluation, procedural behavior and camera/time semantics |
| `src/storage.ts` | Versioned ZIP/XML `.hyde`/`.hy` projects and `.hyproj` assemblies, validation and asset import |
| `src/render.ts`, `src/mediaExport.ts`, `src/audio.ts`, `src/player.tsx` | Actual browser preview, playback and export |
| `src/clipEditDrafts.ts` | Existing editable draft/recovery expectations for editor interactions |

The current model uses `format:'hyde'`/`'hyde-assembly'`, `version:1`, stage coordinates in logical pixels, rotations in degrees, normalized `pivotX`/`pivotY`, `shapePath` coordinates normalized to an element's bounds, and time in **seconds** (`fps` controls frame snapping). The archive APIs presently expose browser `Blob`/`File` wrappers and `storage.ts` also contains IndexedDB recovery logic. Separate portable archive/validation logic from browser persistence rather than copy-pasting it into Node.

## 4. Product boundaries and deliverables

Four cooperating modules are required; package names below are suggested public names, not an instruction to reorganize all of Hyde at once.

| Module | Responsibility | Browser | Node |
| --- | --- | --- | --- |
| `@hyde/core` (shared extraction) | Types, validation, pure authoring helpers, evaluator and byte-based archive codec where portable | Yes | Yes |
| `@hyde/authoring` | Command registry, typed facade, revisions, transactions, inspectors and import mapping | Yes | Yes |
| `@hyde/sdk` | Developer entry points, filesystem/byte adapters, browser host orchestration, higher-level workflows | Yes, appropriate subset | Yes |
| `@hyde/bridge` | Opt-in live editor adapter, command dispatch, inspection, preview/export job handles | Yes | Client only |
| `hyde` CLI | Scripts for inspect/validate/apply/convert/preview/export and diagnostics | Through browser runtime | Yes |

The CLI is a deliverable of the SDK, not a separate product. The editor should consume the same underlying command/extraction logic where this can be introduced incrementally without destabilizing a release candidate. Start with small extracted boundaries and compatibility adapters; **do not require a risky wholesale rewrite of the existing React editor**.

SDK and decomposer may live in separate repositories or workspaces, but must depend on a single versioned copy of shared packages. For local development prefer workspace/link dependencies; define publication strategy only when the user requests distribution. The decomposer may be a separately deployable app regardless of repository layout.

## 5. Environment and capability model

A capability manifest distinguishes pure authoring from browser-dependent execution:

```ts
interface HydeCapabilities {
  protocolVersion: 1;
  sdkVersion: string;
  projectVersions: number[];
  assemblyVersions: number[];
  operations: string[];
  environment: 'node' | 'browser' | 'live-editor';
  preview: { frames: boolean; audio: boolean; video: boolean };
  exports: Array<'hyde' | 'hy' | 'hyproj' | 'web' | 'gif' | 'mp4' | 'webm'>;
  resourceLimits: { maxArchiveBytes?: number; maxCommandsPerBatch?: number; maxRenderPixels?: number };
}
```

`getCapabilities()` MUST describe actual runtime/browser support; MP4/WebM codec availability is queried at run time. No misleading claim that pure Node can run Pixi/WebCodecs identically. If a renderer is unavailable, pure authoring/validation continues and rendering reports `CAPABILITY_UNAVAILABLE` with actionable requirements. Never quietly substitute a different rendering stack.

## 6. Data model, identity and serialization contract

### 6.1 Native files

- `.hyde`: canonical complete-project extension; `.hy`: equivalent project archive. Both use current Hyde archive semantics.
- `.hyproj`: self-contained reusable assembly archive, preserving hierarchy, geometry, relevant clips and dependencies.
- Serialization MUST support round trips for all currently supported fields, including unknown *safe optional fields* accepted by Hyde. Unsupported new required semantics must cause an explicit failure.
- Distinguish **archive schema version** from SDK semver, command protocol version and in-session revision.
- Migrations operate on temporary copies, validate output and leave source bytes unchanged on failure. Never overwrite input unless explicitly requested.

### 6.2 Identity

- Native object IDs are stable across rename, reordering, parameter edits and compatible reparenting.
- Duplication/import creates new IDs as required, then remaps *all* internal references, including scene ownership, parent/attachments, clips, textures, linked assets, text-flow targets and animations.
- An imported asset's storage hash does not replace its logical asset ID; it may be used for deduplication.
- API request references may use **transaction-local aliases** such as `'$body'`, resolved only within that batch. Aliases never leak into persisted Hyde IDs.
- `idMap` in batch results reports aliases/imported IDs to committed IDs.
- Identity collision detection is mandatory; deterministic ID-provider injection may be used in tests but normal native IDs remain UUIDs or Hyde's equivalent.

### 6.3 Time and coordinates

- All persisted project times use Hyde's existing **seconds** semantics. SDK accepts explicit `timeSeconds` and optional ergonomic `{ frame, fps? }` descriptors that convert to project seconds; it must not silently convert existing files to integer-frame schemas.
- Frame alignment uses `project.fps`, with documented rounding options (`nearest` default for frame-oriented convenience methods; exact seconds when requested). Preserve non-frame media source positions.
- Stage positions and dimensions are logical pixels; rotations are degrees; pivots and shape paths are element-local normalized coordinates. External decomposer source-image coordinates have a separate declared transform.
- Attachment operations reuse Hyde's actual parent-relative and constraint semantics. Camera and scene-frame mapping use existing evaluator/helpers; no independent coordinate convention.
- Imported foreign geometry must declare its coordinate space, units and mapping; ambiguous transform inputs are rejected, not guessed.

### 6.4 Assets

- Public APIs accept `Uint8Array`/`ArrayBuffer`, MIME type, name and optional provenance/license metadata; Node file paths are adapter-level inputs only. They do not become portable references.
- The implementation may currently store `Asset.dataUrl`; a byte-based boundary hides this internal representation and prevents excessive base64 copying through agent text channels.
- Archive outputs embed required assets and licenses. Raw local paths, browser-private OPFS keys and blob URLs never appear as dependencies in portable outputs.
- Validate archive size, expansion ratio/limits, entry paths, declared MIME vs sniffed allowed types, hashes when present, references, decompression and SVG/external-resource risks. Do not render or fetch arbitrary remote URLs during import without explicit permission.
- Imports stage external bytes in temporary storage; rollback cleans uncommitted staging. Do not remove assets referenced by previous committed revisions or other documents.

## 7. Command protocol — stable data-driven authoring

All standard mutations SHOULD correspond to a serializable, discriminated command. SDK convenience methods compile to these commands; the browser bridge can transmit the same JSON. External binary payloads are referred to by temporary asset handles rather than embedded in JSON.

### 7.1 Envelope

```ts
type HydeCommand = {
  op: string;                    // registered, versioned operation
  args: unknown;                 // validated typed args for this op
  clientCommandId?: string;      // idempotency within one invocation scope
};
interface ExecuteRequest {
  protocolVersion: 1;
  expectedRevision: number;
  commands: HydeCommand[];
  dryRun?: boolean;
  correlationId?: string;
}
type ExecuteResult =
  | { ok: true; revision: number; applied: number; idMap: Record<string,string>;
      changes: ChangeSummary; warnings: HydeDiagnostic[] }
  | { ok: false; revision: number; errors: HydeDiagnostic[]; warnings: HydeDiagnostic[] };
```

Public TypeScript unions replace `unknown` for known operations. Commands are checked for authorized scope, valid target IDs, property support, type/range constraints, relationship invariants and references. Unsupported operations are rejected with `OPERATION_UNSUPPORTED` and capability hints. A general arbitrary object-path write is **not** exposed as a default public mutation mechanism.

### 7.2 Required command catalog

The exact grouping is normative; literal `op` names are proposed. Every command accepts explicit IDs or prior batch aliases, returns structured IDs where appropriate, and produces a single validated native project state.

**Project and scenes**

| Operations | Required semantics |
| --- | --- |
| `project.create`, `project.updateMetadata` | Name, dimensions, FPS, duration, background, web player settings; validate downstream timing/scale consequences |
| `scene.create`, `scene.rename`, `scene.delete`, `scene.duplicate` | Source-aware editing, scene ownership and copy remapping |
| `scene.move`, `scene.retime`, `scene.ripple`, `scene.trimBoundary` | Same behavior as Hyde timeline; visibility trimming is not deletion |
| `scene.link`, `scene.unlink`, `scene.setPlacement` | Source ranges, placement start/duration/speed, crop/frame, rotation, fit, opacity and audio mute; reject cycles |
| `scene.setCamera`, `camera.upsertKeyframe`, `camera.deleteKeyframe` | Per-scene camera properties, easing and exact time semantics |
| `caption.create`, `caption.update`, `caption.delete` | Text, start/end, scene association |

**Elements, hierarchy and assembly construction**

| Operations | Required semantics |
| --- | --- |
| `element.create`, `element.clone`, `element.remove` | All supported kinds, scene ownership, hierarchical deletion policy |
| `element.updateAppearance` | Fill, outline, shadows, opacity, visibility, render hint and supported typed appearance settings |
| `element.setTransform`, `element.setPivot` | Position, rotation, scale, dimensions, local/world transform intent and pivot-preserving behavior |
| `element.reorder`, `element.setVisibility`, `element.setLock`, `folder.*` | Drawing order vs UI-only folders, group/ungroup, editor discovery |
| `assembly.create`, `assembly.import`, `assembly.export` | Native assembly hierarchy, assets and ID remaps |
| `assembly.attach`, `assembly.detach`, `assembly.setLimits`, `assembly.reparent` | Fixed/Hinge/Slider limits, cycle prevention and world-pose preservation where requested |
| `element.align`, `element.distribute` | Same alignment/distribution semantics as editor; scoped selection |

**Geometry, textures and images**

| Operations | Required semantics |
| --- | --- |
| `shape.setPrimitive`, `shape.convertToPath`, `shape.setPath` | Rect/ellipse/polygon, Bézier path with normalized controls; path point count/closed contour validated |
| `shape.insertPoint`, `shape.movePoint`, `shape.setHandle`, `shape.removePoint` | Use existing `shapePath.ts` operations and visual preservation where promised |
| `media.setFill`, `media.setPlacement`, `media.setPin`, `media.setEndBehavior` | Asset fill, Fit/Fill/Stretch, independent texture placement and projective quad validation |
| `media.setOpacity`, `element.setTextMaskTarget` | Separate media opacity and text/shape masking relationships where natively supported |
| `asset.add`, `asset.replace`, `asset.removeUnused`, `asset.rename` | Content staging, references, deduplication and explicit delete restrictions |

**Animation, procedural behavior and assembly clips**

| Operations | Required semantics |
| --- | --- |
| `track.ensure`, `keyframe.upsert`, `keyframe.move`, `keyframe.remove`, `track.remove` | Property-specific values, easing families, hold/stepped/smooth and key identity |
| `motion.add`, `motion.update`, `motion.remove` | Follow-path, oscillation, seeded shake with Hyde bounds |
| `clip.capture`, `clip.rename`, `clip.updateDefinition`, `clip.remove` | Definition ownership, positive duration, shared-instance behavior |
| `clip.place`, `clip.move`, `clip.retime`, `clip.removeInstance` | Placed instance timing, loop and overrides |
| `clip.setGapTransition`, `clip.setPriority`, `clip.setTextureOverlap`, `clip.editPlacedKey` | Gap tweens/hold, per-property overlap, discrete texture cadence and explicit instance changes |

**Typography and media sound**

| Operations | Required semantics |
| --- | --- |
| `text.setContent`, `text.setFont`, `text.setLayout` | Editable text, local/bundled fonts, live/static and shape-aware flow |
| `text.setAnimation`, `text.setReflow`, `text.captureStaticLayout` | Word/line motion, deterministic reflow, snapshots requiring browser text layout where necessary |
| `audio.setRange`, `audio.split`, `audio.duplicate`, `audio.setMix` | Trims, fades, gain, mute, overlap and clip source offsets |
| `audio.setSpeedPitch`, `audio.setEffects`, `audio.updateEffect` | Linked/independent timing, pitch, ordered bypassable effects, limits |
| `video.setSourceTiming`, `video.setAudioMix` | Linked video and its embedded audio, independent visual/audio behavior |

Higher-level convenience functions (e.g. `buildCharacter`, `animateProperty`, `placePictureInPicture`, `addAnimatedCaption`) MAY compose commands. They must not invent incompatible hidden semantics. Core commands needn't expose transient mouse gestures or unrelated editor preferences as persistent story content.

### 7.3 Extensibility

- New commands MUST register an operation name, JSON-compatible schema, validation logic, feature/version flag, inspector output and tests.
- Core releases MAY add optional fields/commands without archive version changes if existing data semantics are unchanged.
- Third-party command plugins cannot bypass core validation or run arbitrary JavaScript through the bridge.
- Unknown custom operations are rejected cleanly; optional producer-specific metadata can be preserved only where Hyde allows it.

## 8. Transaction and revision contract

A session owns `{ project, revision, undoHistory }`. Revisions begin at 0 on each opened session and increment once per successful atomic batch; they do not need to be written into `.hyde`. Expose saved-content digests separately for comparing across sessions.

**Execution algorithm (mandatory):**

1. Verify protocol, client permission, current revision and batch/resource limits.
2. Resolve aliases and stage new byte assets, but do not mutate committed state.
3. Clone or persistent-copy the relevant candidate model; run commands in order against it.
4. Validate command-local preconditions and full resulting project graph (IDs, references, constraints, timing, media, cycles, serialization safety).
5. If `dryRun`, report proposed changes/warnings and discard candidate/staging; revision unchanged.
6. If successful, atomically swap the candidate as the committed model, increment revision, record **one** editor undo record, and finalize asset handles. Events are emitted only after commit.
7. On error, discard candidate/staging, preserve committed state and revision, return target-specific diagnostics.

Undo/redo through the live editor MUST remain consistent with SDK edits. The bridge should integrate through Hyde's history mechanism, not replace it with a second stack. A client can request rollback of *its own uncommitted batch*; a later undo is an ordinary versioned editor change and must obey current revision/authorization.

Concurrent agent clients use optimistic concurrency. A stale `expectedRevision` returns `REVISION_CONFLICT`, the current revision and a bounded change summary. **No automatic last-writer-wins** for structural changes. Clients re-inspect affected entities and explicitly retry. `clientCommandId` prevents accidental double execution within a documented scoped replay window; it is not a permanent global transaction ledger.

External effects such as downloading files, saving to arbitrary disk paths or starting MP4 encoding are separate job operations, not inside a model transaction. Failure must be reported and resources cleaned without rolling back an already committed story edit.

## 9. Public SDK facade

```ts
interface HydeSession {
  readonly revision: number;
  capabilities(): HydeCapabilities;
  execute(request: ExecuteRequest): Promise<ExecuteResult>;
  inspect(request: InspectRequest): Promise<InspectResponse>;
  diagnostics(): Promise<HydeDiagnostic[]>;
  evaluate(timeSeconds: number, options?: EvaluateOptions): Promise<EvaluatedState>;
  exportProject(options?: ArchiveOptions): Promise<Uint8Array>;
  exportAssembly(rootId: string, options?: ArchiveOptions): Promise<Uint8Array>;
  close(): Promise<void>;
}

interface HydeSDK {
  createProject(options?: NewProjectOptions): Promise<HydeSession>;
  openProject(bytes: Uint8Array): Promise<HydeSession>;
  openAssembly(bytes: Uint8Array): Promise<HydeAssemblyHandle>;
  connectBrowser(options: BrowserHostOptions): Promise<HydeRenderHost>;
}
```

Convenience facade methods MAY be object-oriented (`session.scenes.create`, `session.elements.update`, `session.timeline.keyframe`) but MUST compile into the same command protocol. Methods return explicit IDs and structured errors. Supporting typed `Project` object inspection is allowed, but do not let clients mutate an internal reference and bypass commit validation.

### 9.1 Inspection and agent-efficient queries

`inspect({ target, fields?, sceneId?, time?, depth?, limit?, cursor?, sinceRevision? })` MUST support:

- Project summary (dimensions/FPS/duration, scene count, asset inventory, warnings).
- Scene list, per-scene tree, element hierarchy, assembly and attachment graph.
- Object details by ID, typed fields, transform/pivot and relevant clip/asset references.
- Timeline by scene/visible range, keyframes, procedural motion, audio, captions, master/placed clip structure.
- Asset metadata/hashes/dimensions without sending contents.
- Render/environment capability information and pending job status.
- Diff summaries by revision where retained; if history expired return `DIFF_UNAVAILABLE` plus current revision and re-inspection guidance.

Use stable pagination ordered by ID or documented deterministic sort. Enforce depth/size limits. Binary media, exported archives and rendered images return typed artifact handles or byte streams, never text-embedded base64 by default.

### 9.2 Evaluation and preview

`evaluate(time)` is non-mutating and may run headlessly where Hyde's evaluator supports it. It returns evaluated object properties/poses, cameras and diagnostic state, **not pixels**. All rendered frames use `HydeRenderHost.renderFrame({ timeSeconds, width?, height?, background?, format? })` with real Hyde `StageRenderer`/text/font/media behavior. `renderRange` and `exportMedia` are asynchronous cancellable jobs with progress, diagnostics and resource cleanup. Requesting an unsupported codec fails explicitly and advertises supported alternatives.

Before reporting a finished frame, wait for required fonts/media or report an explicit buffering/failure state. A browser frame is not accepted merely because a canvas exists. Rendering must not unexpectedly move the live editor's playhead or alter its authored state unless expressly requested as an editor navigation operation.

## 10. CLI contract

Proposed executable: `hyde`. Every command accepts `--json` for machine-readable, bounded, schema-stable output. Binary results always go to a file or a declared byte stream, never into JSON stdout. Input files are never overwritten unless `--in-place`/`--output` explicitly specifies it; atomic temporary-file replacement and recoverable backups are used for in-place work.

| Command | Behavior |
| --- | --- |
| `hyde project new --name ... --output story.hyde` | Native project with validated defaults |
| `hyde project validate story.hyde --json` | Verify archive and project graph without writing |
| `hyde project inspect story.hyde --scene ... --fields ... --json` | Bounded structural inspection |
| `hyde project apply story.hyde --commands ops.json --output revised.hyde --json` | Execute one validated transaction; no partial save |
| `hyde project diff before.hyde after.hyde --json` | Semantic ID-aware comparison, not ZIP byte diff |
| `hyde assembly inspect/validate/export/import ...` | Native `.hyproj` interchange, identity mapping |
| `hyde project preview story.hyde --time 2.5 --output frame.png` | Use browser runtime; show capability errors if missing |
| `hyde project render story.hyde --format mp4 --output out.mp4 ...` | Browser-backed export, progress/cancel and codec verification |
| `hyde doctor --json` | Report Node/browser/codec/archive capabilities and actionable problems |

Meaningful exit codes: `0` success, `2` invalid input/command, `3` invalid project or unsupported version, `4` revision conflict, `5` missing capability/environment, `6` render/export failure, `7` canceled. Do not leak absolute private paths, media data, API tokens or local source contents into default diagnostic output. `--verbose` remains bounded/redacted.

## 11. Live-editor browser bridge

### 11.1 Activation

- **Disabled by default.** A user deliberately enables “Allow automation for this editing session.” It expires on tab close/reload/revocation and never persists as a blanket grant.
- Bridge exposes the current editor state through a narrow in-page adapter. No network listener, backend, localhost server or global externally callable endpoint is required.
- A direct same-page API can be used by supported cloud-computer/browser-agent tooling. If cross-frame/window messaging is added, require explicit origin/target validation, nonce/session token, scope checks and typed request validation; never use `'*'` origin for privileged exchange.
- Clarify security boundary: code already executing with unrestricted authority inside Hyde's origin is not protected by bridge toggles. The bridge reduces accidental access and surface area; it is not a sandbox against malicious same-origin scripts.

### 11.2 Permission groups

`read`, `write`, `assets`, `preview`, `export`, `editorNavigation`. Enabling a session requires explicit user authorization for requested scopes; write/export operations are never silently escalated from read access. Permission revocation invalidates pending mutation requests and prevents new jobs. Existing committed work remains; any completed external downloads are not retroactively undone.

### 11.3 Browser protocol

Requests are tagged by `protocolVersion`, `sessionId`, `requestId` and operation, and responses echo `requestId` with `ok`, result or structured diagnostic. Commands use section 7's transaction envelope. Read APIs support concise inspection; image/export APIs return artifact handles transferable by the host. Operations include `capabilities`, `inspect`, `execute`, `evaluate`, `renderFrame`, `startExport`, `jobStatus`, `cancelJob`, `select`, `setPlayhead`, `diagnostics` and `revoke`.

Jobs have finite states `queued | preparing | running | completed | failed | canceled`, progress, error and cleanup guarantees. No indefinite busy loops. Apply timeouts and backpressure; at most a bounded number of concurrent expensive render jobs. Live-editor model mutations serialize against the editor's normal project commits.

## 12. Diagnostics and error semantics

```ts
interface HydeDiagnostic {
  code: string;                         // e.g. INVALID_ATTACHMENT
  severity: 'info' | 'warning' | 'error';
  message: string;
  targetId?: string;
  commandIndex?: number;
  field?: string;
  details?: Record<string, unknown>;    // bounded, serializable, no raw asset bytes
  suggestions?: string[];
}
```

Required stable failure classes: `INVALID_ARGUMENT`, `TARGET_NOT_FOUND`, `DUPLICATE_ID`, `INVALID_REFERENCE`, `INVALID_ATTACHMENT`, `ATTACHMENT_CYCLE`, `INVALID_TIMING`, `INVALID_GEOMETRY`, `INVALID_ASSET`, `ASSET_MISSING`, `SCHEMA_UNSUPPORTED`, `MIGRATION_FAILED`, `REVISION_CONFLICT`, `PERMISSION_DENIED`, `OPERATION_UNSUPPORTED`, `CAPABILITY_UNAVAILABLE`, `MEDIA_NOT_READY`, `EXPORT_FAILED`, `RESOURCE_LIMIT`, `CANCELED`, `INTERNAL_ERROR`. Normal expected failures return tagged errors; truly unexpected SDK exceptions are caught and converted at process/bridge boundaries with correlation IDs.

A validation success may include warnings (e.g. media decode not checked in headless Node, missing runtime font availability), but warnings are never mislabeled proof of visual correctness. Explicit rendering/report jobs can be used to resolve relevant warnings.

## 13. Documentation and agent integration

Deliver:

1. Human-readable API reference with command payloads, schemas, capabilities and failure modes.
2. Machine-readable schemas/types for command envelopes, inspector requests and results.
3. An **agent-facing instruction file** describing a safe inspect → plan → dry-run → commit → preview → diagnose → targeted-revise workflow.
4. Example projects demonstrating procedural authoring, assembly construction, imports, live browser edits and export.
5. CLI examples requiring no LLM, so the system is useful as a conventional programming tool.
6. A compatibility table and migration notes for released SDK, Hyde model and decomposer versions.

Agent workflows should normally inspect only relevant scene IDs and sample representative frames, not render the full timeline or print entire projects. Provide explicit job/capability/error handling and avoid unbounded autonomous retries.

## 14. Security, resilience and resource bounds

- Validate untrusted ZIP/XML, SVG and media inputs before using them; preserve Hyde's current size/path/decompression guards or tighten with evidence. Browser media decode is not a trusted data-validation substitute.
- Prevent archive path traversal and unexpected remote fetches. Avoid executing user-provided JavaScript; the SDK is a data/command system, not an arbitrary code-evaluation environment.
- Keep command depth/count, inspector payload, media bytes, renderer frame dimensions and job concurrency bounded; advertise real limits.
- Support cancellation (`AbortSignal`/CLI interrupt/job cancel). Always release temporary renderer contexts, object URLs, audio graphs, streams, staging files and locks.
- Writes to files use temporary outputs and atomic replace where supported. A failed write retains the previously valid archive.
- No secrets in project files by default, no network request to Hyde services, no implicit user tracking.

## 15. Interoperability contract for the decomposer

The decomposer is an **independent producer** of authoring transactions and native assembly/project artifacts. It may submit validated `shape.setPath`, `element.create`, `assembly.attach`, `asset.add` and other appropriate commands to SDK sessions. It must *not* fabricate Hyde ZIP/XML or private React state.

The decomposer's own editable source document stores source images, masks, annotations, geometry, geometry-generation version and lineage, plus a map from its stable **part IDs** to generated Hyde IDs. Those extra annotations are **not** implicitly embedded in `.hyproj`; they remain in a separate native decomposer document, export bundle or deliberate optional extension. Hyde output should open/edit independently even when the decomposer is absent.

A decomposer assembly export MAY include only objects representable by the target project's advertised capabilities. A dry-run validates the converted scene/assembly; warnings report unsupported geometry, missing inferred occluded art, imperfect hole reconstruction or limits. Never claim a raster-backed flattened patch is editable vector geometry. Additional reference images only inform part identity/coverage; do not create animated poses/clips automatically.

## 16. Acceptance tests and quality gates

### Core compatibility

- Open/save SDK-generated `.hyde`/`.hy` and `.hyproj` in Hyde; modify in editor; re-open through SDK; compare semantic IDs, relationships, clips, assets, captions, settings and timed state.
- Round-trip existing Hyde fixtures (showcase, linked scenes, complex assemblies, procedural motion, text, audio/media) without loss or silent normalization of supported fields.
- Import assemblies with ID collisions, nested clips, attachment limits, asset hashes and audio. All references must resolve after remap.
- Reject malicious/unsupported archives without altering last good project.

### Commands/transactions

- Exercise at least one public command from every command category through SDK and (where appropriate) live bridge; confirm same validity as equivalent editor action.
- Batch dependent creates using aliases. Invalid final attachment cycle rolls back *all* created objects/assets; dry-run leaves revision and storage unchanged.
- Concurrent stale revisions produce conflict and no partial write. Transaction accepted in live editor is one logical undo/redo unit.
- ID preservation across rename/reshape/retime; duplications remap target references and do not mutate originals.

### Agent operation

- Agent creates an editable textured/masked multi-scene story with camera and text motion, captions and audio, validates, renders sample frames in real Hyde browser host and exports `.hyde` and video/web where supported.
- Agent revises exactly one target scene without disturbing unrelated IDs/assets/tracks; deterministic inspectors show a concise diff.
- Headless Node works offline for structural authoring. Browser capability failures are explicit, never silent fallback output.
- Bridge read-only and permission revocation tested; no mutation without a live enablement grant.

### Resource/reliability

- Long enough representative archive/media fixture to catch gross leaks and cancellation errors, using bounded workloads; do not create an endless performance matrix.
- Export canceled/fails without leaving hidden canvases, asset staging, dangling media or corrupted native archives.
- CLI JSON is predictable; error exit codes and binary output files are correct.

The SDK is feature-complete when all catalog categories have implemented paths and representative acceptance tests pass. External browser/codec hardware limitations are documented separately and do not trigger speculative scope expansion.

## 17. Implementation order (dependency-directed, not release gates)

**Foundation:** Freeze reference snapshot and regression fixtures. Extract portable archive validation/codec from `storage.ts` behind byte interfaces; establish `@hyde/core` imports and Node/browser parity tests. Preserve existing editor behavior.

**Commands:** Implement transaction executor, revision and ID maps, typed command registry and reusable inspectors. Adapt existing scene, path, assembly, timeline and media editing functions instead of rewriting them. Add remaining capability-specific command adapters.

**SDK and CLI:** Ship TypeScript facade, byte/file adapters, archive import/export, diagnostics, diff, machine-readable CLI and examples. Verify headless construction and round trips.

**Browser host/bridge:** Integrate exact renderer/player/export surfaces, opt-in live editor session, permission checks, job progress/cancel and undo integration. Verify true screenshots/video from SDK projects.

**Hardening:** End-to-end agent workflows, edge-case validation, compatibility fixtures, security/limits, documentation and versioned release. Avoid unrelated enhancements or rebuilding Hyde's UI.

## 18. Explicit non-goals

- No AI model, prompt-to-animation generator or inference service inside this SDK.
- No hosted Hyde project store, login, remote renderer or mandatory backend.
- No second renderer, independent animation evaluator or duplicate serialized model.
- No automated animation generation from reference poses.
- No unrestricted `eval`, script injection, arbitrary project-object mutation or public unauthenticated automation endpoint.
- No requirement to support future Hyde versions without explicit compatibility testing/migration.
- No engine rewrite or reduction of Hyde features for the convenience of agent integration.

## 19. Definition of done

A documented, typed and tested SDK/CLI can manipulate the complete native authoring feature set; transactions are reversible and resilient; Node can handle projects/archives offline; a permitted browser host provides real Hyde previews/exports; the editor and SDK round-trip content safely; a restricted live bridge edits the same state as the GUI; and the decomposer can consume a stable conversion interface without duplicating Hyde's core.
