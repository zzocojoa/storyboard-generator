import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readBuildManifest } from '../src/build.js';
import { reviewFinalReadiness } from '../src/domain/final-readiness.js';
import { auditGenerationRecords } from '../src/domain/generation-records.js';
import { verifyStoredAsset } from '../src/domain/media-inspection.js';
import { reviewAudioPlaybackAt } from '../src/domain/playback.js';
import type { Asset, AudioCue, GenerationRecord, Project, Shot, StoryboardFrame } from '../src/domain/schema.js';
import { activeVisualSourceLinks, sourceAnchorRange } from '../src/domain/source-anchor.js';
import { updateAudioCueTiming } from '../src/domain/tracks.js';
import { reviewVisualOutputAt } from '../src/domain/visual-output.js';
import { exportShotCsvForPolicy } from '../src/exporters/csv.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { exportProjectPdfForPolicy } from '../src/exporters/pdf.js';
import { readReviewArchive, writeReviewBundle } from '../src/exporters/review-bundle.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { pcmWav, productionPackage } from './helpers.js';
import { nonSourcedShot } from './readiness-fixtures.js';

const roots: string[] = [];
afterEach(async (): Promise<void> => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function golden(): Promise<Project> { return createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 }); }

describe('PRJ-007 Final 계약 보존', (): void => {
  it('prj007_draft_output_remains_available', async (): Promise<void> => {
    const project: Project = await golden(); const csv: string = exportShotCsvForPolicy(project, {}, { maturity: 'draft', channel: 'csv-export' });
    expect(csv).toContain('DRAFT'); const pdf: Buffer = await exportProjectPdfForPolicy(project, resolve('assets/fonts/NanumGothic-Regular.ttf'), async (): Promise<Buffer> => { throw new Error('미생성 프레임은 읽으면 안 됩니다.'); }, { maturity: 'draft', channel: 'pdf-export' }, {});
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF'); expect(project.dataset.segments.at(-1)?.endMs).toBe(1500000);
  });
  it('prj007_final_output_requires_confirmed_text', async (): Promise<void> => {
    const project: Project = await golden(); const report = reviewFinalReadiness(project, {});
    expect(report.counts.textProposed).toBeGreaterThan(0); expect(report.finalReady).toBe(false);
    expect(report.issues.filter((issue): boolean => issue.code === 'TEXT_TIMING_CONFIRMATION_REQUIRED')).toHaveLength(project.textCues.length);
  });
  it('prj007_visual_timeline_is_playhead_safe', async (): Promise<void> => {
    const base: Project = await golden(); const assets: Asset[] = base.frames.map((frame: StoryboardFrame): Asset => ({ id: `verified:${frame.id}`, subjectId: frame.id, kind: 'image', path: `assets/${frame.id}.png`, mimeType: 'image/png', sha256: 'a'.repeat(64), description: '도메인 판정 검증', durationMs: null, version: 1 }));
    const project: Project = { ...base, assets, frames: base.frames.map((frame: StoryboardFrame): StoryboardFrame => ({ ...frame, visualReview: 'accepted', imageAssetId: `verified:${frame.id}` })) };
    let safeCount: number = 0; let blockedGapCount: number = 0;
    for (const shot of project.shots) {
      const times: number[] = [shot.startMs, shot.endMs - 1, ...shot.sourceLinks.flatMap((link): number[] => {
        const range = sourceAnchorRange(project, shot, link); return range === null ? [] : [range.startMs, range.endMs];
      })].filter((time: number): boolean => time < shot.endMs);
      for (const time of times) {
        const decision = reviewVisualOutputAt(project, time, 'program-monitor');
        if (activeVisualSourceLinks(project, shot, time).length === 0) { expect(decision.renderMode).toBe('blocked'); blockedGapCount += 1; }
        if (decision.renderMode === 'bitmap') { expect(decision.issues).toEqual([]); expect(decision.activeSourceUnitIds.length).toBeGreaterThan(0); safeCount += 1; }
      }
    }
    expect(safeCount).toBeGreaterThan(0); expect(blockedGapCount).toBeGreaterThan(0); expect(project.dataset).toEqual(base.dataset);
  });
  it('prj007_hold_previous_contract_remains_valid', async (): Promise<void> => {
    const base: Project = await golden(); const project: Project = { ...base, shots: base.shots.map((shot: Shot, index: number): Shot => index === 0 ? nonSourcedShot(shot, 'black') : index === 1 ? nonSourcedShot(shot, 'hold-previous') : shot) };
    expect(reviewVisualOutputAt(project, project.shots[1]!.startMs, 'program-monitor')).toMatchObject({ renderMode: 'hold-previous', imageAssetId: null, issues: [] });
    expect(project.dataset).toEqual(base.dataset);
  });
  it('prj007_generation_audit_remains_valid', async (): Promise<void> => {
    const base: Project = await golden(); const record: GenerationRecord = { id: 'prj007-record', provider: 'codex-app', model: 'legacy', modelVersion: null, generatorBuild: null, requestId: null,
      prompt: '역사적 생성 검증', templateVersion: '1', seed: null, referenceHashes: [], resultAssetIds: [], shotIds: [base.shots[0]!.id], createdAt: '2026-09-07T00:00:00.000Z' };
    const introduced: Project = { ...base, revision: 1, generationRecords: [record] }; const current: Project = { ...introduced, revision: 2 };
    expect(auditGenerationRecords(current, [base, introduced, current])[0]).toMatchObject({ introducedRevision: 1, observedRevisions: [1, 2], recordIntegrityState: 'unchanged', currentTargetState: 'current' });
  });
  it('prj007_review_bundle_is_reproducible', async (): Promise<void> => {
    const root: string = await mkdtemp(join(tmpdir(), 'prj007-review-repro-')); roots.push(root);
    const project: Project = await golden(); const dataRoot: string = join(root, 'data'); const directory: string = join(dataRoot, sha256Text(project.projectId));
    await mkdir(join(directory, 'versions'), { recursive: true }); const bytes: string = exportProjectJson(project);
    await writeFile(join(directory, 'project.json'), bytes); await writeFile(join(directory, 'versions/000000.json'), bytes);
    const archive = await readReviewArchive(dataRoot, project.projectId); const options = { maturity: 'draft' as const, createdAt: '2026-09-07T00:00:00.000Z', build: readBuildManifest(), fontPath: resolve('assets/fonts/NanumGothic-Regular.ttf') };
    const first = await writeReviewBundle(archive, { ...options, output: join(root, 'first') }, []); const second = await writeReviewBundle(archive, { ...options, output: join(root, 'second') }, []);
    expect(second).toEqual(first); for (const file of first.files) expect(await readFile(join(root, 'second', file.path))).toEqual(await readFile(join(root, 'first', file.path)));
    expect(await readFile(join(directory, 'project.json'), 'utf8')).toBe(bytes);
  });
  it('prj007_unit045_safe_audio_remains_valid', async (): Promise<void> => {
    const base: Project = await golden(); const cue: AudioCue = base.audioCues.find((item: AudioCue): boolean => item.unitId === 'UNIT-045')!;
    const edited: Project = updateAudioCueTiming(base, cue.id, { startMs: 849000, endMs: 851000, timingRelation: 'j-cut' });
    const bytes: Buffer = pcmWav(2000, 48000, 1, 16); const asset: Asset = { id: 'unit045-pcm', kind: 'audio', subjectId: cue.id, path: 'assets/unit045.wav',
      mimeType: 'audio/wav', sha256: sha256Bytes(bytes), description: 'J-cut 호출음', durationMs: 2000, audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' }, version: 1 };
    const project: Project = { ...edited, assets: [asset], audioCues: edited.audioCues.map((item: AudioCue): AudioCue => item.id === cue.id ? { ...item, assetId: asset.id, timingStatus: 'measured' } : item) };
    await expect(verifyStoredAsset(project, asset, bytes)).resolves.toMatchObject({ durationMs: 2000, sampleRate: 48000, channels: 1, codec: 'pcm_s16le' }); expect(reviewAudioPlaybackAt(project, 849500).playable.map((item: AudioCue): string => item.id)).toContain(cue.id);
    expect(reviewAudioPlaybackAt(project, 851000).playable.map((item: AudioCue): string => item.id)).not.toContain(cue.id); expect(project.dataset).toEqual(base.dataset);
  });
});
