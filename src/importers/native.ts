import { contractError } from '../domain/errors.js';
import { NativeDatasetSchema } from '../domain/schema.js';
import type { Dataset, Handoff, InformationRule, NativeDataset, Segment, Snapshot, SourceRef, SourceUnit } from '../domain/schema.js';
import { assertAuthorityRole, parseJson, requireSnapshot } from './integrity.js';

export function sourceRef(fileId: string, locator: string, originalId: string | null): SourceRef {
  return { fileId, locator, originalId };
}

export function importNative(handoff: Handoff, snapshots: readonly Snapshot[]): Dataset {
  const file: Snapshot = requireSnapshot(snapshots, 'native-data');
  for (const field of ['timeline', 'units', 'people', 'scenes', 'screen-text'] as const) assertAuthorityRole(handoff, snapshots, field, ['native-data']);
  const data: NativeDataset = NativeDatasetSchema.parse(parseJson(file.content, file.path));
  if (data.units.some((unit): boolean => unit.kind === 'PANEL') || handoff.authority.some((entry): boolean => entry.field === 'panel-turns')) {
    assertAuthorityRole(handoff, snapshots, 'panel-turns', ['native-data']);
  }
  const segments: Segment[] = data.segments.map((segment, index) => ({ ...segment, sourceRefs: [sourceRef(file.id, `/segments/${index}`, segment.id)] }));
  const units: SourceUnit[] = data.units.map((unit, index) => ({ ...unit, sourceRefs: [sourceRef(file.id, `/units/${index}`, unit.id)] }));
  const informationRules: InformationRule[] = data.informationRules.map((rule, index): InformationRule => {
    const unit: SourceUnit | undefined = rule.notBeforeUnitId === undefined || rule.notBeforeUnitId === null ? units.find((value: SourceUnit): boolean => value.informationIds.includes(rule.id)) : units.find((value: SourceUnit): boolean => value.id === rule.notBeforeUnitId);
    const segment: Segment | undefined = rule.segmentId === undefined ? segments.find((value: Segment): boolean => rule.notBeforeMs >= value.startMs && rule.notBeforeMs < value.endMs) ?? segments.find((value: Segment): boolean => value.id === unit?.segmentId) : segments.find((value: Segment): boolean => value.id === rule.segmentId);
    if (segment === undefined) throw contractError('INFORMATION_SEGMENT_NOT_FOUND', `${rule.id}: 정보 공개 구간을 찾을 수 없습니다.`, []);
    return {
      id: rule.id, segmentId: segment.id, notBeforeMs: rule.notBeforeMs,
      notBeforeUnitId: rule.notBeforeUnitId ?? unit?.id ?? null,
      notBeforeUnitOrder: rule.notBeforeUnitOrder ?? unit?.order ?? null,
      precision: rule.precision ?? 'exact-time', sourceRefs: [sourceRef(file.id, `/informationRules/${index}`, rule.id)],
    };
  });
  return {
    projectId: data.projectId, title: data.title,
    people: data.people.map((person, index) => ({ ...person, sourceRefs: [sourceRef(file.id, `/people/${index}`, person.id)] })),
    locations: data.locations.map((location, index) => ({ ...location, sourceRefs: [sourceRef(file.id, `/locations/${index}`, location.id)] })),
    scenes: data.scenes.map((scene, index) => ({ ...scene, sourceRefs: [sourceRef(file.id, `/scenes/${index}`, scene.id)] })),
    segments, units, informationRules,
    instructions: data.instructions.map((instruction, index) => ({ ...instruction, sourceRefs: [sourceRef(file.id, `/instructions/${index}`, instruction.id)] })),
    textPlacements: data.textPlacements.map((placement, index) => ({ ...placement, sourceRefs: [sourceRef(file.id, `/textPlacements/${index}`, placement.id)] })),
  };
}
