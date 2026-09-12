import { migrateGeneratorBuildInput } from '../domain/build-provenance.js';
import { storyboardTextPreset } from '../domain/text-layout-settings.js';
import { textLayoutControl } from '../domain/text-layout-control.js';
import { storyboardReadingPreset } from '../domain/text-readability.js';
import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { assertNoErrors, contractError } from '../domain/errors.js';
import { intrinsicIncomingExposure } from '../domain/transition.js';
import { ProjectSchema, TransitionSchema } from '../domain/schema.js';
import type { Project } from '../domain/schema.js';
import { validateProject } from '../domain/validation.js';
import { importPackage, recoverSourceProject } from '../importers/import-package.js';
import { isSafePackagePath, parseJson, sha256Text } from '../importers/integrity.js';
import { readUtf8 } from './package.js';
import { stableJsonStringify } from './stable-json.js';

type JsonObject = { [key: string]: unknown };

export const ReviewProjectEnvelopeSchema = z.strictObject({
  artifactType: z.literal('storyboard-review-project'), artifactVersion: z.literal('1.0.0'),
  maturity: z.enum(['draft', 'final']), label: z.string().optional(), profile: z.literal('internal').optional(), project: z.unknown(),
});

function isJsonObject(input: unknown): input is JsonObject {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function migrate10To11(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.0.0' || !Array.isArray(input.shots)) return input;
  return { ...input, schemaVersion: '1.1.0', shots: input.shots.map((shot: unknown): unknown => {
    if (!isJsonObject(shot) || 'transitionOut' in shot) return shot;
    return { ...shot, transitionOut: { kind: 'cut', durationMs: 0, note: '' } };
  }) };
}

function migratedInformationRules(dataset: JsonObject): unknown[] {
  if (!Array.isArray(dataset.informationRules) || !Array.isArray(dataset.segments) || !Array.isArray(dataset.units)) return [];
  const segments: JsonObject[] = dataset.segments.filter(isJsonObject);
  const units: JsonObject[] = dataset.units.filter(isJsonObject);
  return dataset.informationRules.map((value: unknown): unknown => {
    if (!isJsonObject(value) || typeof value.id !== 'string' || typeof value.notBeforeMs !== 'number') return value;
    if ('segmentId' in value && 'precision' in value) return value;
    const unit: JsonObject | undefined = units.find((candidate: JsonObject): boolean => Array.isArray(candidate.informationIds) && candidate.informationIds.includes(value.id));
    const segment: JsonObject | undefined = segments.find((candidate: JsonObject): boolean => typeof candidate.startMs === 'number' && typeof candidate.endMs === 'number' && value.notBeforeMs as number >= candidate.startMs && value.notBeforeMs as number < candidate.endMs)
      ?? segments.find((candidate: JsonObject): boolean => candidate.id === unit?.segmentId);
    if (segment === undefined || typeof segment.id !== 'string') return value;
    return {
      ...value, segmentId: segment.id, notBeforeUnitId: typeof unit?.id === 'string' ? unit.id : null,
      notBeforeUnitOrder: typeof unit?.order === 'number' ? unit.order : null,
      precision: value.notBeforeMs === segment.startMs ? (unit === undefined ? 'segment-start' : 'unit-order') : 'exact-time',
    };
  });
}

function migrate11To12(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.1.0' || !Array.isArray(input.shots) || !isJsonObject(input.dataset)) return input;
  const dataset: JsonObject = { ...input.dataset, informationRules: migratedInformationRules(input.dataset) };
  const shots: unknown[] = input.shots.map((shot: unknown): unknown => {
    if (!isJsonObject(shot) || !Array.isArray(shot.sourceUnitIds)) return shot;
    const { sourceUnitIds, ...rest } = shot;
    return { ...rest, sourceLinks: sourceUnitIds.map((unitId: unknown): unknown => ({ unitId, usage: 'context-only', status: 'mapping-required' })) };
  });
  return { ...input, schemaVersion: '1.2.0', dataset, textMappingDecisions: [], shots };
}

function sourceProjectFromStoredInput(input: JsonObject): Project {
  if (!isJsonObject(input.handoff) || !Array.isArray(input.sources)) throw contractError('MIGRATION_SOURCE_REQUIRED', '1.2 저장본을 변환하려면 handoff와 원본 sources가 필요합니다.', []);
  const files: unknown[] = input.sources.map((source: unknown): unknown => {
    if (!isJsonObject(source)) return source;
    return { path: source.path, content: source.content };
  });
  return importPackage({ handoff: input.handoff, files });
}

function migratedTextMapping(decision: unknown): unknown {
  if (!isJsonObject(decision)) return decision;
  if (decision.canonicalUnitId === null) return { ...decision, relation: 'standalone-placement', status: 'unresolved', renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null };
  if (decision.relation === 'exact') return { ...decision, renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null };
  const hasRange: boolean = typeof decision.canonicalStartMs === 'number' && typeof decision.canonicalEndMs === 'number' && decision.canonicalEndMs > decision.canonicalStartMs;
  if (decision.relation === 'separate-element' && !hasRange) return { ...decision, relation: 'abbreviation', status: 'unresolved', renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null };
  if (decision.renderCanonicalSeparately !== true) return { ...decision, renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null };
  return decision;
}

function migrate12To13(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.2.0' || !Array.isArray(input.shots) || !isJsonObject(input.dataset)) return input;
  const source: Project = sourceProjectFromStoredInput(input);
  const existingMappings: unknown[] = Array.isArray(input.textMappingDecisions) && input.textMappingDecisions.length > 0
    ? input.textMappingDecisions.map(migratedTextMapping) : source.textMappingDecisions;
  const shots: unknown[] = input.shots.map((shot: unknown): unknown => {
    if (!isJsonObject(shot) || !Array.isArray(shot.sourceLinks)) return shot;
    return { ...shot, approvalStatus: 'proposed', sourceLinks: shot.sourceLinks.map((link: unknown): unknown => isJsonObject(link)
      ? { ...link, status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'migration', status: 'review-required' } } : link) };
  });
  return {
    ...input, schemaVersion: '1.3.0',
    dataset: { ...input.dataset, informationRules: source.dataset.informationRules },
    textMappingDecisions: existingMappings, shots,
  };
}

