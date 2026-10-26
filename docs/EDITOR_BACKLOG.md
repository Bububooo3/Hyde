# Hyde Story Studio editor backlog

**Status:** Authorized for implementation on 2026-10-26 after SDK and Decomposer v1 acceptance. Source: owner hands-on editor testing, 2026-10-24.

## P0: existing functionality and shortcut bugs

### HYDE-001 — Polygon resizing

Stage resize handles and numeric dimensions must resize polygons consistently, including points, outline, fill, textures, masks and pivot. Respect parent attachments and transform constraints. Undo/redo and save/reopen must preserve geometry and dimensions.

### HYDE-002 — Copy/Paste and Undo with selected objects

`Ctrl+V` must paste while another object is selected; `Ctrl+Z` must undo the latest applicable edit regardless of selection. Preserve normal text editing in inputs. Pasted hierarchy, asset references and timing must remain correct. Multi-object paste and undo/redo must be consistent.

### HYDE-003 — Project Settings Background control

The Background label and color picker must never overlap at supported window sizes or when the settings window is resized. Both must remain readable and interactive.

### HYDE-004 — Ctrl+Y Redo (P1)

Add `Ctrl+Y` on Windows while retaining existing redo shortcuts. Redo must work with a selection and must not override native text editing.

## P1: selection, layers and editing

### HYDE-005 — Layer ordering access

Expose Bring Forward and Send Backward in both the stage and Layers panel context menus. Preserve existing entry points, operate on relevant selection and disable unavailable commands.

### HYDE-006 — Individual bounds in multi-selection

Show each selected element's bounding box and distinguish the primary selection. Keep decorations current under move, rotate, scale and animation, including nested elements and assemblies. Do not render them in exported stories.

### HYDE-007 — Bulk property editing

Apply compatible position, dimensions, rotation, opacity, fill and other property edits across the selection. Leave unsupported objects unchanged; respect each object's constraints, pivots, anchors, attachments and modifiers. Use appropriate relative or absolute semantics and report incompatible constraints. One edit must undo/redo as one action; show mixed values clearly.

### HYDE-008 — Multi-selection layer reordering

After HYDE-005, Bring Forward and Send Backward must move all applicable selected elements while preserving their relative order. Minimize incidental movement of unselected objects, respect hierarchy restrictions and support undo/redo.

### HYDE-009 — Exact shape-path point editing

Selecting one polygon/Bézier point must expose numeric X/Y fields and point-level grid snapping. Stage dragging and exact inputs must agree with local transforms, pivot and handles. Geometry must survive undo/redo and save/reopen.

### HYDE-010 — Color selection

Support typed/pasted hex colors and an on-screen eyedropper where browser capability permits. Invalid input must preserve the previous valid color. Synchronize text, picker and selected-element value, provide an unsupported-browser fallback, and work with compatible bulk edits.

## P2: geometry, masking and appearance

### HYDE-011 — Boolean shapes

Union, Separate, Negate and Intersect must produce genuine editable Hyde shapes compatible with path tools, persistence, rendering, animation, exports and undo/redo. Handle holes, disconnected components and degenerate outcomes safely. Preserve source geometry unless the user explicitly chooses a destructive operation. Define exact Negate and Separate semantics before implementation, especially with multiple operands.

### HYDE-012 — Object-based clip masking

Add a Mask Object context command and configuration panel with Include/Exclude mode and add/remove/list controls for multiple object references. Include shows target content inside mask geometry; Exclude hides content covered by mask geometry. Store relationships outside animatable property tracks. Referenced objects retain their own editable, independently animated geometry; the relationship itself is timeline-independent. Preserve references through edits, save/reopen and export. Define predictable deletion/duplication behavior; prevent invalid references and cycles. Match editor preview, standalone player, GIF and video output, with undo/redo.

### HYDE-013 — Shadow size and positioning

Add independent Size control and improve X/Y offset controls for shadows beneath, beside or diagonally offset from shapes. Preserve existing controls and project compatibility. Behavior under resize/transform and exported rendering must be consistent.

## Future implementation order and engineering rules

1. HYDE-001–004; then HYDE-005, 006 and 008; then HYDE-007, 009 and 010; then HYDE-013; then HYDE-011; then HYDE-012.
2. Preserve existing Hyde projects and native file compatibility. Reuse Hyde's shared evaluator, renderer, editing operations and serialization.
3. Expose relevant features through the editor and Agent SDK, with undo/redo and save/reopen for every state change. Keep selection decorations out of exports.
4. Test representative workflows and avoid unrelated features.

The owner authorized all 13 tickets on 2026-10-26. Track verified checkpoints in [PROGRESS.md](PROGRESS.md).
