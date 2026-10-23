export { DecompositionSession } from './session';
export { defaultSettings } from './types';
export { decodePng, encodePng, decodeSource, MAX_IMAGE_PIXELS } from './image';
export { encodeDecompositionDocument, decodeDecompositionDocument, validateDecompositionDocument } from './codec';
export { analyzeImage, fitMaskGeometry, proposeCorrespondences, ALGORITHM_VERSION } from './analysis';
export { rankReferenceCorrespondences } from './correspondence';
export { proposePartAttachments } from './articulation';
export { poseNativeDecomposition } from './pose';
export type { CorrespondenceOptions, CorrespondenceRanking } from './correspondence';
export { exportNativeDecomposition } from './export';
export { compareNativeRender } from './quality';
export type { NativeRenderComparisonOptions, ReconstructionQualityReport } from './quality';
export type { DecompositionEdit, DecompositionEditResult } from './session';
export type { DecodedImage } from './image';
export type { HydeDecompositionExport, HydeDecompositionExportOptions } from './export';
export type {
  DecompositionMode, DecompositionDocumentV1, DecompositionDiagnostic, DecompositionDiagnosticCode, SourceRole,
  ReconstructionSettings, SourceInput, SourceReference, RegionRecord, RegionGeometry, RegionMask,
  PartRecord, CorrespondenceRecord, LayerRecord, Box, Point,
} from './types';