function matchingCanonicalDecision(input: JsonObject, cue: JsonObject): JsonObject | null {
  if (!Array.isArray(input.textMappingDecisions) || typeof cue.unitId !== 'string') return null;
  const matches: JsonObject[] = input.textMappingDecisions.filter(isJsonObject).filter((decision: JsonObject): boolean =>
    decision.canonicalUnitId === cue.unitId && decision.status === 'confirmed' && decision.renderCanonicalSeparately === true
    && decision.canonicalStartMs === cue.startMs && decision.canonicalEndMs === cue.endMs);
  return matches.length === 1 ? matches[0] ?? null : null;
}

function migratedTextCue14(input: JsonObject, cue: unknown): unknown {
  if (!isJsonObject(cue)) return cue;
  if (typeof cue.placementId === 'string') return { ...cue, authority: 'placement', mappingDecisionId: null };
  const canonical: JsonObject | null = matchingCanonicalDecision(input, cue);
  if (canonical !== null && typeof canonical.id === 'string') return { ...cue, authority: 'mapping-decision', mappingDecisionId: canonical.id };
  if (typeof cue.unitId === 'string' && isJsonObject(input.dataset) && Array.isArray(input.dataset.units)) {
    const unit: JsonObject | undefined = input.dataset.units.filter(isJsonObject).find((candidate: JsonObject): boolean =>
      candidate.id === cue.unitId && candidate.segmentId === cue.segmentId && candidate.text === cue.text);
    if (unit !== undefined) return { ...cue, authority: 'source-unit', mappingDecisionId: null };
  }
  return { ...cue, authority: 'review-required', mappingDecisionId: null };
}

function migratedFrame14(frame: unknown): unknown {
  if (!isJsonObject(frame)) return frame;
  const { evaluationAbsoluteMs: _evaluationAbsoluteMs, displayAbsoluteMs: _displayAbsoluteMs, ...stored } = frame;
  return stored;
}

