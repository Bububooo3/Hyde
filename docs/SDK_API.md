# Hyde Agent Authoring SDK (local development API)

The SDK uses Story Studio's `Project`/`Assembly` types, evaluator, editing helpers and archive codec. It does not require a server. Build the `packages/sdk/` workspace with `npm run build -w @hyde/sdk` and the CLI with `npm run cli:build`. The local package exposes `@hyde/sdk` (and the existing `hyde-editor/sdk` alias); implementation imports the shared root `src/` core. The protocol version is **1** and the current SDK version is **0.1.0**. This is an implementation checkpoint; [ACCEPTANCE.md](ACCEPTANCE.md) lists unfinished requirements.

## Node example

```ts
import { hyde } from '@hyde/sdk';

const session = await hyde.createProject({ name: 'An editable story', width: 640, height: 480 });
const sceneId = session.snapshot().sequences[0].id;
const dryRun = await session.execute({
  protocolVersion: 1, expectedRevision: session.revision, dryRun: true,
  commands: [
    { op: 'element.create', args: { alias: '$body', kind: 'ellipse', sceneId,
      properties: { name: 'Body', x: 120, y: 140, width: 100, height: 80 } } },
    { op: 'keyframe.upsert', args: { elementId: '$body', property: 'rotation', timeSeconds: 1, value: 30 } },
  ],
});
if (!dryRun.ok) throw new Error(dryRun.errors.map(error => error.message).join('; '));
const committed = await session.execute({ protocolVersion: 1, expectedRevision: session.revision,
  correlationId: 'create-body-v1', commands: [
    { op: 'element.create', args: { alias: '$body', kind: 'ellipse', sceneId,
      properties: { name: 'Body', x: 120, y: 140, width: 100, height: 80 } } },
    { op: 'keyframe.upsert', args: { elementId: '$body', property: 'rotation', timeSeconds: 1, value: 30 } },
  ] });
if (!committed.ok) throw new Error(committed.errors.map(error => error.message).join('; '));
const bytes = await session.exportProject(); // write bytes to an explicit .hyde destination
await session.close();
```

`HydeCommand` is a discriminated TypeScript union. `HYDE_EXECUTE_SCHEMA_V1` and `HYDE_INSPECT_SCHEMA_V1` describe the protocol and operation-specific required keys, value types and static bounds. State-dependent rules such as attachment cycles, scene ranges and media references are checked by the native transaction validator. No object-path setter or JavaScript evaluation is exposed.

## Session surface

| Method | Behavior |
| --- | --- |
| `hyde.createProject(options)`, `hyde.openProject(bytes)` | Create/open a native v1 project. The opened archive remains untouched until explicitly written. |
| `hyde.openAssembly(bytes)` | Validate a `.hyproj`; inspect metadata or re-export its bytes. |
| `hyde.migrateArchive(bytes, archiveType, targetVersion?)` | Validate a detached v1 archive and return unchanged bytes for an explicit write. Unsupported future schema versions fail with `HydeSchemaUnsupportedError`; no v2 conversion is claimed. |
| `session.execute(request)` | Apply 1–1000 commands atomically with `expectedRevision`; `dryRun` returns proposed IDs/changes without committing. |
| `session.inspect(query)` | Bounded project, scene, object, tree, assembly, timeline, asset or revision-change query; asset bytes are excluded. |
| `session.evaluate(timeSeconds)` | Hyde evaluator output and active camera, without rendering pixels or changing authoring state. |
| `session.stageAsset(bytes, mime, kind)`, `stageAssembly(bytes)` | Validate binary input and receive a transient handle for `asset.add`/`asset.replace` or `assembly.import`. |
| `session.exportProject()`, `exportAssembly(rootId)` | Emit self-contained native ZIP bytes through Hyde's codec. |
| `session.contentDigest()` | Return a versioned SHA-256 digest of the current native archive content for comparison across sessions. `HydeAssemblyHandle.contentDigest()` does the same for assemblies. |
| `session.undo(revision)`, `redo(revision)`, `close()` | Session history and lifetime management. The live bridge uses the editor's own history. |
| `hyde.connectBrowser(session)` | Attach Hyde's real browser renderer/export host when a DOM/WebGL environment exists. |

