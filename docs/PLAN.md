# Hyde Story Studio: local-first mixed-media storytelling

## Summary and delivery

Build a desktop/laptop web-based story studio for creating automatically played stories from textured shapes, reusable assemblies, animated text, images, video, and audio. Support current stable Chrome, Edge, Firefox, and Safari for authoring, with desktop and mobile viewing.

The editor will be a static application deployable to your UIUC hosting. Projects stay on users’ devices. Exported stories include everything needed for independent static web hosting.

Implementation proceeds through internal milestones toward the complete feature set below. Milestones are not public releases. At each checkpoint, report completed capabilities, automated verification, known limitations, and next steps. Delegate bounded implementation and testing tasks to subagents when useful, explicitly identifying those assignments.

Automate functional, integration, and regression testing. You handle subjective visual/audio evaluation through a small prepared sample and a short checklist, normally no more than three checks at relevant milestones. Do not assign you routine regression testing or a large browser matrix. Disclose any unverified platform rather than claiming it passed.

## Editor and creative tools

### Workspace and editing

- Use a central stage, left-side tabs for assets/libraries/layers, right-side properties, bottom timeline/curve editor, and top menus/tools.
- Provide resizable and collapsible panels, context tabs, breadcrumbs, and Reset Workspace. Defer floating windows and arbitrary docking.
- Include a splash screen for New Project, Open Project, Recent Projects, documentation, and an example project.
- Provide tooltips, shortcuts, contextual help, short dismissible hints, and context menus.
- Support selection synchronization between stage and timeline, multi-select, marquee selection, duplicate, copy/paste, alignment/distribution, guides, grid snapping, and locking.
- Keep editor preferences and timeline filtering separate from exported content.
- Treat completed interactions as undoable actions. Assembly/clip editing uses Apply/Cancel; leaving with pending changes offers Apply, Discard, or Keep Editing. Preserve recoverable drafts without implicitly applying them.

### Stage, shapes, and media

- Offer landscape, portrait, square, and custom project dimensions; default to 1920×1080 at 30 fps.
- Preserve authored aspect ratio in playback. Provide offstage workspace and separate editor pan/zoom from the story camera.
- Give each sequence one camera with animated position, zoom, and rotation. Held transitions create cuts.
- Support rectangles, ellipses, polygons, and editable Bézier paths. Converting a primitive to a path exposes its points and handles.
- Shapes have independent fill, outline, opacity, texture, and shadow controls. Initial path editing does not include vertex-by-vertex morph animation.
- Support editable shape masks, media Fit/Fill/Stretch, and independent texture positioning, scaling, and rotation.
- Dropping media onto a shape applies a masked fill; dropping onto empty stage space creates a rectangle at the source aspect ratio.
- Include four-corner projective pinning for images/video. Curved masks clip media; they do not deform it along curved edges.
- Provide media-fill opacity separately from whole-object opacity. Visual opacity never changes audio volume.
- Support editable pivots, local/world movement axes, and rotation around the object pivot or a chosen world point. Moving a pivot alone preserves the artwork’s position.
- Constrained anchors are visibly locked, with an explicit Edit Attachment action.
- “Optimize for Motion / Static” is a rendering hint, with automatic classification and manual override. Caches invalidate when necessary and never alter story behavior.

### Assemblies and libraries

- Assemble named parts using parent-child relationships and Fixed, Hinge, or Slider attachments, with optional limits.
- Initially allow one parent attachment per part and prohibit cycles. Exclude advanced skeletons, automatic walking, and general physics.
- Save assemblies with their construction, assets, animation clips, and associated audio.
- A clip may contain one pose or multiple keyframes, but always has positive duration.
- Keep whole-assembly scene transforms separate from internal clip animation.
- Editing shared definitions updates their instances; editing placed clip animation affects that instance. Updating the shared clip is explicit.
- Export/import self-contained assembly archives. Import remaps identities and preserves internal references.
- Connect session-only component libraries to local directories containing complete assemblies and audio. Show relevant files in a tree with adjustable depth, default four.
- Preview before insertion. Copy inserted assets into the project; do not depend on the library afterward.
- Support directory handles where available and folder-selection snapshots elsewhere, with explicit refresh/reselection when needed.

## Timeline, text, and audio behavior

### Timeline and animation

