import type { Attachment, ShapePath } from '../model';

export type DecompositionMode = 'appearance' | 'animation-ready';
export type SourceRole = 'primary' | 'alternate-view' | 'alternate-pose' | 'detail' | 'mask-guide';
export type DecompositionDiagnosticCode =
  | 'UNSUPPORTED_SOURCE' | 'IMAGE_TOO_LARGE' | 'DECODE_FAILURE' | 'COLOR_SPACE_WARNING'
  | 'BACKGROUND_AMBIGUOUS' | 'INSUFFICIENT_STRUCTURE' | 'LOW_CONTRAST_BOUNDARY' | 'AMBIGUOUS_REGION'
  | 'CORRESPONDENCE_AMBIGUOUS' | 'LAYER_CONFLICT' | 'OCCLUSION_UNDERCONSTRAINED' | 'HIDDEN_GEOMETRY_INFERRED'
  | 'PATH_SELF_INTERSECTS' | 'PATH_TOO_COMPLEX' | 'HOLE_NOT_REPRESENTABLE' | 'TEXTURE_APPROXIMATION'
  | 'PART_PARENT_CYCLE' | 'INVALID_JOINT_LIMIT' | 'UNSUPPORTED_NATIVE_FEATURE' | 'EXPORT_VALIDATION_FAILED'
  | 'DOCUMENT_VERSION_UNSUPPORTED' | 'DOCUMENT_CONFLICT' | 'CANCELED' | 'RESOURCE_LIMIT';

export interface Box { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }
export interface DecompositionDiagnostic {
  code: DecompositionDiagnosticCode;
  severity: 'info' | 'warning' | 'error';
  message: string;
  sourceId?: string;
  regionId?: string;
  partId?: string;
  bounds?: Box;
  suggestion?: string;
  /** Evidence based heuristic, never a calibrated probability. */
  evidence?: string[];
}

export interface ReconstructionSettings {
  colorStep: number;
  alphaThreshold: number;
  minRegionPixels: number;
  pathTolerance: number;
  maxPathPoints: number;
  preserveTexture: boolean;
  inferHiddenGeometry: boolean;
  groupingStrength: number;
}

export interface SourceReference {
  id: string;
  role: SourceRole;
  name: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  byteHash: string;
  byteLength: number;
  /** Hash of the analysis RGBA interpretation, stored separately from originals. */
  pixelHash: string;
  width: number;
  height: number;
  orientation: 'oriented';
  colorSpace: 'srgb-assumed';
  transformToPrimary?: [number, number, number, number, number, number];
  alphaFraction: number;
}

export interface RegionGeometry {
  id: string;
  /** Generated geometry and manual overrides are distinct fields. */
  generatedPath: ShapePath;
  manualPath?: ShapePath;
  bounds: Box;
  status: 'visible' | 'inferred';
  quality: { maskIoU: number; pathPointCount: number; colorError: number };
  texture: 'flat' | 'source-crop';
  locked: boolean;
}

export interface RegionRecord {
  id: string;
  sourceId: string;
  maskId: string;
  bounds: Box;
  pixelCount: number;
  classification: 'foreground' | 'background';
  color: string;
  colorVariance: number;
  confidence: { kind: 'heuristic'; reasons: string[] };
  provenance: { algorithmVersion: string; settingsFingerprint: string };
  generationStatus: 'generated' | 'manual' | 'historical';
  locked: { mask: boolean; geometry: boolean; part: boolean };
  lineage: { parents: string[]; children: string[] };
  partId?: string;
  geometry: RegionGeometry;
  holeCount: number;
  adjacency: { regionId: string; sharedBoundary: number; colorDistance: number }[];
  /** An immutable source mask remains available after a manual mask edit. */
  originalMaskId?: string;
  /** A reversible user decision; suppressed inferred geometry remains in .hydecomp. */
  suppressed?: boolean;
}

export interface PartRecord {
  id: string;
  name: string;
  regionIds: string[];
  parentId?: string;
  bounds: Box;
  pivot: Point;
  pivotLocked: boolean;
  attachment?: Pick<Attachment, 'type' | 'min' | 'max'>;
  attachmentApproved: boolean;
  /** Unapproved contact-based suggestion; native export ignores it until accepted. */
  attachmentProposal?: { parentId: string; type: 'fixed' | 'hinge'; pivot: Point; evidence: string[]; ambiguity?: string };
  attachmentProposalRejected?: boolean;
  hiddenGeometry: 'none' | 'inferred' | 'user-authored';
  zOrder: number;
  transformLocked: boolean;
}

export interface CorrespondenceRecord {
  id: string;
  sourceIds: [string, string];
  regionIds?: [string, string];
  partIds?: [string, string];
  kind: 'same-part' | 'possible-match' | 'front-back-evidence' | 'source-alignment' | 'landmark';
  /** Source-space pixel locations in the same order as sourceIds. */
  landmarkPoints?: [Point, Point];
  origin: 'automatic' | 'manual';
  evidence: string[];
  ambiguity?: string;
  accepted?: boolean;
}

export interface LayerRecord {
  id: string;
  frontRegionId: string;
  backRegionId: string;
  origin: 'automatic' | 'manual';
  evidence: string[];
  status: 'proposed' | 'approved' | 'conflict';
}

export interface DecompositionDocumentV1 {
  format: 'hyde-decomposition';
  schemaVersion: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  algorithmVersion: string;
  mode: DecompositionMode;
  settings: ReconstructionSettings;
  sources: SourceReference[];
  regions: RegionRecord[];
  parts: PartRecord[];
  correspondences: CorrespondenceRecord[];
  layers: LayerRecord[];
  diagnostics: DecompositionDiagnostic[];
  exportMapping?: { sdkVersion: string; partIds: Record<string, string>; regionIds: Record<string, string>; warnings: string[]; fingerprint: string };
  history: { revision: number; operation: string; at: string; affectedIds: string[] }[];
}

export interface SourceInput {
  bytes: Uint8Array;
  name: string;
  mime: string;
  role?: SourceRole;
  /** A caller-supplied deterministic decode, useful in Node for JPEG/WebP. */
  decoded?: { width: number; height: number; rgba: Uint8Array };
}

export interface RegionMask {
  width: number;
  height: number;
  /** Binary editable topology used for contours and region ownership. */
  bytes: Uint8Array;
  /** Optional editable 0–255 coverage inside the binary mask. */
  alpha?: Uint8Array;
}

export function defaultSettings(mode: DecompositionMode): ReconstructionSettings {
  return {
    colorStep: mode === 'appearance' ? 24 : 40,
    alphaThreshold: 32,
    minRegionPixels: 4,
    pathTolerance: mode === 'appearance' ? 0.65 : 1.25,
    maxPathPoints: 512,
    preserveTexture: true,
    inferHiddenGeometry: mode === 'animation-ready',
    groupingStrength: mode === 'appearance' ? 0.35 : 0.65,
  };
}
