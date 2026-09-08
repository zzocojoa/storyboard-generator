import { describe, expect, it } from 'vitest';
import { reviewFrameOutput } from '../src/domain/frame-output.js';
import type { Asset, NativeDataset, Project, Shot, StoryboardFrame } from '../src/domain/schema.js';
import { ProjectSchema } from '../src/domain/schema.js';
import { validateProject } from '../src/domain/validation.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Text } from '../src/importers/integrity.js';
import { parseProject } from '../src/io/project.js';
import { buildFrameImageContext } from '../src/proposal/context.js';
import { applySegmentProposal, SegmentProposalSchema } from '../src/proposal/model.js';
import type { SegmentProposal } from '../src/proposal/model.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativeData, nativePackage, withNativeData } from './helpers.js';

async function outline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

async function informationOutline(): Promise<Project> {
  const payload = await nativePackage();
  const data: NativeDataset = nativeData(payload);
  return createSourceOutline(importPackage(withNativeData(payload, {
    ...data,
    units: data.units.map((unit) => unit.id === '동작' ? { ...unit, informationIds: ['info:late'] } : unit),
    informationRules: [{ id: 'info:late', segmentId: 'demonstration', notBeforeMs: 9000,
      notBeforeUnitId: '동작', notBeforeUnitOrder: 2, precision: 'exact-time' }],
  })), { proposedTextHoldMs: 2000 });
}

type ProposedLink = { unitId: string; usage: 'primary-visual' | 'continued-visual' | 'audio-only' | 'context-only'; anchor?: { startPermille: number; endPermille: number } };

