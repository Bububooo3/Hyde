# Using Hyde from an agent or script

1. Open the native archive through `hyde.openProject(bytes)` or the CLI. Read `capabilities()` and inspect only the relevant scene, tree, timeline range and asset metadata. Avoid printing embedded media or an entire project for a small edit.
2. Prepare a typed command batch with stable target IDs and transaction-local `$aliases`. Stage image, audio, video, font or `.hyproj` bytes separately; commands refer to handles.
3. Execute the batch with `dryRun: true` and the current `expectedRevision`. Resolve every error and review proposed `idMap`, changes and warnings. Do not infer visual quality from a valid project graph.
4. Commit the same batch with a unique `correlationId`. A stale revision requires re-inspection of affected IDs and an explicit retry. Never silently overwrite a concurrent edit.
5. Export the native `.hyde` or `.hyproj` bytes. When a browser is available, render representative frames with the Hyde browser host; check warnings and inspect the visible result before producing GIF, video or a web package. Unsupported codecs are capability failures.
6. Make targeted revisions and repeat the narrow checks. Keep the original archive and staged media until the new archive is verified. The CLI writes only to an explicit output path and retains a backup on replacement.

The same protocol works without an LLM. The editor bridge needs the human user's deliberate per-tab scope grant. It is disabled by default, and revocation stops further access. Do not enable scopes through browser automation on behalf of a user without authorization.

Decomposition uses the separate `.hydecomp` working document. Treat inferred/occluded geometry as uncertain, preserve the source and annotations, and export editable Hyde shapes through SDK commands. Reference images alone do not authorize generated keyframes or clips.
