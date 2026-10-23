# Synthetic decomposer acceptance fixtures

All artwork in `decomposerSyntheticFixtures.ts` is generated from primitive pixel operations in this repository. It uses no external source image, brand, font, or model output. Regenerate it by running the focused test; original PNG bytes are produced in memory.

| Fixture | Evidence exercised | Current measured boundary |
| --- | --- | --- |
| Simple icon | One isolated silhouette, exact source mask coverage, compact path | One visible region and one part; a single view cannot justify articulation. |
| Multicolor prop | Two contacting colors and animation-ready parts | Two independent regions and parts. Contact does not establish a joint. |
| Articulated character | Head, torso, arms, legs; guided pivot and hinge | Six regions and parts; no joint is automatically approved. Sampled path-to-mask IoU is about 0.827 before manual correction. |
| Occlusion | A front patch enclosed by a back field | One path has a hole. Export requires explicit hole approximation; the obscured back surface is unknown. Sampled path-to-mask IoU is about 0.887. |
| Gradient/texture | High-frequency color within one silhouette | One raster-backed editable path. Texture color is not converted to vector paint. |
| Hole and islands | Transparent interior and disconnected island | Two regions; native export requires explicit hole approximation. Sampled path-to-mask IoU is about 0.931. |
| Pixel art | Hard corners and multiple nested colors | Five regions, with hole warnings. Sampled path-to-mask IoU is about 0.869; exact native render pixels are not established by this Node test. |
| Busy input | 26×26 opaque checkerboard | 676 one-pixel regions and parts; the engine reports insufficient structure and refuses a misleading fragment-based native export. This is not useful automatic part decomposition. |
| Repeated multi-view | Two identical regions in each view | Four possible matches are marked ambiguous and unapproved; a manual choice survives regeneration and `.hydecomp` reopen. No motion is inferred. |
| Malformed PNG | Bad signature and CRC | Import fails before changing an existing editable session. |

The numeric IoU values above compare fitted paths with source masks sampled by the analysis engine. They are **not** Hyde browser render fidelity scores or human judgments. Visual quality, texture alignment, antialiasing, compositing, and useful articulation still need the actual Hyde-rendered reference comparisons and owner review described in the product specification. No universal numeric acceptance threshold is inferred from these synthetic fixtures.

Run: `npx vitest run src/decomposer/synthetic.acceptance.node.test.ts`.
