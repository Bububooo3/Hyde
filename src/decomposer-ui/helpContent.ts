/** Short control guidance is shared by focus/hover/touch tooltips and info buttons. */
export const CONTROL_HELP:Record<string,string>={
  references:'Each reference keeps its original pixels. The primary image defines the construction pose; other views can provide matching and occlusion evidence.',
  regions:'A region is editable image geometry with a mask, contour and fill or source texture. Select one to correct its boundary or appearance.',
  parts:'A part groups one or more regions into an object you can name, move in a hierarchy and attach for later animation in Hyde.',
  modes:'Appearance first favors a close still-image reconstruction. Animation ready favors separately useful parts and possible joints. Neither creates motion.',
  hidden:'Suggest unseen continuations beneath opaque overlaps in Animation ready mode. They are uncertain estimates to inspect and approve, not recovered pixels.',
  color:'Lower values separate more similar colors and may make more regions. Higher values merge nearby colors into broader areas.',
  edge:'Higher values keep subtler source boundaries; lower values join more neighboring paint bands.',
  feature:'Higher values merge more small color islands. Lower values retain tiny details but may leave fragmented regions.',
  thin:'Keep narrow high-contrast strokes as separate regions during cleanup when the source supports them.',
  tolerance:'Lower values follow contours with more anchors. Higher values simplify paths, reducing edit points but risking detail loss.',
  original:'Show the imported source pixels without reconstructed geometry.',
  reconstruction:'Show Hyde-style regions and masks so you can inspect the editable result.',
  overlay:'Lay reconstruction over the source to spot shifted edges and missing areas.',
  sideBySide:'Place source and reconstruction together for direct visual comparison.',
  select:'Select a region or path anchor on the reconstruction canvas; then edit it in the inspector.',
  path:'Drag contour anchors and Bézier handles to correct a region boundary. This creates an editable manual path.',
  paintAdd:'Brush pixels into the selected region mask. Adjust radius and hardness for broad or soft corrections.',
  paintErase:'Brush pixels out of the selected region mask without erasing the original reference.',
  seedAdd:'Grow the selected mask from a clicked pixel using color tolerance and reach.',
  seedErase:'Remove a connected color area from the selected mask using a clicked seed.',
  landmark:'Click matching points in two references, then pair them to help align the views.',
  background:'Sample an opaque border color that should be treated as background; preview regeneration before applying.',
  pivotTool:'Place the selected part pivot on the canvas. It is the hinge or slider reference point in Hyde.',
  mask:'A mask says which source pixels belong to a region. Brush and seed tools change coverage; the original image is retained.',
  contour:'A closed editable path surrounds a region. Anchors and handles shape its boundary; holes remain cutouts.',
  bezier:'Incoming and outgoing handles bend the path near an anchor. Shorter handles tighten the curve.',
  texture:'Source texture uses original image pixels inside editable geometry. Flat fill uses an editable color instead.',
  layer:'Front/back order controls visible overlap. A proposed relation needs review before approval; it is separate from part parenting.',
  match:'Correspondence links the same part across references. Ambiguous candidates need your confirmation; views do not create animation.',
  uncertainty:'Amber inferred regions estimate hidden material. Inspect evidence, edit or suppress them before relying on a joint pose.',
  locks:'Lock a manual mask, contour, part assignment, pivot or attachment to protect it from accidental edits or regeneration.',
  regenerate:'Preview a fresh analysis after changing mode, settings or source evidence. Your current document stays intact until confirmation.',
  impact:'Compare proposed region changes and protected edits before applying. Cancel leaves the current decomposition unchanged.',
  parent:'Parenting builds the part hierarchy for articulation. It does not determine which region is drawn in front.',
  pivot:'The pivot is the part’s attachment point in source pixels. Set it at the intended joint or contact point.',
  attachment:'Fixed follows its parent; Hinge rotates; Slider translates. Suggestions require your judgment and optional limits.',
  pose:'Preview a temporary hinge angle or slider offset in Hyde. The saved construction pose and export are unchanged.',
  quality:'Compare the native Hyde render with the source. Similar pixels do not prove the regions are useful for editing or animation.',
  diagnostics:'Diagnostics flag uncertainty, unsupported detail or export concerns. Select a linked item to focus its source or region.',
  save:'Save source downloads .hydecomp with original references, masks, edits and annotations so you can continue later.',
  export:'Export .hyproj for a reusable Hyde assembly or .hyde for a complete editable Hyde project. Save .hydecomp separately for future decomposition edits.',
  splitMerge:'Split one region along a vertical or horizontal line, or merge selected regions when one editable shape would be more useful.',
  brush:'A larger radius covers more pixels. Lower hardness makes a softer coverage edge; mask topology remains editable.',
  seed:'Higher tolerance accepts less-similar colors; greater reach explores farther from the clicked pixel.',
  snap:'Snap path anchors toward nearby source edges. Reduce reach when a nearby unrelated edge attracts the anchor.',
  feather:'Extend coverage outside an edited contour into nearby free pixels. Keep the original mask for undo and recovery.',
  alignment:'Use paired landmarks to align an alternate image when one affine transform describes both views.',
};

