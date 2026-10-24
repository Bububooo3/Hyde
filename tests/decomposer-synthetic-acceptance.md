# Synthetic decomposer acceptance fixtures

All artwork in `decomposerSyntheticFixtures.ts` is generated from primitive pixel operations in this repository. It uses no external source image, brand, font, or model output. Regenerate it by running the focused test; original PNG bytes are produced in memory.

| Fixture | Evidence exercised | Current measured boundary |
| --- | --- | --- |
| Simple icon | One isolated silhouette, exact source mask coverage, compact path | One visible region and one part; a single view cannot justify articulation. |
| Multicolor prop | Two contacting colors and animation-ready parts | Two independent regions and parts. Contact does not establish a joint. |
| Articulated character | Head, torso, arms, legs; guided pivot and hinge | Distinct editable regions and parts; no joint is automatically approved. A disposable hinge pose is shown in `docs/quality/02-animation-ready-character.png`. |
| Occlusion | A front patch enclosed by a back field | The visible interior opening is an editable native hole; the obscured back surface remains unknown. |
| Gradient/texture | High-frequency color within one silhouette | One raster-backed editable path. Texture color is not converted to vector paint. |
| Hole and islands | Transparent interior and disconnected island | Separate regions preserve the island; fitted inner contours export natively. Unfitted contours require explicit raster fallback. |
| Pixel art | Hard corners and multiple nested colors | Independent hard-edged regions; native holes are used where fitting succeeds. |
| Busy input | 26×26 opaque checkerboard | 676 one-pixel regions and parts; the engine reports insufficient structure and refuses a misleading fragment-based native export. This is not useful automatic part decomposition. |
| Repeated multi-view | Two identical regions in each view | Four possible matches are marked ambiguous and unapproved; a manual choice survives regeneration and `.hydecomp` reopen. No motion is inferred. |
| Malformed PNG | Bad signature and CRC | Import fails before changing an existing editable session. |

The path-to-mask score compares fitted contours with source masks inside the analysis engine; it is separate from Hyde browser render fidelity and human judgment. `src/decomposer/holes.node.test.ts` checks two native holes in actual Hyde pixels, and `docs/quality/` contains three bounded browser-rendered comparisons. Subjective part usefulness and articulation plausibility still need owner review. No universal numeric acceptance threshold is inferred from these fixtures.

Run: `npx vitest run src/decomposer/synthetic.acceptance.node.test.ts`.
