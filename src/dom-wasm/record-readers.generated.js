// Generated from dom-interfaces.json; do not edit.
import { layoutConstant } from "../wasm/layout-table.js";
export const DomBatchResultSize = layoutConstant("DomBatchResult_SIZE");
const DomBatchResult_status = layoutConstant("DomBatchResult_status");
const DomBatchResult_operationIndex = layoutConstant("DomBatchResult_operationIndex");
const DomBatchResult_opcode = layoutConstant("DomBatchResult_opcode");
const DomBatchResult_effect = layoutConstant("DomBatchResult_effect");
const DomBatchResult_effectHandle = layoutConstant("DomBatchResult_effectHandle");
const DomBatchResult_revision = layoutConstant("DomBatchResult_revision");
const DomBatchResult_errorKind = layoutConstant("DomBatchResult_errorKind");
const DomBatchResult_errorDetailA = layoutConstant("DomBatchResult_errorDetailA");
const DomBatchResult_errorDetailB = layoutConstant("DomBatchResult_errorDetailB");
const DomBatchResult_diagnosticPointer = layoutConstant("DomBatchResult_diagnosticPointer");
const DomBatchResult_diagnosticLength = layoutConstant("DomBatchResult_diagnosticLength");
const DomBatchResult_returnedPointer = layoutConstant("DomBatchResult_returnedPointer");
const DomBatchResult_returnedCount = layoutConstant("DomBatchResult_returnedCount");
const DomBatchResult_recordCount = layoutConstant("DomBatchResult_recordCount");
export function readDomBatchResult(view, pointer) { return {
  status: view.getUint32(pointer + DomBatchResult_status, true),
  operationIndex: view.getUint32(pointer + DomBatchResult_operationIndex, true),
  opcode: view.getUint32(pointer + DomBatchResult_opcode, true),
  effect: view.getUint32(pointer + DomBatchResult_effect, true),
  effectHandle: view.getBigUint64(pointer + DomBatchResult_effectHandle, true),
  revision: view.getBigUint64(pointer + DomBatchResult_revision, true),
  errorKind: view.getUint32(pointer + DomBatchResult_errorKind, true),
  errorDetailA: view.getInt32(pointer + DomBatchResult_errorDetailA, true),
  errorDetailB: view.getInt32(pointer + DomBatchResult_errorDetailB, true),
  diagnosticPointer: view.getUint32(pointer + DomBatchResult_diagnosticPointer, true),
  diagnosticLength: view.getUint32(pointer + DomBatchResult_diagnosticLength, true),
  returnedPointer: view.getUint32(pointer + DomBatchResult_returnedPointer, true),
  returnedCount: view.getUint32(pointer + DomBatchResult_returnedCount, true),
  recordCount: view.getUint32(pointer + DomBatchResult_recordCount, true),
}; }
export function writeDomBatchResult(view, pointer, value) {
  view.setUint32(pointer + DomBatchResult_status, value.status ?? 0, true);
  view.setUint32(pointer + DomBatchResult_operationIndex, value.operationIndex ?? 0, true);
  view.setUint32(pointer + DomBatchResult_opcode, value.opcode ?? 0, true);
  view.setUint32(pointer + DomBatchResult_effect, value.effect ?? 0, true);
  view.setBigUint64(pointer + DomBatchResult_effectHandle, value.effectHandle ?? 0n, true);
  view.setBigUint64(pointer + DomBatchResult_revision, value.revision ?? 0n, true);
  view.setUint32(pointer + DomBatchResult_errorKind, value.errorKind ?? 0, true);
  view.setInt32(pointer + DomBatchResult_errorDetailA, value.errorDetailA ?? 0, true);
  view.setInt32(pointer + DomBatchResult_errorDetailB, value.errorDetailB ?? 0, true);
  view.setUint32(pointer + DomBatchResult_diagnosticPointer, value.diagnosticPointer ?? 0, true);
  view.setUint32(pointer + DomBatchResult_diagnosticLength, value.diagnosticLength ?? 0, true);
  view.setUint32(pointer + DomBatchResult_returnedPointer, value.returnedPointer ?? 0, true);
  view.setUint32(pointer + DomBatchResult_returnedCount, value.returnedCount ?? 0, true);
  view.setUint32(pointer + DomBatchResult_recordCount, value.recordCount ?? 0, true);
}
export const DomBatchResultFields = Object.freeze({ status: DomBatchResult_status, operationIndex: DomBatchResult_operationIndex, opcode: DomBatchResult_opcode, effect: DomBatchResult_effect, effectHandle: DomBatchResult_effectHandle, revision: DomBatchResult_revision, errorKind: DomBatchResult_errorKind, errorDetailA: DomBatchResult_errorDetailA, errorDetailB: DomBatchResult_errorDetailB, diagnosticPointer: DomBatchResult_diagnosticPointer, diagnosticLength: DomBatchResult_diagnosticLength, returnedPointer: DomBatchResult_returnedPointer, returnedCount: DomBatchResult_returnedCount, recordCount: DomBatchResult_recordCount });
export const ImageJoinInfoSize = layoutConstant("ImageJoinInfo_SIZE");
const ImageJoinInfo_identity = layoutConstant("ImageJoinInfo_identity");
const ImageJoinInfo_kind = layoutConstant("ImageJoinInfo_kind");
const ImageJoinInfo_sourcePointer = layoutConstant("ImageJoinInfo_sourcePointer");
const ImageJoinInfo_sourceLength = layoutConstant("ImageJoinInfo_sourceLength");
const ImageJoinInfo_resourceIdentifier = layoutConstant("ImageJoinInfo_resourceIdentifier");
const ImageJoinInfo_imageIndex = layoutConstant("ImageJoinInfo_imageIndex");
const ImageJoinInfo_failure = layoutConstant("ImageJoinInfo_failure");
const ImageJoinInfo_errorHandle = layoutConstant("ImageJoinInfo_errorHandle");
const ImageJoinInfo_resourceHandle = layoutConstant("ImageJoinInfo_resourceHandle");
export function readImageJoinInfo(view, pointer) { return {
  identity: view.getUint32(pointer + ImageJoinInfo_identity, true),
  kind: view.getUint32(pointer + ImageJoinInfo_kind, true),
  sourcePointer: view.getUint32(pointer + ImageJoinInfo_sourcePointer, true),
  sourceLength: view.getUint32(pointer + ImageJoinInfo_sourceLength, true),
  resourceIdentifier: view.getUint32(pointer + ImageJoinInfo_resourceIdentifier, true),
  imageIndex: view.getUint32(pointer + ImageJoinInfo_imageIndex, true),
  failure: view.getUint32(pointer + ImageJoinInfo_failure, true),
  errorHandle: view.getUint32(pointer + ImageJoinInfo_errorHandle, true),
  resourceHandle: view.getBigUint64(pointer + ImageJoinInfo_resourceHandle, true),
}; }
export function writeImageJoinInfo(view, pointer, value) {
  view.setUint32(pointer + ImageJoinInfo_identity, value.identity ?? 0, true);
  view.setUint32(pointer + ImageJoinInfo_kind, value.kind ?? 0, true);
  view.setUint32(pointer + ImageJoinInfo_sourcePointer, value.sourcePointer ?? 0, true);
  view.setUint32(pointer + ImageJoinInfo_sourceLength, value.sourceLength ?? 0, true);
  view.setUint32(pointer + ImageJoinInfo_resourceIdentifier, value.resourceIdentifier ?? 0, true);
  view.setUint32(pointer + ImageJoinInfo_imageIndex, value.imageIndex ?? 0, true);
  view.setUint32(pointer + ImageJoinInfo_failure, value.failure ?? 0, true);
  view.setUint32(pointer + ImageJoinInfo_errorHandle, value.errorHandle ?? 0, true);
  view.setBigUint64(pointer + ImageJoinInfo_resourceHandle, value.resourceHandle ?? 0n, true);
}
export const ImageJoinInfoFields = Object.freeze({ identity: ImageJoinInfo_identity, kind: ImageJoinInfo_kind, sourcePointer: ImageJoinInfo_sourcePointer, sourceLength: ImageJoinInfo_sourceLength, resourceIdentifier: ImageJoinInfo_resourceIdentifier, imageIndex: ImageJoinInfo_imageIndex, failure: ImageJoinInfo_failure, errorHandle: ImageJoinInfo_errorHandle, resourceHandle: ImageJoinInfo_resourceHandle });
export const ImageRequestSize = layoutConstant("ImageRequest_SIZE");
const ImageRequest_identity = layoutConstant("ImageRequest_identity");
const ImageRequest_kind = layoutConstant("ImageRequest_kind");
const ImageRequest_sourcePointer = layoutConstant("ImageRequest_sourcePointer");
const ImageRequest_sourceLength = layoutConstant("ImageRequest_sourceLength");
const ImageRequest_resourceIdentifier = layoutConstant("ImageRequest_resourceIdentifier");
const ImageRequest_imageIndex = layoutConstant("ImageRequest_imageIndex");
const ImageRequest_failure = layoutConstant("ImageRequest_failure");
const ImageRequest_errorHandle = layoutConstant("ImageRequest_errorHandle");
const ImageRequest_resourceHandle = layoutConstant("ImageRequest_resourceHandle");
const ImageRequest_node = layoutConstant("ImageRequest_node");
const ImageRequest_property = layoutConstant("ImageRequest_property");
const ImageRequest_layer = layoutConstant("ImageRequest_layer");
const ImageRequest_requiredDecode = layoutConstant("ImageRequest_requiredDecode");
export function readImageRequest(view, pointer) { return {
  identity: view.getUint32(pointer + ImageRequest_identity, true),
  kind: view.getUint32(pointer + ImageRequest_kind, true),
  sourcePointer: view.getUint32(pointer + ImageRequest_sourcePointer, true),
  sourceLength: view.getUint32(pointer + ImageRequest_sourceLength, true),
  resourceIdentifier: view.getUint32(pointer + ImageRequest_resourceIdentifier, true),
  imageIndex: view.getUint32(pointer + ImageRequest_imageIndex, true),
  failure: view.getUint32(pointer + ImageRequest_failure, true),
  errorHandle: view.getUint32(pointer + ImageRequest_errorHandle, true),
  resourceHandle: view.getBigUint64(pointer + ImageRequest_resourceHandle, true),
  node: view.getUint32(pointer + ImageRequest_node, true),
  property: view.getUint32(pointer + ImageRequest_property, true),
  layer: view.getUint32(pointer + ImageRequest_layer, true),
  requiredDecode: view.getUint32(pointer + ImageRequest_requiredDecode, true),
}; }
export function writeImageRequest(view, pointer, value) {
  view.setUint32(pointer + ImageRequest_identity, value.identity ?? 0, true);
  view.setUint32(pointer + ImageRequest_kind, value.kind ?? 0, true);
  view.setUint32(pointer + ImageRequest_sourcePointer, value.sourcePointer ?? 0, true);
  view.setUint32(pointer + ImageRequest_sourceLength, value.sourceLength ?? 0, true);
  view.setUint32(pointer + ImageRequest_resourceIdentifier, value.resourceIdentifier ?? 0, true);
  view.setUint32(pointer + ImageRequest_imageIndex, value.imageIndex ?? 0, true);
  view.setUint32(pointer + ImageRequest_failure, value.failure ?? 0, true);
  view.setUint32(pointer + ImageRequest_errorHandle, value.errorHandle ?? 0, true);
  view.setBigUint64(pointer + ImageRequest_resourceHandle, value.resourceHandle ?? 0n, true);
  view.setUint32(pointer + ImageRequest_node, value.node ?? 0, true);
  view.setUint32(pointer + ImageRequest_property, value.property ?? 0, true);
  view.setUint32(pointer + ImageRequest_layer, value.layer ?? 0, true);
  view.setUint32(pointer + ImageRequest_requiredDecode, value.requiredDecode ?? 0, true);
}
export const ImageRequestFields = Object.freeze({ identity: ImageRequest_identity, kind: ImageRequest_kind, sourcePointer: ImageRequest_sourcePointer, sourceLength: ImageRequest_sourceLength, resourceIdentifier: ImageRequest_resourceIdentifier, imageIndex: ImageRequest_imageIndex, failure: ImageRequest_failure, errorHandle: ImageRequest_errorHandle, resourceHandle: ImageRequest_resourceHandle, node: ImageRequest_node, property: ImageRequest_property, layer: ImageRequest_layer, requiredDecode: ImageRequest_requiredDecode });
export const SvgPathDefinitionSize = layoutConstant("SvgPathDefinition_SIZE");
const SvgPathDefinition_index = layoutConstant("SvgPathDefinition_index");
const SvgPathDefinition_dataPointer = layoutConstant("SvgPathDefinition_dataPointer");
const SvgPathDefinition_dataLength = layoutConstant("SvgPathDefinition_dataLength");
const SvgPathDefinition_fillRule = layoutConstant("SvgPathDefinition_fillRule");
const SvgPathDefinition_stroked = layoutConstant("SvgPathDefinition_stroked");
const SvgPathDefinition_strokeWidth = layoutConstant("SvgPathDefinition_strokeWidth");
const SvgPathDefinition_cap = layoutConstant("SvgPathDefinition_cap");
const SvgPathDefinition_join = layoutConstant("SvgPathDefinition_join");
const SvgPathDefinition_miterLimit = layoutConstant("SvgPathDefinition_miterLimit");
const SvgPathDefinition_dashPointer = layoutConstant("SvgPathDefinition_dashPointer");
const SvgPathDefinition_dashCount = layoutConstant("SvgPathDefinition_dashCount");
const SvgPathDefinition_dashPhase = layoutConstant("SvgPathDefinition_dashPhase");
const SvgPathDefinition_deviceCoverage = layoutConstant("SvgPathDefinition_deviceCoverage");
const SvgPathDefinition_deviceA = layoutConstant("SvgPathDefinition_deviceA");
const SvgPathDefinition_deviceB = layoutConstant("SvgPathDefinition_deviceB");
const SvgPathDefinition_deviceC = layoutConstant("SvgPathDefinition_deviceC");
const SvgPathDefinition_deviceD = layoutConstant("SvgPathDefinition_deviceD");
const SvgPathDefinition_deviceE = layoutConstant("SvgPathDefinition_deviceE");
const SvgPathDefinition_deviceF = layoutConstant("SvgPathDefinition_deviceF");
const SvgPathDefinition_deviceWidth = layoutConstant("SvgPathDefinition_deviceWidth");
const SvgPathDefinition_deviceHeight = layoutConstant("SvgPathDefinition_deviceHeight");
const SvgPathDefinition_nonScalingStrokeScale = layoutConstant("SvgPathDefinition_nonScalingStrokeScale");
export function readSvgPathDefinition(view, pointer) { return {
  index: view.getUint32(pointer + SvgPathDefinition_index, true),
  dataPointer: view.getUint32(pointer + SvgPathDefinition_dataPointer, true),
  dataLength: view.getUint32(pointer + SvgPathDefinition_dataLength, true),
  fillRule: view.getUint32(pointer + SvgPathDefinition_fillRule, true),
  stroked: view.getUint32(pointer + SvgPathDefinition_stroked, true),
  strokeWidth: view.getFloat32(pointer + SvgPathDefinition_strokeWidth, true),
  cap: view.getUint32(pointer + SvgPathDefinition_cap, true),
  join: view.getUint32(pointer + SvgPathDefinition_join, true),
  miterLimit: view.getFloat32(pointer + SvgPathDefinition_miterLimit, true),
  dashPointer: view.getUint32(pointer + SvgPathDefinition_dashPointer, true),
  dashCount: view.getUint32(pointer + SvgPathDefinition_dashCount, true),
  dashPhase: view.getFloat32(pointer + SvgPathDefinition_dashPhase, true),
  deviceCoverage: view.getUint32(pointer + SvgPathDefinition_deviceCoverage, true),
  deviceA: view.getFloat32(pointer + SvgPathDefinition_deviceA, true),
  deviceB: view.getFloat32(pointer + SvgPathDefinition_deviceB, true),
  deviceC: view.getFloat32(pointer + SvgPathDefinition_deviceC, true),
  deviceD: view.getFloat32(pointer + SvgPathDefinition_deviceD, true),
  deviceE: view.getFloat32(pointer + SvgPathDefinition_deviceE, true),
  deviceF: view.getFloat32(pointer + SvgPathDefinition_deviceF, true),
  deviceWidth: view.getUint32(pointer + SvgPathDefinition_deviceWidth, true),
  deviceHeight: view.getUint32(pointer + SvgPathDefinition_deviceHeight, true),
  nonScalingStrokeScale: view.getFloat32(pointer + SvgPathDefinition_nonScalingStrokeScale, true),
}; }
export function writeSvgPathDefinition(view, pointer, value) {
  view.setUint32(pointer + SvgPathDefinition_index, value.index ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_dataPointer, value.dataPointer ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_dataLength, value.dataLength ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_fillRule, value.fillRule ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_stroked, value.stroked ?? 0, true);
  view.setFloat32(pointer + SvgPathDefinition_strokeWidth, value.strokeWidth ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_cap, value.cap ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_join, value.join ?? 0, true);
  view.setFloat32(pointer + SvgPathDefinition_miterLimit, value.miterLimit ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_dashPointer, value.dashPointer ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_dashCount, value.dashCount ?? 0, true);
  view.setFloat32(pointer + SvgPathDefinition_dashPhase, value.dashPhase ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_deviceCoverage, value.deviceCoverage ?? 0, true);
  view.setFloat32(pointer + SvgPathDefinition_deviceA, value.deviceA ?? 0, true);
  view.setFloat32(pointer + SvgPathDefinition_deviceB, value.deviceB ?? 0, true);
  view.setFloat32(pointer + SvgPathDefinition_deviceC, value.deviceC ?? 0, true);
  view.setFloat32(pointer + SvgPathDefinition_deviceD, value.deviceD ?? 0, true);
  view.setFloat32(pointer + SvgPathDefinition_deviceE, value.deviceE ?? 0, true);
  view.setFloat32(pointer + SvgPathDefinition_deviceF, value.deviceF ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_deviceWidth, value.deviceWidth ?? 0, true);
  view.setUint32(pointer + SvgPathDefinition_deviceHeight, value.deviceHeight ?? 0, true);
  view.setFloat32(pointer + SvgPathDefinition_nonScalingStrokeScale, value.nonScalingStrokeScale ?? 0, true);
}
export const SvgPathDefinitionFields = Object.freeze({ index: SvgPathDefinition_index, dataPointer: SvgPathDefinition_dataPointer, dataLength: SvgPathDefinition_dataLength, fillRule: SvgPathDefinition_fillRule, stroked: SvgPathDefinition_stroked, strokeWidth: SvgPathDefinition_strokeWidth, cap: SvgPathDefinition_cap, join: SvgPathDefinition_join, miterLimit: SvgPathDefinition_miterLimit, dashPointer: SvgPathDefinition_dashPointer, dashCount: SvgPathDefinition_dashCount, dashPhase: SvgPathDefinition_dashPhase, deviceCoverage: SvgPathDefinition_deviceCoverage, deviceA: SvgPathDefinition_deviceA, deviceB: SvgPathDefinition_deviceB, deviceC: SvgPathDefinition_deviceC, deviceD: SvgPathDefinition_deviceD, deviceE: SvgPathDefinition_deviceE, deviceF: SvgPathDefinition_deviceF, deviceWidth: SvgPathDefinition_deviceWidth, deviceHeight: SvgPathDefinition_deviceHeight, nonScalingStrokeScale: SvgPathDefinition_nonScalingStrokeScale });
export const SceneBuildBoxSize = layoutConstant("SceneBuildBox_SIZE");
const SceneBuildBox_kind = layoutConstant("SceneBuildBox_kind");
const SceneBuildBox_display = layoutConstant("SceneBuildBox_display");
const SceneBuildBox_flags = layoutConstant("SceneBuildBox_flags");
const SceneBuildBox_owner = layoutConstant("SceneBuildBox_owner");
const SceneBuildBox_handle = layoutConstant("SceneBuildBox_handle");
const SceneBuildBox_context = layoutConstant("SceneBuildBox_context");
const SceneBuildBox_childOffset = layoutConstant("SceneBuildBox_childOffset");
const SceneBuildBox_childCount = layoutConstant("SceneBuildBox_childCount");
const SceneBuildBox_textPointer = layoutConstant("SceneBuildBox_textPointer");
const SceneBuildBox_textLength = layoutConstant("SceneBuildBox_textLength");
const SceneBuildBox_whiteSpace = layoutConstant("SceneBuildBox_whiteSpace");
const SceneBuildBox_textTransform = layoutConstant("SceneBuildBox_textTransform");
const SceneBuildBox_host = layoutConstant("SceneBuildBox_host");
const SceneBuildBox_generatedImage = layoutConstant("SceneBuildBox_generatedImage");
const SceneBuildBox_font = layoutConstant("SceneBuildBox_font");
const SceneBuildBox_letterSpacing = layoutConstant("SceneBuildBox_letterSpacing");
const SceneBuildBox_stableId = layoutConstant("SceneBuildBox_stableId");
const SceneBuildBox_sourceRevision = layoutConstant("SceneBuildBox_sourceRevision");
export function readSceneBuildBox(view, pointer) { return {
  kind: view.getUint8(pointer + SceneBuildBox_kind, true),
  display: view.getUint8(pointer + SceneBuildBox_display, true),
  flags: view.getUint16(pointer + SceneBuildBox_flags, true),
  owner: view.getInt32(pointer + SceneBuildBox_owner, true),
  handle: view.getBigUint64(pointer + SceneBuildBox_handle, true),
  context: view.getBigUint64(pointer + SceneBuildBox_context, true),
  childOffset: view.getUint32(pointer + SceneBuildBox_childOffset, true),
  childCount: view.getUint32(pointer + SceneBuildBox_childCount, true),
  textPointer: view.getUint32(pointer + SceneBuildBox_textPointer, true),
  textLength: view.getUint32(pointer + SceneBuildBox_textLength, true),
  whiteSpace: view.getUint8(pointer + SceneBuildBox_whiteSpace, true),
  textTransform: view.getUint8(pointer + SceneBuildBox_textTransform, true),
  host: view.getUint8(pointer + SceneBuildBox_host, true),
  generatedImage: view.getUint8(pointer + SceneBuildBox_generatedImage, true),
  font: view.getUint32(pointer + SceneBuildBox_font, true),
  letterSpacing: view.getFloat64(pointer + SceneBuildBox_letterSpacing, true),
  stableId: view.getBigUint64(pointer + SceneBuildBox_stableId, true),
  sourceRevision: view.getBigUint64(pointer + SceneBuildBox_sourceRevision, true),
}; }
export function writeSceneBuildBox(view, pointer, value) {
  view.setUint8(pointer + SceneBuildBox_kind, value.kind ?? 0, true);
  view.setUint8(pointer + SceneBuildBox_display, value.display ?? 0, true);
  view.setUint16(pointer + SceneBuildBox_flags, value.flags ?? 0, true);
  view.setInt32(pointer + SceneBuildBox_owner, value.owner ?? 0, true);
  view.setBigUint64(pointer + SceneBuildBox_handle, value.handle ?? 0n, true);
  view.setBigUint64(pointer + SceneBuildBox_context, value.context ?? 0n, true);
  view.setUint32(pointer + SceneBuildBox_childOffset, value.childOffset ?? 0, true);
  view.setUint32(pointer + SceneBuildBox_childCount, value.childCount ?? 0, true);
  view.setUint32(pointer + SceneBuildBox_textPointer, value.textPointer ?? 0, true);
  view.setUint32(pointer + SceneBuildBox_textLength, value.textLength ?? 0, true);
  view.setUint8(pointer + SceneBuildBox_whiteSpace, value.whiteSpace ?? 0, true);
  view.setUint8(pointer + SceneBuildBox_textTransform, value.textTransform ?? 0, true);
  view.setUint8(pointer + SceneBuildBox_host, value.host ?? 0, true);
  view.setUint8(pointer + SceneBuildBox_generatedImage, value.generatedImage ?? 0, true);
  view.setUint32(pointer + SceneBuildBox_font, value.font ?? 0, true);
  view.setFloat64(pointer + SceneBuildBox_letterSpacing, value.letterSpacing ?? 0, true);
  view.setBigUint64(pointer + SceneBuildBox_stableId, value.stableId ?? 0n, true);
  view.setBigUint64(pointer + SceneBuildBox_sourceRevision, value.sourceRevision ?? 0n, true);
}
export const SceneBuildBoxFields = Object.freeze({ kind: SceneBuildBox_kind, display: SceneBuildBox_display, flags: SceneBuildBox_flags, owner: SceneBuildBox_owner, handle: SceneBuildBox_handle, context: SceneBuildBox_context, childOffset: SceneBuildBox_childOffset, childCount: SceneBuildBox_childCount, textPointer: SceneBuildBox_textPointer, textLength: SceneBuildBox_textLength, whiteSpace: SceneBuildBox_whiteSpace, textTransform: SceneBuildBox_textTransform, host: SceneBuildBox_host, generatedImage: SceneBuildBox_generatedImage, font: SceneBuildBox_font, letterSpacing: SceneBuildBox_letterSpacing, stableId: SceneBuildBox_stableId, sourceRevision: SceneBuildBox_sourceRevision });
export const EngineSvgRequestSize = layoutConstant("EngineSvgRequest_SIZE");
const EngineSvgRequest_path = layoutConstant("EngineSvgRequest_path");
const EngineSvgRequest_length = layoutConstant("EngineSvgRequest_length");
const EngineSvgRequest_identity = layoutConstant("EngineSvgRequest_identity");
const EngineSvgRequest_fillRule = layoutConstant("EngineSvgRequest_fillRule");
const EngineSvgRequest_strokePresent = layoutConstant("EngineSvgRequest_strokePresent");
const EngineSvgRequest_width = layoutConstant("EngineSvgRequest_width");
const EngineSvgRequest_cap = layoutConstant("EngineSvgRequest_cap");
const EngineSvgRequest_join = layoutConstant("EngineSvgRequest_join");
const EngineSvgRequest_miterLimit = layoutConstant("EngineSvgRequest_miterLimit");
const EngineSvgRequest_dashArray = layoutConstant("EngineSvgRequest_dashArray");
const EngineSvgRequest_dashCount = layoutConstant("EngineSvgRequest_dashCount");
const EngineSvgRequest_dashPhase = layoutConstant("EngineSvgRequest_dashPhase");
const EngineSvgRequest_resourceRevision = layoutConstant("EngineSvgRequest_resourceRevision");
const EngineSvgRequest_nonScalingStroke = layoutConstant("EngineSvgRequest_nonScalingStroke");
export function readEngineSvgRequest(view, pointer) { return {
  path: view.getUint32(pointer + EngineSvgRequest_path, true),
  length: view.getUint32(pointer + EngineSvgRequest_length, true),
  identity: view.getBigUint64(pointer + EngineSvgRequest_identity, true),
  fillRule: view.getUint32(pointer + EngineSvgRequest_fillRule, true),
  strokePresent: view.getUint32(pointer + EngineSvgRequest_strokePresent, true),
  width: view.getFloat64(pointer + EngineSvgRequest_width, true),
  cap: view.getUint32(pointer + EngineSvgRequest_cap, true),
  join: view.getUint32(pointer + EngineSvgRequest_join, true),
  miterLimit: view.getFloat64(pointer + EngineSvgRequest_miterLimit, true),
  dashArray: view.getUint32(pointer + EngineSvgRequest_dashArray, true),
  dashCount: view.getUint32(pointer + EngineSvgRequest_dashCount, true),
  dashPhase: view.getFloat64(pointer + EngineSvgRequest_dashPhase, true),
  resourceRevision: view.getUint32(pointer + EngineSvgRequest_resourceRevision, true),
  nonScalingStroke: view.getUint32(pointer + EngineSvgRequest_nonScalingStroke, true),
}; }
export function writeEngineSvgRequest(view, pointer, value) {
  view.setUint32(pointer + EngineSvgRequest_path, value.path ?? 0, true);
  view.setUint32(pointer + EngineSvgRequest_length, value.length ?? 0, true);
  view.setBigUint64(pointer + EngineSvgRequest_identity, value.identity ?? 0n, true);
  view.setUint32(pointer + EngineSvgRequest_fillRule, value.fillRule ?? 0, true);
  view.setUint32(pointer + EngineSvgRequest_strokePresent, value.strokePresent ?? 0, true);
  view.setFloat64(pointer + EngineSvgRequest_width, value.width ?? 0, true);
  view.setUint32(pointer + EngineSvgRequest_cap, value.cap ?? 0, true);
  view.setUint32(pointer + EngineSvgRequest_join, value.join ?? 0, true);
  view.setFloat64(pointer + EngineSvgRequest_miterLimit, value.miterLimit ?? 0, true);
  view.setUint32(pointer + EngineSvgRequest_dashArray, value.dashArray ?? 0, true);
  view.setUint32(pointer + EngineSvgRequest_dashCount, value.dashCount ?? 0, true);
  view.setFloat64(pointer + EngineSvgRequest_dashPhase, value.dashPhase ?? 0, true);
  view.setUint32(pointer + EngineSvgRequest_resourceRevision, value.resourceRevision ?? 0, true);
  view.setUint32(pointer + EngineSvgRequest_nonScalingStroke, value.nonScalingStroke ?? 0, true);
}
export const EngineSvgRequestFields = Object.freeze({ path: EngineSvgRequest_path, length: EngineSvgRequest_length, identity: EngineSvgRequest_identity, fillRule: EngineSvgRequest_fillRule, strokePresent: EngineSvgRequest_strokePresent, width: EngineSvgRequest_width, cap: EngineSvgRequest_cap, join: EngineSvgRequest_join, miterLimit: EngineSvgRequest_miterLimit, dashArray: EngineSvgRequest_dashArray, dashCount: EngineSvgRequest_dashCount, dashPhase: EngineSvgRequest_dashPhase, resourceRevision: EngineSvgRequest_resourceRevision, nonScalingStroke: EngineSvgRequest_nonScalingStroke });
export const CoreTransportBlockSize = layoutConstant("CoreTransportBlock_SIZE");
const CoreTransportBlock_poolKind = layoutConstant("CoreTransportBlock_poolKind");
const CoreTransportBlock_sourceBase = layoutConstant("CoreTransportBlock_sourceBase");
const CoreTransportBlock_data = layoutConstant("CoreTransportBlock_data");
const CoreTransportBlock_sourceLength = layoutConstant("CoreTransportBlock_sourceLength");
const CoreTransportBlock_format = layoutConstant("CoreTransportBlock_format");
const CoreTransportBlock_reserved = layoutConstant("CoreTransportBlock_reserved");
export function readCoreTransportBlock(view, pointer) { return {
  poolKind: view.getUint32(pointer + CoreTransportBlock_poolKind, true),
  sourceBase: view.getUint32(pointer + CoreTransportBlock_sourceBase, true),
  data: view.getUint32(pointer + CoreTransportBlock_data, true),
  sourceLength: view.getUint32(pointer + CoreTransportBlock_sourceLength, true),
  format: view.getUint32(pointer + CoreTransportBlock_format, true),
  reserved: view.getUint32(pointer + CoreTransportBlock_reserved, true),
}; }
export function writeCoreTransportBlock(view, pointer, value) {
  view.setUint32(pointer + CoreTransportBlock_poolKind, value.poolKind ?? 0, true);
  view.setUint32(pointer + CoreTransportBlock_sourceBase, value.sourceBase ?? 0, true);
  view.setUint32(pointer + CoreTransportBlock_data, value.data ?? 0, true);
  view.setUint32(pointer + CoreTransportBlock_sourceLength, value.sourceLength ?? 0, true);
  view.setUint32(pointer + CoreTransportBlock_format, value.format ?? 0, true);
  view.setUint32(pointer + CoreTransportBlock_reserved, value.reserved ?? 0, true);
}
export const CoreTransportBlockFields = Object.freeze({ poolKind: CoreTransportBlock_poolKind, sourceBase: CoreTransportBlock_sourceBase, data: CoreTransportBlock_data, sourceLength: CoreTransportBlock_sourceLength, format: CoreTransportBlock_format, reserved: CoreTransportBlock_reserved });
export const CoreTransportCaptureSize = layoutConstant("CoreTransportCapture_SIZE");
const CoreTransportCapture_record = layoutConstant("CoreTransportCapture_record");
const CoreTransportCapture_recordLength = layoutConstant("CoreTransportCapture_recordLength");
const CoreTransportCapture_blocks = layoutConstant("CoreTransportCapture_blocks");
const CoreTransportCapture_blockCount = layoutConstant("CoreTransportCapture_blockCount");
const CoreTransportCapture_flags = layoutConstant("CoreTransportCapture_flags");
const CoreTransportCapture_boxFlags = layoutConstant("CoreTransportCapture_boxFlags");
const CoreTransportCapture_stableId = layoutConstant("CoreTransportCapture_stableId");
const CoreTransportCapture_sourceRevision = layoutConstant("CoreTransportCapture_sourceRevision");
export function readCoreTransportCapture(view, pointer) { return {
  record: view.getUint32(pointer + CoreTransportCapture_record, true),
  recordLength: view.getUint32(pointer + CoreTransportCapture_recordLength, true),
  blocks: view.getUint32(pointer + CoreTransportCapture_blocks, true),
  blockCount: view.getUint32(pointer + CoreTransportCapture_blockCount, true),
  flags: view.getUint32(pointer + CoreTransportCapture_flags, true),
  boxFlags: view.getUint32(pointer + CoreTransportCapture_boxFlags, true),
  stableId: view.getBigUint64(pointer + CoreTransportCapture_stableId, true),
  sourceRevision: view.getBigUint64(pointer + CoreTransportCapture_sourceRevision, true),
}; }
export function writeCoreTransportCapture(view, pointer, value) {
  view.setUint32(pointer + CoreTransportCapture_record, value.record ?? 0, true);
  view.setUint32(pointer + CoreTransportCapture_recordLength, value.recordLength ?? 0, true);
  view.setUint32(pointer + CoreTransportCapture_blocks, value.blocks ?? 0, true);
  view.setUint32(pointer + CoreTransportCapture_blockCount, value.blockCount ?? 0, true);
  view.setUint32(pointer + CoreTransportCapture_flags, value.flags ?? 0, true);
  view.setUint32(pointer + CoreTransportCapture_boxFlags, value.boxFlags ?? 0, true);
  view.setBigUint64(pointer + CoreTransportCapture_stableId, value.stableId ?? 0n, true);
  view.setBigUint64(pointer + CoreTransportCapture_sourceRevision, value.sourceRevision ?? 0n, true);
}
export const CoreTransportCaptureFields = Object.freeze({ record: CoreTransportCapture_record, recordLength: CoreTransportCapture_recordLength, blocks: CoreTransportCapture_blocks, blockCount: CoreTransportCapture_blockCount, flags: CoreTransportCapture_flags, boxFlags: CoreTransportCapture_boxFlags, stableId: CoreTransportCapture_stableId, sourceRevision: CoreTransportCapture_sourceRevision });
export const DirectSceneValueSize = layoutConstant("DirectSceneValue_SIZE");
const DirectSceneValue_keyHash = layoutConstant("DirectSceneValue_keyHash");
const DirectSceneValue_kind = layoutConstant("DirectSceneValue_kind");
const DirectSceneValue_payload = layoutConstant("DirectSceneValue_payload");
const DirectSceneValue_count = layoutConstant("DirectSceneValue_count");
const DirectSceneValue_number = layoutConstant("DirectSceneValue_number");
const DirectSceneValue_key = layoutConstant("DirectSceneValue_key");
const DirectSceneValue_keyLength = layoutConstant("DirectSceneValue_keyLength");
export function readDirectSceneValue(view, pointer) { return {
  keyHash: view.getUint32(pointer + DirectSceneValue_keyHash, true),
  kind: view.getUint32(pointer + DirectSceneValue_kind, true),
  payload: view.getUint32(pointer + DirectSceneValue_payload, true),
  count: view.getUint32(pointer + DirectSceneValue_count, true),
  number: view.getFloat64(pointer + DirectSceneValue_number, true),
  key: view.getUint32(pointer + DirectSceneValue_key, true),
  keyLength: view.getUint32(pointer + DirectSceneValue_keyLength, true),
}; }
export function writeDirectSceneValue(view, pointer, value) {
  view.setUint32(pointer + DirectSceneValue_keyHash, value.keyHash ?? 0, true);
  view.setUint32(pointer + DirectSceneValue_kind, value.kind ?? 0, true);
  view.setUint32(pointer + DirectSceneValue_payload, value.payload ?? 0, true);
  view.setUint32(pointer + DirectSceneValue_count, value.count ?? 0, true);
  view.setFloat64(pointer + DirectSceneValue_number, value.number ?? 0, true);
  view.setUint32(pointer + DirectSceneValue_key, value.key ?? 0, true);
  view.setUint32(pointer + DirectSceneValue_keyLength, value.keyLength ?? 0, true);
}
export const DirectSceneValueFields = Object.freeze({ keyHash: DirectSceneValue_keyHash, kind: DirectSceneValue_kind, payload: DirectSceneValue_payload, count: DirectSceneValue_count, number: DirectSceneValue_number, key: DirectSceneValue_key, keyLength: DirectSceneValue_keyLength });
export const EngineFrameResolutionSize = layoutConstant("EngineFrameResolution_SIZE");
const EngineFrameResolution_flags = layoutConstant("EngineFrameResolution_flags");
const EngineFrameResolution_fontIndex = layoutConstant("EngineFrameResolution_fontIndex");
const EngineFrameResolution_imageIndex = layoutConstant("EngineFrameResolution_imageIndex");
const EngineFrameResolution_backgroundImages = layoutConstant("EngineFrameResolution_backgroundImages");
const EngineFrameResolution_backgroundImageCount = layoutConstant("EngineFrameResolution_backgroundImageCount");
const EngineFrameResolution_reserved = layoutConstant("EngineFrameResolution_reserved");
export function readEngineFrameResolution(view, pointer) { return {
  flags: view.getUint32(pointer + EngineFrameResolution_flags, true),
  fontIndex: view.getUint32(pointer + EngineFrameResolution_fontIndex, true),
  imageIndex: view.getUint32(pointer + EngineFrameResolution_imageIndex, true),
  backgroundImages: view.getUint32(pointer + EngineFrameResolution_backgroundImages, true),
  backgroundImageCount: view.getUint32(pointer + EngineFrameResolution_backgroundImageCount, true),
  reserved: view.getUint32(pointer + EngineFrameResolution_reserved, true),
}; }
export function writeEngineFrameResolution(view, pointer, value) {
  view.setUint32(pointer + EngineFrameResolution_flags, value.flags ?? 0, true);
  view.setUint32(pointer + EngineFrameResolution_fontIndex, value.fontIndex ?? 0, true);
  view.setUint32(pointer + EngineFrameResolution_imageIndex, value.imageIndex ?? 0, true);
  view.setUint32(pointer + EngineFrameResolution_backgroundImages, value.backgroundImages ?? 0, true);
  view.setUint32(pointer + EngineFrameResolution_backgroundImageCount, value.backgroundImageCount ?? 0, true);
  view.setUint32(pointer + EngineFrameResolution_reserved, value.reserved ?? 0, true);
}
export const EngineFrameResolutionFields = Object.freeze({ flags: EngineFrameResolution_flags, fontIndex: EngineFrameResolution_fontIndex, imageIndex: EngineFrameResolution_imageIndex, backgroundImages: EngineFrameResolution_backgroundImages, backgroundImageCount: EngineFrameResolution_backgroundImageCount, reserved: EngineFrameResolution_reserved });
export const EngineFrameFactSize = layoutConstant("EngineFrameFact_SIZE");
const EngineFrameFact_flags = layoutConstant("EngineFrameFact_flags");
const EngineFrameFact_poolDigest = layoutConstant("EngineFrameFact_poolDigest");
const EngineFrameFact_previousGeneration = layoutConstant("EngineFrameFact_previousGeneration");
const EngineFrameFact_appliedScrollbars = layoutConstant("EngineFrameFact_appliedScrollbars");
export function readEngineFrameFact(view, pointer) { return {
  flags: view.getUint32(pointer + EngineFrameFact_flags, true),
  poolDigest: view.getUint32(pointer + EngineFrameFact_poolDigest, true),
  previousGeneration: view.getUint32(pointer + EngineFrameFact_previousGeneration, true),
  appliedScrollbars: view.getUint32(pointer + EngineFrameFact_appliedScrollbars, true),
}; }
export function writeEngineFrameFact(view, pointer, value) {
  view.setUint32(pointer + EngineFrameFact_flags, value.flags ?? 0, true);
  view.setUint32(pointer + EngineFrameFact_poolDigest, value.poolDigest ?? 0, true);
  view.setUint32(pointer + EngineFrameFact_previousGeneration, value.previousGeneration ?? 0, true);
  view.setUint32(pointer + EngineFrameFact_appliedScrollbars, value.appliedScrollbars ?? 0, true);
}
export const EngineFrameFactFields = Object.freeze({ flags: EngineFrameFact_flags, poolDigest: EngineFrameFact_poolDigest, previousGeneration: EngineFrameFact_previousGeneration, appliedScrollbars: EngineFrameFact_appliedScrollbars });
export const EngineFrameFinishRowSize = layoutConstant("EngineFrameFinishRow_SIZE");
const EngineFrameFinishRow_index = layoutConstant("EngineFrameFinishRow_index");
const EngineFrameFinishRow_flags = layoutConstant("EngineFrameFinishRow_flags");
export function readEngineFrameFinishRow(view, pointer) { return {
  index: view.getUint32(pointer + EngineFrameFinishRow_index, true),
  flags: view.getUint32(pointer + EngineFrameFinishRow_flags, true),
}; }
export function writeEngineFrameFinishRow(view, pointer, value) {
  view.setUint32(pointer + EngineFrameFinishRow_index, value.index ?? 0, true);
  view.setUint32(pointer + EngineFrameFinishRow_flags, value.flags ?? 0, true);
}
export const EngineFrameFinishRowFields = Object.freeze({ index: EngineFrameFinishRow_index, flags: EngineFrameFinishRow_flags });
export const EngineFrameInputSize = layoutConstant("EngineFrameInput_SIZE");
const EngineFrameInput_count = layoutConstant("EngineFrameInput_count");
const EngineFrameInput_imageCount = layoutConstant("EngineFrameInput_imageCount");
const EngineFrameInput_gridCursor = layoutConstant("EngineFrameInput_gridCursor");
const EngineFrameInput_backgroundCursor = layoutConstant("EngineFrameInput_backgroundCursor");
const EngineFrameInput_stopCursor = layoutConstant("EngineFrameInput_stopCursor");
const EngineFrameInput_shadowCursor = layoutConstant("EngineFrameInput_shadowCursor");
const EngineFrameInput_geometryCursor = layoutConstant("EngineFrameInput_geometryCursor");
const EngineFrameInput_publication = layoutConstant("EngineFrameInput_publication");
const EngineFrameInput_flags = layoutConstant("EngineFrameInput_flags");
const EngineFrameInput_sceneGeneration = layoutConstant("EngineFrameInput_sceneGeneration");
const EngineFrameInput_filterCursor = layoutConstant("EngineFrameInput_filterCursor");
const EngineFrameInput_clipCursor = layoutConstant("EngineFrameInput_clipCursor");
const EngineFrameInput_maskCursor = layoutConstant("EngineFrameInput_maskCursor");
const EngineFrameInput_borderImageCursor = layoutConstant("EngineFrameInput_borderImageCursor");
export function readEngineFrameInput(view, pointer) { return {
  count: view.getUint32(pointer + EngineFrameInput_count, true),
  imageCount: view.getUint32(pointer + EngineFrameInput_imageCount, true),
  gridCursor: view.getUint32(pointer + EngineFrameInput_gridCursor, true),
  backgroundCursor: view.getUint32(pointer + EngineFrameInput_backgroundCursor, true),
  stopCursor: view.getUint32(pointer + EngineFrameInput_stopCursor, true),
  shadowCursor: view.getUint32(pointer + EngineFrameInput_shadowCursor, true),
  geometryCursor: view.getUint32(pointer + EngineFrameInput_geometryCursor, true),
  publication: view.getUint32(pointer + EngineFrameInput_publication, true),
  flags: view.getUint32(pointer + EngineFrameInput_flags, true),
  sceneGeneration: view.getUint32(pointer + EngineFrameInput_sceneGeneration, true),
  filterCursor: view.getUint32(pointer + EngineFrameInput_filterCursor, true),
  clipCursor: view.getUint32(pointer + EngineFrameInput_clipCursor, true),
  maskCursor: view.getUint32(pointer + EngineFrameInput_maskCursor, true),
  borderImageCursor: view.getUint32(pointer + EngineFrameInput_borderImageCursor, true),
}; }
export function writeEngineFrameInput(view, pointer, value) {
  view.setUint32(pointer + EngineFrameInput_count, value.count ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_imageCount, value.imageCount ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_gridCursor, value.gridCursor ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_backgroundCursor, value.backgroundCursor ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_stopCursor, value.stopCursor ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_shadowCursor, value.shadowCursor ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_geometryCursor, value.geometryCursor ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_publication, value.publication ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_flags, value.flags ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_sceneGeneration, value.sceneGeneration ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_filterCursor, value.filterCursor ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_clipCursor, value.clipCursor ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_maskCursor, value.maskCursor ?? 0, true);
  view.setUint32(pointer + EngineFrameInput_borderImageCursor, value.borderImageCursor ?? 0, true);
}
export const EngineFrameInputFields = Object.freeze({ count: EngineFrameInput_count, imageCount: EngineFrameInput_imageCount, gridCursor: EngineFrameInput_gridCursor, backgroundCursor: EngineFrameInput_backgroundCursor, stopCursor: EngineFrameInput_stopCursor, shadowCursor: EngineFrameInput_shadowCursor, geometryCursor: EngineFrameInput_geometryCursor, publication: EngineFrameInput_publication, flags: EngineFrameInput_flags, sceneGeneration: EngineFrameInput_sceneGeneration, filterCursor: EngineFrameInput_filterCursor, clipCursor: EngineFrameInput_clipCursor, maskCursor: EngineFrameInput_maskCursor, borderImageCursor: EngineFrameInput_borderImageCursor });
export const EngineFrameOutputSize = layoutConstant("EngineFrameOutput_SIZE");
const EngineFrameOutput_count = layoutConstant("EngineFrameOutput_count");
const EngineFrameOutput_records = layoutConstant("EngineFrameOutput_records");
const EngineFrameOutput_facts = layoutConstant("EngineFrameOutput_facts");
const EngineFrameOutput_reserved = layoutConstant("EngineFrameOutput_reserved");
const EngineFrameOutput_gridPool = layoutConstant("EngineFrameOutput_gridPool");
const EngineFrameOutput_gridPoolLength = layoutConstant("EngineFrameOutput_gridPoolLength");
const EngineFrameOutput_backgroundPool = layoutConstant("EngineFrameOutput_backgroundPool");
const EngineFrameOutput_backgroundPoolLength = layoutConstant("EngineFrameOutput_backgroundPoolLength");
const EngineFrameOutput_stopPool = layoutConstant("EngineFrameOutput_stopPool");
const EngineFrameOutput_stopPoolLength = layoutConstant("EngineFrameOutput_stopPoolLength");
const EngineFrameOutput_shadowPool = layoutConstant("EngineFrameOutput_shadowPool");
const EngineFrameOutput_shadowPoolLength = layoutConstant("EngineFrameOutput_shadowPoolLength");
const EngineFrameOutput_geometryPool = layoutConstant("EngineFrameOutput_geometryPool");
const EngineFrameOutput_geometryPoolLength = layoutConstant("EngineFrameOutput_geometryPoolLength");
const EngineFrameOutput_filterPool = layoutConstant("EngineFrameOutput_filterPool");
const EngineFrameOutput_filterPoolLength = layoutConstant("EngineFrameOutput_filterPoolLength");
const EngineFrameOutput_clipPool = layoutConstant("EngineFrameOutput_clipPool");
const EngineFrameOutput_clipPoolLength = layoutConstant("EngineFrameOutput_clipPoolLength");
const EngineFrameOutput_maskPool = layoutConstant("EngineFrameOutput_maskPool");
const EngineFrameOutput_maskPoolLength = layoutConstant("EngineFrameOutput_maskPoolLength");
const EngineFrameOutput_borderImagePool = layoutConstant("EngineFrameOutput_borderImagePool");
const EngineFrameOutput_borderImagePoolLength = layoutConstant("EngineFrameOutput_borderImagePoolLength");
export function readEngineFrameOutput(view, pointer) { return {
  count: view.getUint32(pointer + EngineFrameOutput_count, true),
  records: view.getUint32(pointer + EngineFrameOutput_records, true),
  facts: view.getUint32(pointer + EngineFrameOutput_facts, true),
  reserved: view.getUint32(pointer + EngineFrameOutput_reserved, true),
  gridPool: view.getUint32(pointer + EngineFrameOutput_gridPool, true),
  gridPoolLength: view.getUint32(pointer + EngineFrameOutput_gridPoolLength, true),
  backgroundPool: view.getUint32(pointer + EngineFrameOutput_backgroundPool, true),
  backgroundPoolLength: view.getUint32(pointer + EngineFrameOutput_backgroundPoolLength, true),
  stopPool: view.getUint32(pointer + EngineFrameOutput_stopPool, true),
  stopPoolLength: view.getUint32(pointer + EngineFrameOutput_stopPoolLength, true),
  shadowPool: view.getUint32(pointer + EngineFrameOutput_shadowPool, true),
  shadowPoolLength: view.getUint32(pointer + EngineFrameOutput_shadowPoolLength, true),
  geometryPool: view.getUint32(pointer + EngineFrameOutput_geometryPool, true),
  geometryPoolLength: view.getUint32(pointer + EngineFrameOutput_geometryPoolLength, true),
  filterPool: view.getUint32(pointer + EngineFrameOutput_filterPool, true),
  filterPoolLength: view.getUint32(pointer + EngineFrameOutput_filterPoolLength, true),
  clipPool: view.getUint32(pointer + EngineFrameOutput_clipPool, true),
  clipPoolLength: view.getUint32(pointer + EngineFrameOutput_clipPoolLength, true),
  maskPool: view.getUint32(pointer + EngineFrameOutput_maskPool, true),
  maskPoolLength: view.getUint32(pointer + EngineFrameOutput_maskPoolLength, true),
  borderImagePool: view.getUint32(pointer + EngineFrameOutput_borderImagePool, true),
  borderImagePoolLength: view.getUint32(pointer + EngineFrameOutput_borderImagePoolLength, true),
}; }
export function writeEngineFrameOutput(view, pointer, value) {
  view.setUint32(pointer + EngineFrameOutput_count, value.count ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_records, value.records ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_facts, value.facts ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_reserved, value.reserved ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_gridPool, value.gridPool ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_gridPoolLength, value.gridPoolLength ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_backgroundPool, value.backgroundPool ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_backgroundPoolLength, value.backgroundPoolLength ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_stopPool, value.stopPool ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_stopPoolLength, value.stopPoolLength ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_shadowPool, value.shadowPool ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_shadowPoolLength, value.shadowPoolLength ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_geometryPool, value.geometryPool ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_geometryPoolLength, value.geometryPoolLength ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_filterPool, value.filterPool ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_filterPoolLength, value.filterPoolLength ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_clipPool, value.clipPool ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_clipPoolLength, value.clipPoolLength ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_maskPool, value.maskPool ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_maskPoolLength, value.maskPoolLength ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_borderImagePool, value.borderImagePool ?? 0, true);
  view.setUint32(pointer + EngineFrameOutput_borderImagePoolLength, value.borderImagePoolLength ?? 0, true);
}
export const EngineFrameOutputFields = Object.freeze({ count: EngineFrameOutput_count, records: EngineFrameOutput_records, facts: EngineFrameOutput_facts, reserved: EngineFrameOutput_reserved, gridPool: EngineFrameOutput_gridPool, gridPoolLength: EngineFrameOutput_gridPoolLength, backgroundPool: EngineFrameOutput_backgroundPool, backgroundPoolLength: EngineFrameOutput_backgroundPoolLength, stopPool: EngineFrameOutput_stopPool, stopPoolLength: EngineFrameOutput_stopPoolLength, shadowPool: EngineFrameOutput_shadowPool, shadowPoolLength: EngineFrameOutput_shadowPoolLength, geometryPool: EngineFrameOutput_geometryPool, geometryPoolLength: EngineFrameOutput_geometryPoolLength, filterPool: EngineFrameOutput_filterPool, filterPoolLength: EngineFrameOutput_filterPoolLength, clipPool: EngineFrameOutput_clipPool, clipPoolLength: EngineFrameOutput_clipPoolLength, maskPool: EngineFrameOutput_maskPool, maskPoolLength: EngineFrameOutput_maskPoolLength, borderImagePool: EngineFrameOutput_borderImagePool, borderImagePoolLength: EngineFrameOutput_borderImagePoolLength });
export const DomBatchHeaderSize = layoutConstant("DomBatchHeader_SIZE");
const DomBatchHeader_magic = layoutConstant("DomBatchHeader_magic");
const DomBatchHeader_version = layoutConstant("DomBatchHeader_version");
const DomBatchHeader_headerBytes = layoutConstant("DomBatchHeader_headerBytes");
const DomBatchHeader_flags = layoutConstant("DomBatchHeader_flags");
const DomBatchHeader_handleCount = layoutConstant("DomBatchHeader_handleCount");
const DomBatchHeader_localCount = layoutConstant("DomBatchHeader_localCount");
const DomBatchHeader_operationCount = layoutConstant("DomBatchHeader_operationCount");
const DomBatchHeader_operationBytes = layoutConstant("DomBatchHeader_operationBytes");
const DomBatchHeader_stringBytes = layoutConstant("DomBatchHeader_stringBytes");
const DomBatchHeader_fontCatalog = layoutConstant("DomBatchHeader_fontCatalog");
export function readDomBatchHeader(view, pointer) { return {
  magic: view.getUint32(pointer + DomBatchHeader_magic, true),
  version: view.getUint16(pointer + DomBatchHeader_version, true),
  headerBytes: view.getUint16(pointer + DomBatchHeader_headerBytes, true),
  flags: view.getUint32(pointer + DomBatchHeader_flags, true),
  handleCount: view.getUint32(pointer + DomBatchHeader_handleCount, true),
  localCount: view.getUint32(pointer + DomBatchHeader_localCount, true),
  operationCount: view.getUint32(pointer + DomBatchHeader_operationCount, true),
  operationBytes: view.getUint32(pointer + DomBatchHeader_operationBytes, true),
  stringBytes: view.getUint32(pointer + DomBatchHeader_stringBytes, true),
  fontCatalog: view.getBigUint64(pointer + DomBatchHeader_fontCatalog, true),
}; }
export function writeDomBatchHeader(view, pointer, value) {
  view.setUint32(pointer + DomBatchHeader_magic, value.magic ?? 0, true);
  view.setUint16(pointer + DomBatchHeader_version, value.version ?? 0, true);
  view.setUint16(pointer + DomBatchHeader_headerBytes, value.headerBytes ?? 0, true);
  view.setUint32(pointer + DomBatchHeader_flags, value.flags ?? 0, true);
  view.setUint32(pointer + DomBatchHeader_handleCount, value.handleCount ?? 0, true);
  view.setUint32(pointer + DomBatchHeader_localCount, value.localCount ?? 0, true);
  view.setUint32(pointer + DomBatchHeader_operationCount, value.operationCount ?? 0, true);
  view.setUint32(pointer + DomBatchHeader_operationBytes, value.operationBytes ?? 0, true);
  view.setUint32(pointer + DomBatchHeader_stringBytes, value.stringBytes ?? 0, true);
  view.setBigUint64(pointer + DomBatchHeader_fontCatalog, value.fontCatalog ?? 0n, true);
}
export const DomBatchHeaderFields = Object.freeze({ magic: DomBatchHeader_magic, version: DomBatchHeader_version, headerBytes: DomBatchHeader_headerBytes, flags: DomBatchHeader_flags, handleCount: DomBatchHeader_handleCount, localCount: DomBatchHeader_localCount, operationCount: DomBatchHeader_operationCount, operationBytes: DomBatchHeader_operationBytes, stringBytes: DomBatchHeader_stringBytes, fontCatalog: DomBatchHeader_fontCatalog });
export const coreTransportPoolKinds = Object.freeze({ GRID: layoutConstant("CORE_POOL_KIND_GRID"), BACKGROUND: layoutConstant("CORE_POOL_KIND_BACKGROUND"), GRADIENT_STOPS: layoutConstant("CORE_POOL_KIND_GRADIENT_STOPS"), SHADOW: layoutConstant("CORE_POOL_KIND_SHADOW"), SVG_GEOMETRY: layoutConstant("CORE_POOL_KIND_SVG_GEOMETRY"), FILTER: layoutConstant("CORE_POOL_KIND_FILTER"), CLIP_PATH: layoutConstant("CORE_POOL_KIND_CLIP_PATH"), MASK: layoutConstant("CORE_POOL_KIND_MASK"), BORDER_IMAGE: layoutConstant("CORE_POOL_KIND_BORDER_IMAGE") });
export const domBatchLayout = Object.freeze({"magic":1128416339,"version":2,"headerBytes":40,"flags":{"identifiedNodes":1},"limits":{"bytes":16777216,"operations":262144,"handles":65536,"locals":65536},"operandKinds":{"local":1,"node":2,"optional-node":3,"string":4,"returned-local":5,"index-path":6,"word":7},"opcodes":{"CREATE_ELEMENT":{"code":1,"bytes":24,"operands":["local","string","string"],"names":["result","namespace","qualifiedName"]},"CREATE_TEXT":{"code":2,"bytes":16,"operands":["local","string"],"names":["result","data"]},"CREATE_COMMENT":{"code":3,"bytes":16,"operands":["local","string"],"names":["result","data"]},"CREATE_FRAGMENT":{"code":4,"bytes":8,"operands":["local"],"names":["result"]},"INSERT_BEFORE":{"code":16,"bytes":16,"operands":["node","node","optional-node"],"names":["parent","node","reference"]},"REMOVE_CHILD":{"code":17,"bytes":12,"operands":["node","node"],"names":["parent","node"]},"REPLACE_CHILD":{"code":18,"bytes":16,"operands":["node","node","node"],"names":["parent","replacement","replaced"]},"SET_ATTRIBUTE":{"code":32,"bytes":32,"operands":["node","string","string","string"],"names":["element","namespace","qualifiedName","value"]},"REMOVE_ATTRIBUTE":{"code":33,"bytes":16,"operands":["node","string"],"names":["element","qualifiedName"]},"REMOVE_ATTRIBUTE_NS":{"code":34,"bytes":24,"operands":["node","string","string"],"names":["element","namespace","localName"]},"SET_DATA":{"code":48,"bytes":16,"operands":["node","string"],"names":["node","data"]},"SET_STYLE_PROPERTY":{"code":64,"bytes":32,"operands":["node","string","string","string"],"names":["element","property","value","priority"]},"REMOVE_STYLE_PROPERTY":{"code":65,"bytes":16,"operands":["node","string"],"names":["element","property"]},"SET_STYLE_TEXT":{"code":66,"bytes":16,"operands":["node","string"],"names":["element","text"]},"INSERT_MARKUP":{"code":19,"bytes":20,"operands":["node","optional-node","string"],"names":["parent","reference","markup"]},"SET_CONTROL_VALUE":{"code":80,"bytes":16,"operands":["node","string"],"names":["element","value"]},"SET_RULE_PROPERTY":{"code":96,"bytes":40,"operands":["node","index-path","string","string","string"],"names":["owner","rule","property","value","priority"]},"INSERT_RULE":{"code":97,"bytes":24,"operands":["node","index-path","string"],"names":["owner","rule","text"]},"DELETE_RULE":{"code":98,"bytes":16,"operands":["node","index-path"],"names":["owner","rule"]},"CREATE_ELEMENT_LOCAL":{"code":5,"bytes":24,"operands":["local","string","string"],"names":["result","namespace","localName"]},"CREATE_ELEMENT_PUBLIC":{"code":6,"bytes":36,"operands":["local","string","string","string","word"],"names":["result","namespace","name","contentType","namespaceAware"]},"SET_ATTRIBUTE_NS":{"code":35,"bytes":32,"operands":["node","string","string","string"],"names":["element","namespace","qualifiedName","value"]},"SET_TEXT_CONTENT":{"code":49,"bytes":16,"operands":["node","string"],"names":["node","text"]},"SET_STYLE_DECLARATION":{"code":67,"bytes":36,"operands":["node","string","string","string","word"],"names":["element","property","value","priority","mode"]},"ATTACH_SHADOW":{"code":7,"bytes":16,"operands":["local","node","word"],"names":["result","host","flags"]},"SET_CONTROL_CHECKED":{"code":81,"bytes":12,"operands":["node","word"],"names":["element","checked"]},"SET_OPTION_SELECTED":{"code":82,"bytes":12,"operands":["node","word"],"names":["option","selected"]},"SET_SELECT_VALUE":{"code":83,"bytes":16,"operands":["node","string"],"names":["select","value"]},"RETURN":{"code":112,"bytes":8,"operands":["returned-local"],"names":["node"]}}});