- Organize rows around objects, with expandable clips and properties and a small easing/curve editor.
- Allow timeline-only sections/tags and hiding, with a persistent hidden-content indicator. Selected rows remain discoverable.
- Filter rows by whether they affect the visible time range, including held poses, loops, and interpolations with offscreen endpoints. Provide Show All.
- Support playhead scrubbing and snapping to frames, playhead, clip edges, and sequence boundaries, with a temporary bypass.
- Distinguish moving, trimming, and retiming. Ordinary clips cannot extend beyond their source range unless looping is enabled. Minimum duration is one project frame.
- Sequence boundary trimming hides rather than deletes content. Moving, duplicating, or retiming a sequence carries its contents. Normal mode leaves later content fixed; Ripple shifts later sequences.
- Provide smooth, held, and stepped motion; easing families include Linear, Sine, Quad, Cubic, Quart, Quint, Exponential, Circular, Back, Bounce, and Elastic, with applicable directional variants and reusable presets.
- Include follow-path, oscillation, and seeded shake behaviors with bounded controls; no expression language or scripting.
- Evaluate animation per property. Overlaps blend by default, with explicit priority override. Later-starting clips blend over preceding results; equal-start ties use a visible stable order.
- Use shortest-path rotation by default, with explicit turns for spins. Respect attachment limits and bounded values.
- Automatically fill gaps between clips with visible, selectable tween segments; allow Hold instead and adjustable easing.
- Hold the last pose after a clip until superseded, within the object’s visibility span.
- Texture conflicts alternate at a regular adjustable cadence tied to project time; default four switches per second. Alternatives are a single adjustable switch, Hold Outgoing, and Use Incoming. Identical textures do not alternate.
- Other discrete properties switch at an adjustable point, default midpoint.
- The assembly master view consolidates constituent animation without duplicating it. Source keys remain editable; the combined result is a read-only curve preview.
- Show assembly audio as ordinary editable lanes, not an event system.

### Sequence composition

- Permit sequential and overlapping sequence placements.
- Each placement references a source sequence and exposes source range, timing, speed, frame/crop, transform, opacity, and mixed audio.
- Provide split-screen, picture-in-picture, and grid arrangement presets.
- Editing the source updates placements; Make Independent Copy creates a variation.
- Keep internal tracks inside the source editing context and reject circular sequence references.
- Automatically mute a newly inserted simultaneous duplicate of the same source. Clearly indicate the mute and leave subsequent settings under user control.

### Text

- Provide Google Fonts selection and local font import; package used font files and required notices with projects and exports.
- Distinguish clipping text to shapes, laying text inside/around shapes, and using text as a mask for images/video.
- Live layout reflows with changing geometry. Static layout retains arranged positions while preserving editable text; text/font edits explicitly regenerate layout.
- Use stable word identities during reflow.
- Include word/line reveal, fade, slide, scale, rotate, wave, seeded scatter/assemble, and animated reflow presets with shared timing/easing controls.
- Keep viewer captions separate from artistic text. Provide manually editable timed caption tracks.

### Audio and video

- Imported and microphone-recorded audio produce equivalent editable clips with waveform, trim, split, duplicate, volume, fades, mute, and overlap.
- Record while the scene plays by default; allow existing audio to be muted. Microphone monitoring defaults off. Provide recording-offset adjustment.
- Provide ordered, bypassable echo, chorus, compressor, distortion, EQ, reverb, and pitch effects with reset controls.
- Link speed and pitch by default, with a chain toggle and preference for new clips. Unlinked speed preserves pitch; independent pitch preserves duration. Toggling the link preserves current sound.
- Initially support positive speeds from 0.25× to 4× and independent pitch offsets of −24 to +24 semitones. Validate quality and surface limitations; no reverse playback initially.
- Video and embedded audio share timing, source offset, trims, and speed. Their visual and audio effects remain independently editable.
- Account for effect history when seeking through preroll or processed caches. Show effect tails and include finite tails in exports; cap feedback and tail duration to avoid unbounded rendering.
- Supply explicit video end behavior, default Hold Last Frame, with Hide available.

## Architecture, storage, and export

### Implementation foundation

