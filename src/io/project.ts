import { link, mkdir, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { assertNoErrors, contractError } from '../domain/errors.js';
import { ProjectSchema } from '../domain/schema.js';
import type { Project } from '../domain/schema.js';
import { validateProject } from '../domain/validation.js';
import { importPackage, recoverSourceProject } from '../importers/import-package.js';
import { isSafePackagePath, parseJson } from '../importers/integrity.js';
import { readUtf8 } from './package.js';

type JsonObject = { [key: string]: unknown };

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
  if (decision.canonicalUnitId === null) return { ...decision, relation: 'standalone-placement', renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null };
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

/** 1.0·1.1·1.2 저장본을 기준 Gate와 불확실한 Source Anchor가 분리된 1.3 형식으로 올린다. */
export function migrateProjectInput(input: unknown): unknown {
  if (!isJsonObject(input)) return input;
  return migrate12To13(migrate11To12(migrate10To11(input)));
}

/** 저장된 원본 스냅샷에서 데이터를 다시 계산해 편집 가능한 값과 원문을 구분한다. */
export function parseProject(input: unknown): Project {
  const project: Project = ProjectSchema.parse(migrateProjectInput(input));
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
