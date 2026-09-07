import { describe, expect, it } from 'vitest';
import type { Project, StoryboardFrame, TextCue, TextMappingDecision, Timebase } from '../src/domain/schema.js';
import { effectiveTextPlacementRange } from '../src/domain/text-placement.js';
import { formatAbsoluteProjectTimecode, formatProjectDurationTimecode } from '../src/domain/time.js';
import { exportShotCsv } from '../src/exporters/csv.js';
import { importPackage } from '../src/importers/import-package.js';
import { buildFrameImageContext } from '../src/proposal/context.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativePackage, productionPackage } from './helpers.js';

async function nativeOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

async function productionOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 2000 });
}

function dropFrameTimebase(numerator: 30000 | 60000): Timebase {
  return { fpsNumerator: numerator, fpsDenominator: 1001, dropFrame: true, sampleRate: 48000, startTimecode: '00:00:00;00' };
}

describe('15차 열린 Text Placement', (): void => {
  it('open_ended_placement_uses_explicit_text_cue_end', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const placement = project.dataset.textPlacements.find((candidate) => candidate.endMs === null);
    if (placement === undefined) throw new Error('열린 Placement 검증 자료가 없습니다.');
    const cue: TextCue = project.textCues.find((candidate) => candidate.placementId === placement.id) as TextCue;
    expect(effectiveTextPlacementRange(project, placement.id)).toEqual(expect.objectContaining({ endMs: cue.endMs, evidence: 'text-cue', issues: [] }));
  });

  it('open_ended_placement_uses_canonical_end_when_no_cue_end', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const placement = project.dataset.textPlacements.find((candidate) => candidate.endMs === null);
    if (placement === undefined) throw new Error('열린 Placement 검증 자료가 없습니다.');
    const mapping: TextMappingDecision = project.textMappingDecisions.find((candidate) => candidate.placementId === placement.id) as TextMappingDecision;
    const changed: Project = {
      ...project,
      textCues: project.textCues.filter((cue) => cue.placementId !== placement.id),
      textMappingDecisions: project.textMappingDecisions.map((candidate) => candidate.id === mapping.id
        ? { ...candidate, status: 'confirmed', canonicalStartMs: placement.startMs, canonicalEndMs: placement.startMs + 1500 } : candidate),
    };
    expect(effectiveTextPlacementRange(changed, placement.id)).toEqual(expect.objectContaining({ endMs: placement.startMs + 1500, evidence: 'canonical-range', issues: [] }));
  });

  it('open_ended_placement_without_resolved_end_requires_review', async (): Promise<void> => {
    const project: Project = await productionOutline();
    const placement = project.dataset.textPlacements.find((candidate) => candidate.endMs === null);
    if (placement === undefined) throw new Error('열린 Placement 검증 자료가 없습니다.');
    const changed: Project = {
      ...project,
      textCues: project.textCues.filter((cue) => cue.placementId !== placement.id),
      textMappingDecisions: project.textMappingDecisions.map((mapping) => mapping.placementId === placement.id
        ? { ...mapping, canonicalStartMs: null, canonicalEndMs: null } : mapping),
    };
    expect(effectiveTextPlacementRange(changed, placement.id)).toEqual(expect.objectContaining({ endMs: null, evidence: 'unresolved', issues: expect.arrayContaining([expect.objectContaining({ code: 'TEXT_PLACEMENT_END_REVIEW_REQUIRED' })]) }));
  });

  it('expired_open_ended_placement_is_excluded_from_frame_context', async (): Promise<void> => {
    const source: Project = await nativeOutline();
    const placement = source.dataset.textPlacements[0];
    if (placement === undefined) throw new Error('Placement 검증 자료가 없습니다.');
    const project: Project = { ...source, dataset: { ...source.dataset, textPlacements: source.dataset.textPlacements.map((candidate) => candidate.id === placement.id ? { ...candidate, endMs: null } : candidate) } };
    const cue: TextCue = project.textCues.find((candidate) => candidate.placementId === placement.id) as TextCue;
    const shot = project.shots.find((candidate) => candidate.segmentId === placement.segmentId);
    if (shot === undefined || cue.endMs >= shot.endMs) throw new Error('Placement 종료 뒤 Frame을 만들 수 없습니다.');
    const frame: StoryboardFrame = { id: 'expired-text-frame', shotId: shot.id, offsetMs: cue.endMs - shot.startMs, role: 'key', description: '자막 종료 뒤', imageAssetId: null, visualReview: 'pending' };
    const changed: Project = { ...project, frames: [...project.frames, frame] };
    expect(buildFrameImageContext(changed, frame.id).textMappings.map((mapping) => mapping.placementId)).not.toContain(placement.id);
  });

  it('future_text_mapping_does_not_leak_after_effective_end', async (): Promise<void> => {
    const source: Project = await nativeOutline();
    const placement = source.dataset.textPlacements[0];
    if (placement === undefined) throw new Error('Placement 검증 자료가 없습니다.');
    const project: Project = { ...source, dataset: { ...source.dataset, textPlacements: source.dataset.textPlacements.map((candidate) => candidate.id === placement.id ? { ...candidate, endMs: null } : candidate) } };
    const cue: TextCue = project.textCues.find((candidate) => candidate.placementId === placement.id) as TextCue;
    const shot = project.shots.find((candidate) => candidate.segmentId === placement.segmentId);
    if (shot === undefined || cue.endMs >= shot.endMs) throw new Error('Placement 종료 뒤 Frame을 만들 수 없습니다.');
    const frame: StoryboardFrame = { id: 'future-text-frame', shotId: shot.id, offsetMs: cue.endMs - shot.startMs + 1, role: 'key', description: '자막 범위 밖', imageAssetId: null, visualReview: 'pending' };
    const context = buildFrameImageContext({ ...project, frames: [...project.frames, frame] }, frame.id);
    expect(JSON.stringify(context.textMappings)).not.toContain(placement.text);
  });
});