- Use TypeScript, React, and Vite to produce static editor/player builds.
- Maintain a renderer-independent, versioned project model for assets, shapes, text, assemblies, clips, sequences, captions, and settings.
- Use a shared deterministic evaluator taking project time to produce scene state. Keep editable project data, workspace state, and runtime caches separate.
- Use PixiJS/WebGL for rendering and Pretext for text measurement/layout. Reuse the same rendering engine in editor preview, standalone player, and frame export.
- Use Web Audio for effects and mixing; validate Signalsmith Stretch for independent pitch/time processing. Use shared effect definitions for preview and export.
- Use Mediabunny/WebCodecs where supported for timestamped media decoding and encoding, with capability checks and browser playback adapters as needed.
- Drive live playback from an audio-clock anchor. Buffering pauses and rebases shared time; offline export advances by exact frame timestamps.
- Use workers for suitable processing, bounded caches, cancellation, and resource cleanup. Do not require a backend or cross-origin-isolation headers for basic operation.
- Validate candidate dependencies before locking versions. If a candidate fails, substitute the implementation behind the same interface; report material scope or behavior changes.

### Persistence and public file interfaces

- Use stable project IDs and content hashes for asset deduplication.
- Store project records in IndexedDB and large asset data in browser-private storage, with an IndexedDB fallback.
- Provide autosave checkpoints, interruption recovery, quota/error reporting, and separate “Autosaved in this browser” versus “Saved to project file” states.
- Use versioned ZIP-compatible archives containing XML manifests, binary assets, fonts, and notices. Project archives use `.hyde` or `.hy`; complete assembly archives use `.hyproj`.
- Validate archive contents and references, reject unsafe paths and unsupported versions, and retain recovery options on import failure.
- Use direct file saves where supported and download/open fallbacks elsewhere.
- No accounts, cloud project storage, server rendering, or hosting of user stories.

### Playback and exports

- Standalone web packages contain relative-path HTML, runtime, styles, manifest, captions, fonts, and media, with no editor/CDN dependency.
- Exported HTML must open directly through `file://` without CORS setup and also work from independent static HTTPS hosting.
- Provide poster frame, icon controls with accessible labels for play/pause, seeking, volume, fullscreen, captions and replay, plus optional looping and creator-configurable control visibility.
- Scroll seeking is optional and off by default. End on the final frame by default.
- Prepare upcoming media, show loading status when needed, and pause the shared clock during buffering.
- Video export offers whole-project or selected-range rendering, resolution, frame rate, quality, and capability-tested formats. Emphasize a Recommended format for the actual browser/device.
- GIF uses the same frame sampler with dimensions, frame rate, range, and looping; label it silent and flatten against a chosen background.
- Include progress, cancellation, clear failures, and cleanup. Minor browser rendering/encoding differences are acceptable; missing content and synchronization failures are not.

## Internal milestones and acceptance

| Milestone | Required confirmation |
|---|---|
| **1. Technical foundation** | Validate rendering primitives, seeking/synchronization, pitch processing, persistent storage, codec capabilities, and standalone playback across target browser engines. Document actual-browser verification gaps. |
| **2. Stage and editing** | Build and reopen a textured, masked composition with paths, camera, transforms, history, recovery, and working editor controls. |
| **3. Assemblies and timeline** | Complete the box/hinge workflow, reusable clips, master edits, blending, transitions, nested sequences, libraries, and assembly round trips. |
| **4. Media and typography** | Integrate recording, effects, linked video/audio, creative text, packaged fonts, and captions. Prepare a short sample for your subjective review. |
| **5. Playback and export** | Produce video, GIF, and isolated web packages; validate buffering, selected ranges, tails, cancellation, and sustained export memory use. |
| **6. Completion review** | Finish cross-browser regression, accessibility, performance, recovery, documentation, example projects, and deployment packaging. Resolve agreed-scope defects before calling the editor complete. |

Automated coverage includes deterministic time evaluation, blending order, texture cadence, constraints, nested timing, undo, archive round trips, dependency remapping, and failure recovery. Integration fixtures include beep/flash synchronization, backward seeks, reverb-tail seeks, live/static text, recorded clips, duplicate-sequence audio, and matching preview/export timestamps.

Verify exported webpages with editor and CDN access blocked and under network throttling. Exercise keyboard workflows, storage exhaustion, interrupted saves, unsupported media, and missing fonts. Use automated browser tests and subagent reviews throughout; reserve your limited review time for the appearance, sound, and feel that automated checks cannot establish.