function migrate13To14(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.3.0' || !Array.isArray(input.audioCues) || !Array.isArray(input.textCues)) return input;
  return {
    ...input,
    schemaVersion: '1.4.0',
    audioCues: input.audioCues.map((cue: unknown): unknown => isJsonObject(cue) ? { ...cue, timingRelation: 'within-segment' } : cue),
    textCues: input.textCues.map((cue: unknown): unknown => migratedTextCue14(input, cue)),
    frames: Array.isArray(input.frames) ? input.frames.map(migratedFrame14) : input.frames,
  };
}

function migratedPlacementInformationDecisions(input: JsonObject): JsonObject[] {
  if (!Array.isArray(input.textMappingDecisions)) return [];
  return input.textMappingDecisions.filter(isJsonObject).flatMap((decision: JsonObject): JsonObject[] => {
    if (typeof decision.placementId !== 'string' || !['separate-element', 'standalone-placement'].includes(String(decision.relation))) return [];
    return [{ id: `placement-info:${decision.placementId}`, placementId: decision.placementId, status: 'unresolved', informationIds: [], note: null }];
  });
}

function migrate14To15(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.4.0') return input;
  return { ...input, schemaVersion: '1.5.0', textPlacementInformationDecisions: migratedPlacementInformationDecisions(input) };
}

function migrate15To16(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.5.0' || !Array.isArray(input.shots)) return input;
  return {
    ...input,
    schemaVersion: '1.6.0',
    shots: input.shots.map((shot: unknown): unknown => isJsonObject(shot) && !('visualMode' in shot)
      ? { ...shot, visualMode: 'sourced' } : shot),
  };
}

function migrate16To17(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.6.0' || !Array.isArray(input.generationRecords)) return input;
  return { ...input, schemaVersion: '1.7.0', generationRecords: input.generationRecords.map((record: unknown): unknown =>
    isJsonObject(record) ? { ...record, generatorBuild: null } : record) };
}

function migrateTransitionInput(input: unknown): unknown {
  if (!isJsonObject(input)) return input;
  const transition = TransitionSchema.safeParse(input.transitionOut);
  return transition.success ? { ...input, transitionOut: { ...transition.data,
    incomingExposure: transition.data.incomingExposure ?? intrinsicIncomingExposure(transition.data.kind) } } : input;
}

function migrate17To18(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.7.0' || !Array.isArray(input.generationRecords)) return input;
  return { ...input, schemaVersion: '1.8.0', shots: Array.isArray(input.shots) ? input.shots.map(migrateTransitionInput) : input.shots, generationRecords: input.generationRecords.map((record: unknown): unknown =>
    isJsonObject(record) ? { ...record, generatorBuild: migrateGeneratorBuildInput(record.generatorBuild) } : record) };
}

/** 1.8에 기록된 Dirty 값과 모든 제작 데이터는 유지하고 Git 확인 가능 여부만 미상으로 남긴다. */
function migrate18To19(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.8.0' || !Array.isArray(input.generationRecords)) return input;
  return { ...input, schemaVersion: '1.9.0', generationRecords: input.generationRecords.map((record: unknown): unknown =>
    isJsonObject(record) ? { ...record, generatorBuild: migrateGeneratorBuildInput(record.generatorBuild) } : record) };
}

function migrate19To110(input: JsonObject): JsonObject {
  return input.schemaVersion === '1.9.0' ? { ...input, schemaVersion: '1.10.0' } : input;
}

function migrate110To111(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.10.0') return input;
  if ('productionPlan' in input && input.productionPlan !== null) throw contractError('UNSUPPORTED_LEGACY_PRODUCTION_PLAN', '1.10 저장 형식에는 제작 계획이 없습니다. 알 수 없는 productionPlan을 지우거나 추측해 이관하지 않습니다.', []);
  return { ...input, schemaVersion: '1.11.0', productionPlan: null };
}

function migrate111To112(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.11.0') return input;
  if (Array.isArray(input.audioCues) && input.audioCues.some((cue: unknown): boolean => isJsonObject(cue) && cue.timingStatus === 'prepared')) {
    throw contractError('UNSUPPORTED_LEGACY_AUDIO_PREPARATION', '1.11 이전 저장본에는 음향 배치 대기 상태가 없습니다. 파일의 지원 버전을 확인하세요.', []);
  }
  return { ...input, schemaVersion: '1.12.0' };
}