export interface HelpTopic {id:string;title:string;intro:string;steps:string[]}
export const HELP_TOPICS:HelpTopic[]=[
  {id:'start',title:'Getting started',intro:'The Decomposer runs locally in your browser. It turns a stylized illustration into editable Hyde geometry without an account or server project storage.',steps:[
    'Import a PNG, JPEG or WebP illustration. The automatic first pass creates regions and parts; inspect it before editing.',
    'Use Side by side or Overlay to compare the original with the reconstruction. Select a region where a boundary or color looks wrong.',
    'Adjust settings through Preview settings impact, or use a brush, seed or path edit for one region. Confirm regeneration only after reviewing the proposed changes.',
    'Save a .hydecomp working source. Export .hyproj for a reusable assembly or .hyde for a complete Story Studio project.'
  ]},
  {id:'interface',title:'Understanding the interface',intro:'The panels separate source evidence, editable geometry and final delivery.',steps:[
    'References lists imported images. The primary reference defines the editable construction pose; additional views provide evidence.',
    'Regions are individual masks, contours and fills. A part can contain one or more regions and has its own name, pivot and optional attachment.',
    'The center canvas compares source and reconstruction. The right inspector edits the selected region or part. Diagnostics at the bottom point to issues worth reviewing.'
  ]},
  {id:'settings',title:'Reconstruction settings',intro:'Change one setting at a time and preview its impact before confirming.',steps:[
    'Appearance first emphasizes the still image. Animation ready prioritizes logical pieces that may be articulated; neither generates animation.',
    'Lower color granularity separates similar colors; higher merges them. Higher edge sensitivity retains subtler boundaries. Higher minimum feature size merges tiny islands.',
    'Preserve thin lines keeps narrow high-contrast strokes. Lower path tolerance follows more detail with more anchors; higher tolerance simplifies paths.',
    'A regeneration preview shows changed, removed and protected regions. Cancel leaves the current document untouched.'
  ]},
  {id:'geometry',title:'Editing geometry',intro:'Start with a selected region so local corrections stay focused.',steps:[
    'The add and subtract brushes change mask coverage. Seeds grow or remove connected areas by sampled color; adjust tolerance and reach if they spread too far.',
    'Edit path and handles moves anchors or Bézier handles around a contour. Use split or merge when the current region grouping is wrong.',
    'Assign regions to a part in the inspector. Several colored or textured regions can belong to one logical arm or prop.',
    'Lock a corrected mask or path before trying broad regeneration. Undo and Save source keep the work recoverable.'
  ]},
  {id:'animation',title:'Animation-ready preparation',intro:'Articulation is optional and remains editable after native export.',steps:[
    'Choose Animation ready when you need separately usable parts. Set a parent for each child part and place the pivot at its intended contact or joint.',
    'Fixed follows the parent, Hinge rotates, and Slider moves along an axis. Review proposed parent, type and pivot before accepting; proposals are suggestions.',
    'Set limits only when useful. Preview a temporary joint pose to inspect how the exported Hyde parts behave; this does not save motion or alter the construction pose.'
  ]},
  {id:'references',title:'Multiple reference images',intro:'Additional stills help identify parts and overlap. They are not animation frames.',steps:[
    'Import related views, select an alternate reference, and compare it with the primary construction pose.',
    'Confirm or reject candidate same-part matches. Pair landmarks and align a reference only when one transform reasonably maps the views.',
    'Matched, aligned views can provide front/back evidence or an uncertain hidden continuation. Inspect and approve those proposals yourself; unseen geometry is not ground truth.'
  ]},
  {id:'quality',title:'Quality and limitations',intro:'A close picture and useful editable construction are related but different goals.',steps:[
    'Preview in Hyde to check silhouette, color error, missing coverage and complexity at source resolution. Use the residual overlay to locate visible differences.',
    'Low-resolution or busy source art can merge details or fragment regions. Diagnostics describe evidence and uncertainty rather than guaranteeing a fix.',
    'Hidden areas and joint types may be guesses. Isolate, correct or suppress an inferred region, and judge whether each part is useful for the intended edit.'
  ]},
  {id:'files',title:'Saving and exporting',intro:'Keep the working source and the Hyde delivery file for different purposes.',steps:[
    'Save source downloads .hydecomp. It preserves original references, masks, paths, annotations, corrections and settings for reopening here.',
    'Export .hyproj when you want a reusable editable assembly to import into Story Studio.',
    'Export .hyde when you want a full native editable Hyde project. Both native formats can be used without the Decomposer, but do not replace .hydecomp as the decomposition working source.'
  ]},
  {id:'trouble',title:'Troubleshooting',intro:'Use the smallest correction that addresses the visible problem.',steps:[
    'If segmentation finds too little, try lower color granularity or higher edge sensitivity; if it fragments into many pieces, raise minimum feature size or color granularity.',
    'If a contour misses an edge, try path handles or a small mask edit. Reduce path tolerance for more detail, then preview before confirming regeneration.',
    'If an inferred part looks wrong, inspect its evidence, edit or suppress it, or reject the proposal. If native export warns, inspect Diagnostics and Preview in Hyde before using the output.'
  ]},
];

export const WALKTHROUGH_STEPS=[
  {target:'import',title:'Import an illustration',body:'Choose one or more PNG, JPEG or WebP images. Your files stay in this browser; importing starts an automatic first pass.'},
  {target:'regions',title:'Review editable regions',body:'Each region has its own mask and contour. After import, select one here to inspect or correct it.'},
  {target:'views',title:'Compare source and result',body:'Use Original, Reconstruction, Overlay or Side by side to find missing detail and shifted edges.'},
  {target:'settings',title:'Refine the reconstruction',body:'Adjust a setting and preview its impact, or select a region and use a brush, seed or path tool for a local fix.'},
  {target:'parts',title:'Organize parts',body:'Parts group one or more regions. For articulation, set a parent, pivot and optional attachment after you have useful pieces.'},
  {target:'delivery',title:'Save or export',body:'Save .hydecomp to resume decomposition later. Export .hyproj for an assembly or .hyde for a full editable Story Studio project.'},
] as const;

export const ONBOARDING_PREFERENCE='hyde-decomposer-onboarding-v1';
