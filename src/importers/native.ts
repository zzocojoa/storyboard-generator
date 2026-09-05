import { NativeDatasetSchema } from '../domain/schema.js';
import type { Dataset, Handoff, NativeDataset, Snapshot, SourceRef } from '../domain/schema.js';
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
  return {
    projectId: data.projectId, title: data.title,
    people: data.people.map((person, index) => ({ ...person, sourceRefs: [sourceRef(file.id, `/people/${index}`, person.id)] })),
    locations: data.locations.map((location, index) => ({ ...location, sourceRefs: [sourceRef(file.id, `/locations/${index}`, location.id)] })),
    scenes: data.scenes.map((scene, index) => ({ ...scene, sourceRefs: [sourceRef(file.id, `/scenes/${index}`, scene.id)] })),
    segments: data.segments.map((segment, index) => ({ ...segment, sourceRefs: [sourceRef(file.id, `/segments/${index}`, segment.id)] })),
    units: data.units.map((unit, index) => ({ ...unit, sourceRefs: [sourceRef(file.id, `/units/${index}`, unit.id)] })),
    informationRules: data.informationRules.map((rule, index) => ({ ...rule, sourceRefs: [sourceRef(file.id, `/informationRules/${index}`, rule.id)] })),
    instructions: data.instructions.map((instruction, index) => ({ ...instruction, sourceRefs: [sourceRef(file.id, `/instructions/${index}`, instruction.id)] })),
    textPlacements: data.textPlacements.map((placement, index) => ({ ...placement, sourceRefs: [sourceRef(file.id, `/textPlacements/${index}`, placement.id)] })),
  };
}