function migrate112To113(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.12.0') return input;
  if ('textLayout' in input) throw contractError('UNSUPPORTED_LEGACY_TEXT_LAYOUT', '1.12 이전 저장본에는 글자 조판 설정이 없습니다. 파일의 버전과 textLayout을 확인하세요.', []);
  return { ...input, schemaVersion: '1.13.0', textLayout: storyboardTextPreset() };
}

function migrate113To114(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.13.0') return input;
  if ('textReadability' in input) throw contractError('UNSUPPORTED_LEGACY_TEXT_READABILITY', '1.13 이전 저장본에는 읽기 기준 설정이 없습니다. 파일 버전과 textReadability를 확인하세요.', []);
  return { ...input, schemaVersion: '1.14.0', textReadability: storyboardReadingPreset() };
}

function migrate115To116(input: JsonObject): JsonObject {
  if (input['schemaVersion'] !== '1.15.0') return input;
  if (Array.isArray(input['audioCues']) && input['audioCues'].some((cue): boolean => typeof cue === 'object' && cue !== null && 'mix' in cue)) {
    throw contractError('UNSUPPORTED_LEGACY_AUDIO_MIX', '1.15 이전 저장본에는 음량·페이드 설정이 없습니다. 버전과 Audio Cue mix를 확인하세요.', []);
  }
  return { ...input, schemaVersion: '1.16.0' };
}

function migrate116To117(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.16.0') return input;
  if ('voiceCasting' in input) throw contractError('UNSUPPORTED_LEGACY_VOICE_CASTING', '1.16 이전 저장본에는 자동 음성 배정이 없습니다. 파일 버전과 voiceCasting을 확인하세요.', []);
  return { ...input, schemaVersion: '1.17.0' };
}

function migrate117To118(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.17.0') return input;
  if ('textTypography' in input) throw contractError('UNSUPPORTED_LEGACY_TEXT_TYPOGRAPHY', '1.17 이전 저장본에는 프로젝트 글꼴·언어 설정이 없습니다. 버전과 textTypography를 확인하세요.', []);
  return { ...input, schemaVersion: '1.18.0' };
}

function migrate118To119(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.18.0') return input;
  if (Array.isArray(input.textCues) && input.textCues.some((cue): boolean => isJsonObject(cue) && 'presentation' in cue)) {
    throw contractError('UNSUPPORTED_LEGACY_TEXT_PRESENTATION', '1.18 이전 저장본에는 개별 글자 배치가 없습니다. 버전과 presentation을 확인하세요.', []);
  }
  return { ...input, schemaVersion: '1.19.0' };
}

function migrate114To115(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.14.0') return input;
  if ('textLayoutControl' in input) throw contractError('UNSUPPORTED_LEGACY_TEXT_LAYOUT_CONTROL', '1.14 이전 저장본에는 자동 글자 배치 권한이 없습니다. 버전과 textLayoutControl을 확인하세요.', []);
  return { ...input, schemaVersion: '1.15.0', textLayoutControl: textLayoutControl('manual') };
}

function migrate119To120(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.19.0') return input;
  if ('audioInstructionDecisions' in input || Array.isArray(input.audioCues) && input.audioCues.some((cue): boolean => isJsonObject(cue) && ('instructionId' in cue || cue.unitId === null))) {
    throw contractError('UNSUPPORTED_LEGACY_AUDIO_INSTRUCTIONS', '1.19 이전 저장본에는 음향 지시 연결이 없습니다. 버전과 instructionId를 확인하세요.', []);
  }
  return { ...input, schemaVersion: '1.20.0' };
}

function migrate120To121(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.20.0') return input;
  if (Array.isArray(input.audioInstructionDecisions) && input.audioInstructionDecisions.some((decision): boolean => isJsonObject(decision) && 'sourceEvidence' in decision)) {
    throw contractError('UNSUPPORTED_LEGACY_AUDIO_EVIDENCE', '1.20 이전 저장본에는 음향의 대본 인용 연결이 없습니다. 버전과 sourceEvidence를 확인하세요.', []);
  }
  return { ...input, schemaVersion: '1.21.0' };
}