Times are seconds; `fps` controls frame snapping in editor operations. Stage positions are logical pixels, rotations are degrees, pivots and path coordinates are normalized. Aliases such as `$body` exist only within one batch. `idMap` reports generated IDs. A repeated `correlationId` with identical commands returns the prior commit result within a bounded 128-batch session window; reusing it for changed commands fails. `contentDigest()` returns `{ algorithm: 'SHA-256', digestVersion: 1, archiveType, archiveVersion: 1, hex }`. Version 1 hashes the sorted paths, lengths, and SHA-256 values of the uncompressed entries emitted by Hyde's native archive codec; ZIP timestamps, entry order and compression choices do not affect it. The digest covers current saved content, including persisted timestamps, and is separate from the in-session revision. It is not a hash of the ZIP byte stream.

`element.setTransform` accepts `space: 'local'` (the default) for authored local values or `space: 'world'` with an optional `timeSeconds` for a stage pose. World mode supports x/y, rotation and scale, converts through Hyde's evaluated parent at that time, and checks the resulting pose. It rejects constraints or animated target properties that would override the edit; dimensions and pivot remain local edits. One example is `{ op: 'element.setTransform', args: { id: 'hand', space: 'world', timeSeconds: 1, transform: { x: 250, y: 140 } } }`.

`shape.setPath` accepts an outer `points` contour and optional `holes` contours, each with editable anchors and Bézier handles. `shape.insertPoint`, `shape.movePoint`, `shape.setHandle`, and `shape.removePoint` accept optional `contourIndex`: `0` selects the outer contour, `1` the first hole. Missing or invalid contours fail the transaction atomically.

The current registered command catalog is available from `HYDE_OPERATIONS` and the session capability manifest. Its typed definitions are grouped in `src/authoring.ts` (project, scene, element, path, attachment, asset creation), `src/authoringCatalog.ts` (scene timing/placement, clone, folders, pivots, alignment, assembly import, captions, assets), `src/authoringTimeline.ts` (tracks, keys, camera, motion, reusable clips), and `src/authoringMedia.ts` (primitive geometry, texture/media, text, audio and video). `scene.setPlacement` accepts either `speed` or `duration`; speed converts the selected source interval into native placement duration. Scene inspection reports the effective speed, while archives retain Hyde's native duration and source range. A batch fails with a structured code and command index when a command or final graph is invalid. Per-command errors identify the target ID and unsupported field when known. A stale revision reports the current revision and a bounded change summary; clients explicitly re-inspect before retrying. State-dependent final validation can still report a project-level diagnostic when Hyde's validator cannot identify one command as the cause.

`asset.add` supports opt-in `reuseExisting: true`. If an existing asset has identical staged bytes, MIME, kind, declared duration and font license notice, its native ID is returned through the batch alias and no duplicate asset is added. Its existing display name is retained. Omit the option to create a distinct logical asset; `reuseExisting` cannot be combined with an explicit native ID. Audio and video `asset.add` accepts `duration` in source seconds (positive, at most 24 hours). Source-range and speed commands require it. `asset.replace` requires a new duration for audio/video so replacement cannot silently retain stale timing metadata. The SDK validates the declaration but cannot infer codec duration in headless Node; callers should use the measured media duration.

Inspection limits are 1–100 items per page, cursors are nonnegative integers, and tree depth is 0–8. Invalid pagination, field lists or timeline bounds return `INVALID_ARGUMENT` with a `field` name. A single-scene query applies `fields` to its scene record; its paged child elements remain available separately.

Asset inspection in the SDK, CLI and read-only editor bridge returns `byteLength` and `contentSha256` for the requested page. PNG, GIF, JPEG and WebP assets also return header-derived `width` and `height` when available. Field projection avoids decoding or hashing media when only names or IDs are requested. Media bytes remain absent from inspection JSON.

`text.captureStaticLayout` runs Hyde's shape-aware text layout in a browser after `document.fonts.ready`. Set the text's around/inside shape target and static layout first, then capture at an explicit project time in the same transaction. The resulting editable text and line arrangement persist in `.hyde`. Headless Node returns `CAPABILITY_UNAVAILABLE` with a font/browser requirement; it does not approximate font metrics.

## CLI

