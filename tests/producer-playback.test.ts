import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { reviewProducerTransitionAt, reviewProducerVisualAt } from '../src/domain/producer-playback.js';
import type { Project, Shot } from '../src/domain/schema.js';
import { reviewVisualOutputAt } from '../src/domain/visual-output.js';
import { sha256Text } from '../src/importers/integrity.js';
import { ProjectStore } from '../src/server/store.js';
import { producerPlaybackFixture } from './producer-playback-helpers.js';

describe('제작자 시간순 검토', (): void => {
  it('producer_preview_shows_pending_images_without_changing_approval_or_final_output', async (): Promise<void> => {
    const { project } = await producerPlaybackFixture(); const before = structuredClone(project);
    expect(reviewProducerVisualAt(project, 5000)).toMatchObject({ renderMode: 'bitmap', visualReview: 'pending', channel: 'producer-review' });
    expect(reviewVisualOutputAt(project, 5000, 'program-monitor').issues.map((issue): string => issue.code)).toContain('FRAME_OUTPUT_REVIEW_REQUIRED');
    expect(reviewFinalReadiness(project, Object.fromEntries(project.assets.map((asset) => [asset.id, 'verified']))).finalReady).toBe(false);
    const rejected: Project = { ...project, frames: project.frames.map((frame) => ({ ...frame, visualReview: 'rejected' })) };
    expect(reviewProducerVisualAt(rejected, 5000).issues.map((issue): string => issue.code)).toContain('FRAME_OUTPUT_REJECTED');
    const accepted: Project = { ...project, frames: project.frames.map((frame) => ({ ...frame, visualReview: 'accepted' })) };
    expect(reviewVisualOutputAt(accepted, 5000, 'program-monitor').renderMode).toBe('bitmap');
    expect(project).toEqual(before);
  });

  it('producer_preview_preserves_source_gates_coverage_asset_subject_and_frame_boundaries', async (): Promise<void> => {
    const { project, shotId } = await producerPlaybackFixture();
    expect(reviewProducerVisualAt(project, 7999).frameId).not.toBe('review-key');
    expect(reviewProducerVisualAt(project, 8000).frameId).toBe('review-key');
    expect(reviewProducerVisualAt(project, 13498).frameId).toBe('review-key');
    expect(reviewProducerVisualAt(project, 13499).frameId).toBe('review-end');
    expect(reviewProducerVisualAt(project, 17500).renderMode).toBe('blocked');
    const gap: Project = { ...project, shots: project.shots.map((shot) => shot.id !== shotId ? shot : { ...shot,
      sourceLinks: shot.sourceLinks.map((link) => link.unitId !== '동작' ? link : { ...link,
        temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: 1000, status: 'confirmed', basis: 'manual' } }) }) };
    expect(reviewProducerVisualAt(gap, 5999).renderMode).toBe('bitmap');
    expect(reviewProducerVisualAt(gap, 6000).issues.map((issue): string => issue.code)).toContain('SHOT_VISUAL_COVERAGE_GAP');
    const variants: Project[] = [
      { ...project, assets: project.assets.map((asset) => ({ ...asset, subjectId: 'wrong-frame' })) },
      { ...project, frames: project.frames.map((frame) => ({ ...frame, imageAssetId: null })) },
      { ...project, shots: project.shots.map((shot) => shot.id !== shotId ? shot : { ...shot, sourceLinks: [] }) },
      { ...project, dataset: { ...project.dataset, informationRules: project.dataset.informationRules.map((rule) => ({ ...rule, precision: 'exact-time', baseNotBeforeMs: 8000 })) } },
      { ...project, frames: project.frames.map((frame) => frame.shotId === shotId ? { ...frame, offsetMs: 4000, role: 'key' } : frame) },
    ];
    for (const variant of variants) expect(reviewProducerVisualAt(variant, 5000).renderMode).toBe('blocked');
  });

  it('producer_preview_uses_pending_predecessor_for_hold_and_keeps_transition_reveal_rules', async (): Promise<void> => {
    const { project, shotId } = await producerPlaybackFixture();
    const hold: Project = { ...project, shots: project.shots.map((shot) => shot.startMs === 13500 ? { ...shot, visualMode: 'hold-previous', sourceLinks: [], informationIds: [] } : shot) };
    expect(reviewProducerVisualAt(hold, 14000)).toMatchObject({ renderMode: 'hold-previous', sourceFrameId: 'review-end', visualReview: 'pending' });
    expect(reviewVisualOutputAt(hold, 14000, 'program-monitor').renderMode).toBe('blocked');
    const gap: Project = { ...hold, shots: hold.shots.map((shot) => shot.id !== shotId ? shot : { ...shot, sourceLinks: [] }) };
    expect(reviewProducerVisualAt(gap, 14000).renderMode).toBe('blocked');
    const black: Project = { ...hold, shots: hold.shots.map((shot) => shot.id === shotId ? { ...shot, visualMode: 'black', sourceLinks: [], informationIds: [] } : shot) };
    expect(reviewProducerVisualAt(black, 14000)).toMatchObject({ renderMode: 'hold-previous', imageAssetId: null });
    const transition = (input: Project): Project => ({ ...input, shots: input.shots.map((shot): Shot => shot.endMs === 5000 ? { ...shot,
      transitionOut: { kind: 'dissolve', durationMs: 1000, incomingExposure: 'from-transition-start', note: '' } } : shot) });
    expect(reviewProducerTransitionAt(transition(project), 4000).renderMode).toBe('blocked');
    const withoutInformation: Project = { ...project, dataset: { ...project.dataset, informationRules: [], units: project.dataset.units.map((unit) => ({ ...unit, informationIds: [] })) }, shots: project.shots.map((shot) => ({ ...shot, informationIds: [] })) };
    expect(reviewProducerTransitionAt(transition(withoutInformation), 3999).renderMode).toBe('blocked');
    expect(reviewProducerTransitionAt(transition(withoutInformation), 4000)).toMatchObject({ renderMode: 'bitmap', visualReview: 'pending', layer: 'incoming' });
    expect(reviewVisualOutputAt(transition(withoutInformation), 4000, 'transition-preview').renderMode).toBe('blocked');
  });

  it('producer_preview_store_verifies_actual_media_revision_and_concurrent_edits_without_writes', async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), 'producer-playback-')); const store: ProjectStore = new ProjectStore(root);
    try {
      const fixture = await producerPlaybackFixture(); await store.create(fixture.source);
      const project = await store.update(fixture.source.projectId, 0, (): Project => fixture.project, fixture.writes);
      const file = join(root, sha256Text(project.projectId), 'project.json'); const original = await readFile(file);
      const output = await store.producerVisual(project.projectId, project.revision, 5000);
      expect(output.decision.visualReview).toBe('pending'); expect(output.mimeType).toBe('image/png');
      await expect(store.safeVisual(project.projectId, 5000, 'program-monitor')).rejects.toMatchObject({ code: 'VISUAL_OUTPUT_BLOCKED' });
      await expect(store.producerVisual(project.projectId, 0, 5000)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
      const assetPath = join(root, sha256Text(project.projectId), output.asset!.path);
      await writeFile(assetPath, Buffer.from('corrupt'));
      await expect(store.producerVisual(project.projectId, project.revision, 5000)).rejects.toMatchObject({ code: 'STORED_ASSET_HASH_MISMATCH' });
      await writeFile(assetPath, output.content);
      const originalRead = store.read.bind(store); let reads: number = 0;
      const spy = vi.spyOn(store, 'read').mockImplementation(async (id): Promise<Project> => { const value = await originalRead(id); reads += 1; return reads === 2 ? { ...value, title: '동시 편집' } : value; });
      await expect(store.producerVisual(project.projectId, project.revision, 5000)).rejects.toMatchObject({ code: 'AUDIT_SNAPSHOT_CHANGED' });
      spy.mockRestore(); expect(await readFile(file)).toEqual(original);
    } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
  });
});