function migrate121To122(input: JsonObject): JsonObject {
  if (input.schemaVersion !== '1.21.0') return input;
  if (Array.isArray(input.audioInstructionDecisions) && input.audioInstructionDecisions.some((decision): boolean => isJsonObject(decision) && 'sharedScope' in decision)) {
    throw contractError('UNSUPPORTED_LEGACY_SHARED_AUDIO_SCOPE', '1.21 이전 저장본에는 공통 음향의 적용 구간 판정이 없습니다. 버전과 sharedScope를 확인하세요.', []);
  }
  return { ...input, schemaVersion: '1.22.0' };
}

/** 실제 저장 형식에서 정의된 순방향 변환만 수행한다. 과거 버전을 역으로 추측하지 않는다. */
function projectMigrationInputs(input: unknown): readonly unknown[] {
  if (!isJsonObject(input)) return [input];
  const migrations: readonly ((value: JsonObject) => JsonObject)[] = [migrate10To11, migrate11To12, migrate12To13,
    migrate13To14, migrate14To15, migrate15To16, migrate16To17, migrate17To18, migrate18To19, migrate19To110, migrate110To111, migrate111To112, migrate112To113, migrate113To114, migrate114To115, migrate115To116, migrate116To117, migrate117To118, migrate118To119, migrate119To120, migrate120To121, migrate121To122];
  return migrations.reduce<readonly JsonObject[]>((states, migrate): readonly JsonObject[] => {
    const previous: JsonObject = states[states.length - 1]!;
    const next: JsonObject = migrate(previous);
    return next === previous ? states : [...states, next];
  }, [input]);
}

/** 기존 저장본은 원문·Anchor·Asset을 보존하고 알 수 없는 생성 Build만 null로 이관한다. */
export function migrateProjectInput(input: unknown): unknown {
  const states: readonly unknown[] = projectMigrationInputs(input);
  return states[states.length - 1];
}

export type ProjectSnapshotEvidence = { project: Project; projectionHashes: readonly string[] };

/** 동일한 저장 JSON과 지원하는 순방향 이관의 해시를 결속한다. 파일은 재작성하지 않는다. */
export function parseProjectSnapshotEvidence(input: unknown): ProjectSnapshotEvidence {
  const states: readonly unknown[] = projectMigrationInputs(input);
  const project: Project = parseProject(states[states.length - 1]);
  return { project, projectionHashes: [...new Set([...states, project].map((value): string => sha256Text(stableJsonStringify(value))))] };
}

/** 저장된 원본 스냅샷에서 데이터를 다시 계산해 편집 가능한 값과 원문을 구분한다. */
export function parseProject(input: unknown): Project {
  const payload: unknown = isJsonObject(input) && input.artifactType === 'storyboard-review-project'
    ? ReviewProjectEnvelopeSchema.parse(input).project : input;
  const project: Project = ProjectSchema.parse(migrateProjectInput(payload));
  const source: Project = recoverSourceProject(project);
  if (JSON.stringify(project.sources) !== JSON.stringify(source.sources)) throw contractError('SOURCE_SNAPSHOT_MODIFIED', '입력 계약과 저장된 원본 스냅샷의 메타데이터가 다릅니다.', []);
  if (JSON.stringify(project.importIssues) !== JSON.stringify(source.importIssues)) throw contractError('IMPORT_ISSUES_MODIFIED', '원본 검토 항목을 덮어쓸 수 없습니다. 별도의 검토 결정으로 처리하세요.', []);
  for (const asset of project.assets) if (!isSafePackagePath(asset.path)) throw contractError('UNSAFE_ASSET_PATH', `${asset.id}: 프로젝트 내부 상대경로가 필요합니다: ${asset.path}`, []);
  assertNoErrors(validateProject(project, source.dataset), 'INVALID_PROJECT');
  return project;
}

export async function readProject(path: string): Promise<Project> {
  return parseProject(parseJson(await readUtf8(path), path));
}

/** 결과를 원자적으로 새 파일에 게시한다. 기존 파일은 덮어쓰지 않는다. */
export async function writeNewText(path: string, content: string): Promise<void> {
  const target: string = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary: string = `${target}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
  try {
    await link(temporary, target);
  } finally {
    await unlink(temporary);
  }
}