function proposal(links: readonly ProposedLink[], visualMode: 'sourced' | 'black' | 'hold-previous', frames: readonly { atPermille: number; role: 'start' | 'key' | 'end'; description: string }[]): SegmentProposal {
  return SegmentProposalSchema.parse({ shots: [{
    sourceLinks: links, durationWeight: 1, visualMode, frames,
    action: '원문에 연결된 화분 관리 장면', visualLocationId: null,
    camera: { size: 'CU', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null,
    screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '화분을 보여준다',
  }] });
}

function demonstrationLinks(): ProposedLink[] {
  return [
    { unitId: '안내-1', usage: 'audio-only' },
    { unitId: '동작', usage: 'primary-visual' },
    { unitId: '효과음', usage: 'audio-only' },
  ];
}

function acceptedPreviousFrameProject(project: Project): Project {
  const previous: Shot = project.shots[0] as Shot;
  const held: Shot = project.shots[1] as Shot;
  const previousFrame: StoryboardFrame = project.frames.find((frame) => frame.shotId === previous.id) as StoryboardFrame;
  const asset: Asset = {
    id: 'hold-source-image', kind: 'image', subjectId: previousFrame.id, path: 'assets/hold-source.png', mimeType: 'image/png',
    sha256: sha256Text('hold-source'), description: '이전 안전 프레임', durationMs: null, version: 1,
  };
  return {
    ...project,
    shots: project.shots.map((shot) => shot.id === held.id ? { ...shot, visualMode: 'hold-previous', sourceLinks: shot.sourceLinks.map((link) => ({ ...link, usage: 'audio-only' as const })) } : shot),
    frames: project.frames.map((frame) => frame.id === previousFrame.id ? { ...frame, imageAssetId: asset.id, visualReview: 'accepted' as const } : frame),
    assets: [...project.assets, asset],
  };
}

function errorCode(action: () => unknown): { code: string; message: string } {
  try { action(); }
  catch (error: unknown) {
    if (error instanceof Error && 'code' in error) return { code: String(error.code), message: error.message };
    throw error;
  }
  return { code: 'NONE', message: '' };
}

describe('15차 Proposal Frame과 Visual Mode', (): void => {
  it('proposal_frames_accept_optional_plan', (): void => {
    const parsed = proposal(demonstrationLinks(), 'sourced', [
      { atPermille: 0, role: 'start', description: '시작' },
      { atPermille: 500, role: 'key', description: '중간' },
      { atPermille: 1000, role: 'end', description: '끝' },
    ]);
    expect(parsed.shots[0]?.frames).toHaveLength(3);
  });

  it('legacy_proposal_without_frames_remains_compatible', (): void => {
    const parsed = SegmentProposalSchema.parse({ shots: [{
      sourceLinks: demonstrationLinks(), durationWeight: 1, action: '행동', visualLocationId: null,
      camera: { size: 'CU', angle: 'eye', move: 'static' }, presence: [], propIds: [], cameraAxis: null,
      screenDirection: null, informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '레거시 시작',
    }] });
    expect(parsed.shots[0]?.visualMode).toBeUndefined();
    expect(parsed.shots[0]?.frames).toBeUndefined();
  });

  it('project_1_5_migrates_visual_mode_to_sourced', async (): Promise<void> => {
    const project: Project = await outline();
    const legacy = { ...project, schemaVersion: '1.5.0', shots: project.shots.map(({ visualMode: _visualMode, ...shot }) => shot) };
    const migrated: Project = parseProject(legacy);
    expect(migrated.schemaVersion).toBe('1.8.0');
    expect(migrated.shots.every((shot) => shot.visualMode === 'sourced')).toBe(true);
  });

  it('schema_1_6_round_trip_preserves_visual_mode', async (): Promise<void> => {
    const project: Project = await outline();
    const changed: Project = { ...project, shots: project.shots.map((shot, index) => ({ ...shot, visualMode: index === 0 ? 'black' : shot.visualMode })) };
    expect(ProjectSchema.parse(JSON.parse(JSON.stringify(changed))).shots[0]?.visualMode).toBe('black');
  });

  it('sourced_shot_requires_start_frame_at_zero', async (): Promise<void> => {
    const project: Project = await outline();
    const first: Shot = project.shots[0] as Shot;
    const changed: Project = { ...project, frames: project.frames.map((frame) => frame.shotId === first.id ? { ...frame, offsetMs: 1 } : frame) };
    expect(validateProject(changed, project.dataset)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'FRAME_ROLE_TIME', entityId: expect.any(String) })]));
  });

  it('late_source_anchor_creates_key_frame', async (): Promise<void> => {
    const project: Project = await outline();
    const links: ProposedLink[] = [
      { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 700 } },
      { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 700, endPermille: 1000 } },
      { unitId: '효과음', usage: 'audio-only' },
    ];
    const applied: Project = applySegmentProposal(project, 'demonstration', proposal(links, 'sourced', []), 'late-anchor');
    expect(applied.frames.some((frame) => frame.shotId === 'late-anchor:shot:1' && frame.role === 'key')).toBe(true);
  });

  it('key_frame_offset_matches_anchor_start', async (): Promise<void> => {
    const project: Project = await outline();
    const links: ProposedLink[] = [
      { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 700 } },
      { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 700, endPermille: 1000 } },
      { unitId: '효과음', usage: 'audio-only' },
    ];
    const applied: Project = applySegmentProposal(project, 'demonstration', proposal(links, 'sourced', []), 'offset-anchor');
    const shot: Shot = applied.shots.find((candidate) => candidate.id === 'offset-anchor:shot:1') as Shot;
    expect(applied.frames.find((frame) => frame.shotId === shot.id && frame.role === 'key')?.offsetMs).toBe(Math.floor((shot.endMs - shot.startMs) * 0.7));
  });

  it('key_frame_context_includes_newly_active_source', async (): Promise<void> => {
    const project: Project = await outline();
    const links: ProposedLink[] = [
      { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 700 } },
      { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 700, endPermille: 1000 } },
      { unitId: '효과음', usage: 'audio-only' },
    ];
    const applied: Project = applySegmentProposal(project, 'demonstration', proposal(links, 'sourced', []), 'context-anchor');
    const frame: StoryboardFrame = applied.frames.find((candidate) => candidate.shotId === 'context-anchor:shot:1' && candidate.role === 'key') as StoryboardFrame;
    expect(buildFrameImageContext(applied, frame.id).sourceLinks.map((link) => link.unitId)).toContain('동작');
  });

  it('early_frame_context_excludes_future_source', async (): Promise<void> => {
    const project: Project = await outline();
    const links: ProposedLink[] = [
      { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 700 } },
      { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 700, endPermille: 1000 } },
      { unitId: '효과음', usage: 'audio-only' },
    ];
    const applied: Project = applySegmentProposal(project, 'demonstration', proposal(links, 'sourced', []), 'early-anchor');
    const frame: StoryboardFrame = applied.frames.find((candidate) => candidate.shotId === 'early-anchor:shot:1' && candidate.role === 'start') as StoryboardFrame;
    expect(buildFrameImageContext(applied, frame.id).sourceLinks.map((link) => link.unitId)).not.toContain('동작');
  });

  it('key_frame_context_respects_information_gate', async (): Promise<void> => {
    const project: Project = await informationOutline();
    const links: ProposedLink[] = [
      { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 500 } },
      { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 500, endPermille: 1000 } },
      { unitId: '효과음', usage: 'audio-only' },
    ];
    const proposed: SegmentProposal = proposal(links, 'sourced', []);
    proposed.shots[0]!.informationIds = ['info:late'];
    const applied: Project = applySegmentProposal(project, 'demonstration', proposed, 'gate-anchor');
    const key: StoryboardFrame = applied.frames.find((frame) => frame.shotId === 'gate-anchor:shot:1' && frame.role === 'key') as StoryboardFrame;
    expect(buildFrameImageContext(applied, key.id).allowedInformationIds).toContain('info:late');
  });

  it('sourced_visual_coverage_rejects_start_gap', async (): Promise<void> => {
    const project: Project = await outline();
    const links: ProposedLink[] = demonstrationLinks().map((link) => link.unitId === '동작' ? { ...link, anchor: { startPermille: 100, endPermille: 1000 } } : link);
    expect(errorCode(() => applySegmentProposal(project, 'demonstration', proposal(links, 'sourced', []), 'start-gap')).code).toBe('PROPOSAL_VISUAL_COVERAGE_GAP');
  });

  it('sourced_visual_coverage_rejects_middle_gap', async (): Promise<void> => {
    const project: Project = await outline();
    const links: ProposedLink[] = [
      { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 400 } },
      { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 600, endPermille: 1000 } },
      { unitId: '효과음', usage: 'audio-only' },
    ];
    expect(errorCode(() => applySegmentProposal(project, 'demonstration', proposal(links, 'sourced', []), 'middle-gap')).code).toBe('PROPOSAL_VISUAL_COVERAGE_GAP');
  });

  it('sourced_visual_coverage_accepts_adjacent_half_open_ranges', async (): Promise<void> => {
    const project: Project = await outline();
    const links: ProposedLink[] = [
      { unitId: '안내-1', usage: 'primary-visual', anchor: { startPermille: 0, endPermille: 400 } },
      { unitId: '동작', usage: 'primary-visual', anchor: { startPermille: 400, endPermille: 1000 } },
      { unitId: '효과음', usage: 'audio-only' },
    ];
    expect(() => applySegmentProposal(project, 'demonstration', proposal(links, 'sourced', []), 'adjacent')).not.toThrow();
  });

  it('black_visual_mode_allows_no_direct_visual_source', async (): Promise<void> => {
    const project: Project = await outline();
    const links: ProposedLink[] = demonstrationLinks().map((link) => ({ ...link, usage: 'audio-only' }));
    expect(() => applySegmentProposal(project, 'demonstration', proposal(links, 'black', []), 'black')).not.toThrow();
  });

  it('black_mode_disables_image_generation', async (): Promise<void> => {
    const project: Project = await outline();
    const shot: Shot = project.shots[0] as Shot;
    const changed: Project = { ...project, shots: project.shots.map((candidate) => candidate.id === shot.id ? { ...candidate, visualMode: 'black' } : candidate) };
    expect(errorCode(() => buildFrameImageContext(changed, project.frames.find((frame) => frame.shotId === shot.id)!.id)).code).toBe('FRAME_GENERATION_NOT_APPLICABLE');
  });

  it('black_mode_renders_deterministic_output', async (): Promise<void> => {
    const project: Project = await outline();
    const shot: Shot = project.shots[0] as Shot;
    const frame: StoryboardFrame = project.frames.find((candidate) => candidate.shotId === shot.id) as StoryboardFrame;
    const changed: Project = { ...project, shots: project.shots.map((candidate) => candidate.id === shot.id ? { ...candidate, visualMode: 'black', sourceLinks: [] } : candidate) };
    expect(reviewFrameOutput(changed, frame.id, 'program-monitor')).toEqual(expect.objectContaining({ renderMode: 'black', renderBitmap: false, issues: [] }));
  });

  it('hold_previous_mode_requires_previous_contiguous_shot', async (): Promise<void> => {
    const project: Project = acceptedPreviousFrameProject(await outline());
    const held: Shot = project.shots[1] as Shot;
    const changed: Project = { ...project, shots: project.shots.map((shot) => shot.id === held.id ? { ...shot, startMs: shot.startMs + 1 } : shot) };
    expect(reviewFrameOutput(changed, project.frames.find((frame) => frame.shotId === held.id)!.id, 'program-monitor').issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'HOLD_PREVIOUS_SOURCE_UNAVAILABLE' })]));
  });

  it('hold_previous_uses_previous_output_safe_frame', async (): Promise<void> => {
    const project: Project = acceptedPreviousFrameProject(await outline());
    const held: Shot = project.shots[1] as Shot;
    const decision = reviewFrameOutput(project, project.frames.find((frame) => frame.shotId === held.id)!.id, 'program-monitor');
    expect(decision).toEqual(expect.objectContaining({ renderMode: 'hold-previous', imageAssetId: 'hold-source-image' }));
    expect(decision.sourceFrameId).toBe(project.frames.find((frame) => frame.shotId === project.shots[0]?.id)?.id);
  });

  it('hold_previous_without_safe_frame_is_blocked', async (): Promise<void> => {
    const project: Project = await outline();
    const held: Shot = project.shots[1] as Shot;
    const changed: Project = { ...project, shots: project.shots.map((shot) => shot.id === held.id ? { ...shot, visualMode: 'hold-previous', sourceLinks: [] } : shot) };
    expect(reviewFrameOutput(changed, project.frames.find((frame) => frame.shotId === held.id)!.id, 'program-monitor')).toEqual(expect.objectContaining({ renderMode: 'blocked', issues: expect.arrayContaining([expect.objectContaining({ code: 'HOLD_PREVIOUS_PREDECESSOR_NOT_SAFE' })]) }));
  });

  it('non_sourced_mode_rejects_direct_visual_links', async (): Promise<void> => {
    const project: Project = await outline();
    const first: Shot = project.shots[0] as Shot;
    const changed: Project = { ...project, shots: project.shots.map((shot) => shot.id === first.id ? { ...shot, visualMode: 'black' } : shot) };
    expect(validateProject(changed, project.dataset)).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'NON_SOURCED_DIRECT_VISUAL_LINK', entityId: first.id })]));
  });

  it('proposal_information_without_source_does_not_report_infinity', async (): Promise<void> => {
    const project: Project = await informationOutline();
    const proposed: SegmentProposal = proposal(demonstrationLinks().map((link) => ({ ...link, usage: 'audio-only' })), 'black', []);
    proposed.shots[0]!.informationIds = ['info:late'];
    const result = errorCode(() => applySegmentProposal(project, 'demonstration', proposed, 'missing-info-source'));
    expect(result.code).toBe('PROPOSAL_INFORMATION_WITHOUT_SOURCE');
    expect(result.message).not.toMatch(/Infinity|NaN/u);
  });
});