`node dist/cli/hyde.mjs doctor --json` checks Node and browser capabilities. The CLI supports `project new|validate|inspect|apply|diff|preview|render|export`, `assembly inspect|validate|export|import`, and writes binary artifacts only to an explicit destination. For example:

```sh
node dist/cli/hyde.mjs project new --name Example --output example.hyde --json
node dist/cli/hyde.mjs project apply example.hyde --commands edits.json --output revised.hyde --json
node dist/cli/hyde.mjs project inspect revised.hyde --target tree --scene SCENE_ID --depth 2 --json
node dist/cli/hyde.mjs project inspect revised.hyde --target timeline --scene SCENE_ID --time-start 0 --time-end 2 --json
node dist/cli/hyde.mjs project inspect revised.hyde --target element --id ELEMENT_ID --fields id,name --json
node dist/cli/hyde.mjs project preview revised.hyde --time 1 --output frame.png --json
node dist/cli/hyde.mjs project export revised.hyde --format web --output story-web.zip --json
```

`edits.json` can be an array of commands or a request object with `commands` and `stagedAssets` file declarations. `project inspect` accepts the SDK targets `project`, `scenes`, `scene`, `elements`, `element`, `assets`, `asset`, `changes`, `tree`, `timeline`, and `assembly`. Use `--id` for a single scene, element, asset, or assembly root; `--scene` (or `--scene-id`) filters a scene tree, element list, or timeline. `--limit`/`--cursor`, `--depth`, and `--time-start`/`--time-end` bound queries. `--fields` projects native fields for project, element, asset, and list entries while retaining the revision wrapper. The CLI writes temporary files and keeps a backup when replacing an existing explicit output. JSON transaction failures retain revision, command index, target/field details and warnings. Exit codes distinguish invalid arguments (2), schema/archive errors (3), revision conflicts (4), unavailable capabilities (5), internal/browser failures (6), and cancellation (7). Preview/render use a private Chromium page, Hyde's renderer/export stack, and no local HTTP server. Codec availability is probed at runtime; an unsupported MP4/WebM request fails rather than emitting substitute bytes.

## Live editor bridge

In Story Studio, open **View → Automation access**, choose scopes, then enable access for this tab. The bridge is absent by default and removed on reload, project replacement or revocation. A same-page client uses `window.hydeAutomation.sessionId` and calls `request({ protocolVersion: 1, sessionId, requestId, operation, payload })`. Scopes are `read`, `write`, `assets`, `preview`, `export`, and `editorNavigation`. Each committed automation batch enters the GUI history as one undo action. Render/export accepts one active job at a time, times out after five minutes, caps returned artifacts at 512 MiB, and denies a pending success after revocation. Same-origin scripts already running in Hyde are outside this consent boundary; the bridge is not a sandbox for them.

## Compatibility and limitations

| Component | Current compatibility |
| --- | --- |
| Hyde archive | Native project/assembly schema v1, `.hyde`/`.hy` and `.hyproj`; unknown safe optional fields round-trip. The migration API is a byte-preserving v1 identity with typed future-version rejection until a new native schema is defined. |
| Command protocol | v1, session revisions begin at 0 and are separate from archive version. |
| Node runtime | Node 20+ with WebCrypto; authoring and archives work without a browser. |
| Browser runtime | DOM/WebGL required for frame rendering; export formats depend on browser codecs. |
| Image Decomposer | `.hydecomp` v1 is a separate working document; native output goes through these SDK transactions. |

No migration from a future Hyde schema is available yet. Unsupported versions fail before overwriting input. Node evaluation returns model poses, not pixels. Browser text capture and some advanced editor-only workflows are still tracked as gaps in [ACCEPTANCE.md](ACCEPTANCE.md).

On archive import, Hyde checks the declared asset kind against its MIME category, rejects a recognized file signature that conflicts with its declared MIME, and refuses active markup disguised as another media type. SVG imports require a valid self-contained SVG root; scripts, event handlers, dynamic elements, document types, external references and external CSS resources fail. Older Hyde archives can contain media with an unrecognized or very short header, so these opaque bytes remain loadable for editability. Header recognition does not prove that a PNG, video, audio file or font will decode successfully; renderer failures for such legacy assets remain a compatibility boundary.