describe('15차 절대·길이 Timecode', (): void => {
  it('duration_does_not_add_start_timecode', (): void => {
    expect(formatProjectDurationTimecode(1000, { fpsNumerator: 24, fpsDenominator: 1, dropFrame: false, sampleRate: 48000, startTimecode: '01:00:00:00' })).toBe('00:01:00');
  });

  it('absolute_timecode_adds_start_timecode_once', (): void => {
    expect(formatAbsoluteProjectTimecode(1000, { fpsNumerator: 24, fpsDenominator: 1, dropFrame: false, sampleRate: 48000, startTimecode: '01:00:00:00' })).toBe('01:00:01:00');
  });

  it('drop_frame_2997_skips_labels_at_minute', (): void => {
    expect(formatProjectDurationTimecode(60_060, dropFrameTimebase(30000))).toBe('01:00;02');
  });

  it('drop_frame_2997_keeps_tenth_minute', (): void => {
    expect(formatProjectDurationTimecode(600_000, dropFrameTimebase(30000))).toBe('10:00;00');
  });

  it('drop_frame_5994_skips_four_labels', (): void => {
    expect(formatProjectDurationTimecode(60_060, dropFrameTimebase(60000))).toBe('01:00;04');
  });

  it('drop_frame_wraps_at_24_hours', (): void => {
    expect(formatProjectDurationTimecode(86_399_914, dropFrameTimebase(30000))).toBe('00:00;00');
  });

  it('project_rail_uses_duration_formatter', (): void => {
    const timebase: Timebase = { fpsNumerator: 24, fpsDenominator: 1, dropFrame: false, sampleRate: 48000, startTimecode: '10:00:00:00' };
    expect(formatProjectDurationTimecode(17_500, timebase)).toBe('00:17:12');
    expect(formatProjectDurationTimecode(17_500, timebase)).not.toBe(formatAbsoluteProjectTimecode(17_500, timebase));
  });

  it('timeline_and_exports_use_absolute_formatter', async (): Promise<void> => {
    const project: Project = await nativeOutline();
    const changed: Project = { ...project, handoff: { ...project.handoff, timebase: { ...project.handoff.timebase, startTimecode: '01:00:00:00' } } };
    expect(exportShotCsv(changed)).toContain('01:00:00:00');
  });
});
