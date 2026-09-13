import { issue } from './errors.js';
import type { Issue, Project, SourceUnit } from './schema.js';
import { directVisualLinks, sourceRevealEvidenceMs } from './source-anchor.js';

function emittedUnitStart(project: Project, unit: SourceUnit): number | null {
  const visual: number[] = project.shots.flatMap((shot): number[] => directVisualLinks(shot).filter((link): boolean => link.unitId === unit.id).flatMap((link): number[] => {
    const start: number | null = sourceRevealEvidenceMs(project, shot, link);
    return start === null ? [] : [start];
  }));
  const audio: number[] = project.audioCues.filter((cue): boolean => cue.unitId === unit.id).map((cue): number => cue.startMs);
  const text: number[] = project.textCues.filter((cue): boolean => {
    if (cue.authority !== 'placement') return cue.unitId === unit.id;
    const mapping = project.textMappingDecisions.find((value): boolean => value.placementId === cue.placementId);
    return mapping?.canonicalUnitId === unit.id && !['separate-element', 'standalone-placement'].includes(mapping.relation);
  }).map((cue): number => cue.startMs);
  const times: number[] = [...visual, ...audio, ...text];
  return times.length === 0 ? null : Math.min(...times);
}

/** 그림·글자·발화 중 첫 공개를 기준으로 원문 순서를 비교한다. 같은 시각의 공개는 허용한다. */
export function storyboardUnitOrderIssues(project: Project, segmentId: string): Issue[] {
  const units: SourceUnit[] = project.dataset.units.filter((unit): boolean => unit.segmentId === segmentId).sort((left, right): number => left.order - right.order);
  return units.flatMap((unit, index): Issue[] => {
    const start: number | null = emittedUnitStart(project, unit);
    if (start === null) return [];
    const prior: number[] = units.slice(0, index).flatMap((previous): number[] => {
      const time: number | null = emittedUnitStart(project, previous);
      return time === null ? [] : [time];
    });
    const lower: number = Math.max(0, ...prior);
    return start < lower ? [issue('AUTOMATION_UNIT_ORDER_REVERSED', 'conflict', unit.id, 'firstEmission', `그림·글자·발화의 최초 공개가 앞선 원문보다 빠릅니다: ${unit.id}`, `>=${lower}`, String(start), unit.sourceRefs)] : [];
  });
}
