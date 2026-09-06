import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { attachAudioAsset } from '../src/domain/audio-asset.js';
import type { AttachedAudioAsset } from '../src/domain/audio-asset.js';
import { textCueInformationIds } from '../src/domain/emission.js';
import { contractError } from '../src/domain/errors.js';
import { applyGeneratedImage } from '../src/domain/media.js';
import { inspectAudioBytes, inspectImageBytes, MAX_AUDIO_BYTES } from '../src/domain/media-inspection.js';
import { updatePlacementInformationDecision } from '../src/domain/placement-information.js';
import { playableAudioCuesAt, playableTextCuesAt, reviewTextPlaybackAt } from '../src/domain/playback.js';
import type { Asset, AudioCue, GenerationRecord, Project, Shot, ShotSourceLink, SourceUnit, StoryboardFrame, TextCue, TextMappingDecision, TextPlacement, TextPlacementInformationDecision } from '../src/domain/schema.js';
import { resolveTextCueAuthority } from '../src/domain/text.js';
import { updateTextMappingDecision } from '../src/domain/mapping.js';
import { rebuildTextDerivedAnchors, mergePlacementInformationDecisions } from '../src/domain/source-update.js';
import { validateProject } from '../src/domain/validation.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { exportProjectPdf } from '../src/exporters/pdf.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { parseProject } from '../src/io/project.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { ProjectStore } from '../src/server/store.js';
import { nativeData, nativePackage, pcmWav, png, productionPackage, testAudioNormalizer, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from './helpers.js';

const roots: string[] = [];

async function nativeOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

async function productionOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await productionPackage()), { proposedTextHoldMs: 3000 });
}

async function temporaryStore(project: Project): Promise<{ root: string; store: ProjectStore }> {
  const root: string = await mkdtemp(join(tmpdir(), 'storyboard-media-workflow-'));
  roots.push(root);
  const store: ProjectStore = new ProjectStore(join(root, 'data'));
  await store.create(project);
  return { root, store };
}

async function temporaryApp(project: Project): Promise<{ app: FastifyInstance; root: string; store: ProjectStore }> {
  const { root, store } = await temporaryStore(project);
  const webRoot: string = join(root, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<!doctype html><div id="root"></div>', 'utf8');
  const config: AppConfig = { host: '127.0.0.1', port: 4317, dataRoot: join(root, 'data'), webRoot,
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  return { app: await createApp(config, store, new CodexRequestStore(config.codex.requestRoot)), root, store };
}

function multipartAudio(bytes: Buffer, expectedRevision: number | null): { payload: Buffer; headers: { 'content-type': string } } {
  const boundary: string = '----cutroom-audio-boundary';
  const parts: Buffer[] = [];
  if (expectedRevision !== null) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="expectedRevision"\r\n\r\n${expectedRevision}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="recording.wav"\r\nContent-Type: audio/wav\r\n\r\n`));
  parts.push(bytes, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function sfxCue(project: Project): AudioCue {
  const cue: AudioCue | undefined = project.audioCues.find((candidate: AudioCue): boolean => candidate.kind === 'sfx');
  if (cue === undefined) throw new Error('SFX 검증 Cue가 없습니다.');
  return cue;
}

async function attach(project: Project, cue: AudioCue, durationMs: number, assetId: string): Promise<AttachedAudioAsset> {
  return attachAudioAsset(project, cue.id, assetId, { originalFileName: 'recording.wav', declaredMimeType: 'audio/wav',
    bytes: pcmWav(durationMs, project.handoff.timebase.sampleRate, 1, 16) }, testAudioNormalizer());
}

async function saveMutation(store: ProjectStore, project: Project, mutation: AttachedAudioAsset): Promise<Project> {
  if (mutation.relativePath === null || mutation.content === null) throw new Error('저장할 오디오 자산이 없습니다.');
  return store.update(project.projectId, project.revision, (): Project => mutation.project,
    [{ relativePath: mutation.relativePath, content: mutation.content }]);
}

async function acceptedImageStore(): Promise<{ app: FastifyInstance; store: ProjectStore; project: Project; frame: StoryboardFrame; path: string }> {
  const base: Project = await nativeOutline();
  const { app, store } = await temporaryApp(base);
  const frame: StoryboardFrame = base.frames[0] as StoryboardFrame;
  const mutation = await applyGeneratedImage(base, frame.id, 'generated-frame', '2026-09-06T00:00:00.000Z', {
    bytes: await png(2, 3), provider: 'codex-app', prompt: '검증', model: 'imagegen', requestId: 'request', mimeType: 'image/png', referenceHashes: [],
  });
  if (mutation.relativePath === null || mutation.content === null) throw new Error('저장할 이미지 자산이 없습니다.');
  await store.update(base.projectId, 0, (): Project => mutation.project,
    [{ relativePath: mutation.relativePath, content: mutation.content }]);
  const accepted: Project = await store.update(base.projectId, 1, (current: Project): Project => ({ ...current,
    frames: current.frames.map((candidate: StoryboardFrame): StoryboardFrame => candidate.id === frame.id ? { ...candidate, visualReview: 'accepted' } : candidate) }), []);
  const assetId: string = accepted.frames.find((candidate: StoryboardFrame): boolean => candidate.id === frame.id)?.imageAssetId ?? '';
  return { app, store, project: accepted, frame, path: await store.assetPath(base.projectId, assetId) };
}

function placementFixture(project: Project): { placement: TextPlacement; decision: TextMappingDecision; cue: TextCue; unit: SourceUnit } {
  const decision: TextMappingDecision = project.textMappingDecisions[0] as TextMappingDecision;
  const placement: TextPlacement = project.dataset.textPlacements.find((candidate: TextPlacement): boolean => candidate.id === decision.placementId) as TextPlacement;
  const cue: TextCue = project.textCues.find((candidate: TextCue): boolean => candidate.placementId === placement.id) as TextCue;
  const unit: SourceUnit = project.dataset.units.find((candidate: SourceUnit): boolean => candidate.id === (decision.canonicalUnitId ?? placement.unitId)) as SourceUnit;
  return { placement, decision, cue, unit };
}

async function lateGateAudioProject(assetId: string): Promise<{ project: Project; cue: AudioCue; asset: Asset; bytes: Buffer }> {
  const payload = await nativePackage();
  const data = nativeData(payload);
  const sound = data.units.find((unit): boolean => unit.kind === 'SOUND');
  if (sound === undefined) throw new Error('정보 Gate용 효과음 원문이 없습니다.');
  const informationId: string = 'LATE-AUDIO';
  const updated = { ...data,
    units: data.units.map((unit): typeof unit => unit.id === sound.id ? { ...unit, informationIds: [informationId] } : unit),
    informationRules: [...data.informationRules, { id: informationId, segmentId: sound.segmentId, notBeforeMs: 8000,
      notBeforeUnitId: sound.id, notBeforeUnitOrder: sound.order, precision: 'exact-time' as const }] };
  const base: Project = createSourceOutline(importPackage(withNativeData(payload, updated)), { proposedTextHoldMs: 2000 });
  const cue: AudioCue = sfxCue(base);
  const bytes: Buffer = pcmWav(500, 48000, 1, 16);
  const asset: Asset = { id: assetId, kind: 'audio', subjectId: cue.id, path: `assets/${sha256Text(assetId)}.wav`, mimeType: 'audio/wav',
    sha256: sha256Bytes(bytes), description: 'Gate 검증', durationMs: 500, version: 1, audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' } };
  return { cue, asset, bytes, project: { ...base, assets: [asset], audioCues: base.audioCues.map((value: AudioCue): AudioCue => value.id === cue.id
    ? { ...value, endMs: value.startMs + 500, timingStatus: 'measured', assetId } : value) } };
}

function standalone(project: Project): Project {
  const fixture = placementFixture(project);
  return updateTextMappingDecision(project, fixture.decision.id, { canonicalUnitId: null, relation: 'standalone-placement', status: 'confirmed',
    renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null, note: null });
}

function separate(project: Project): Project {
  const fixture = placementFixture(project);
  return updateTextMappingDecision(project, fixture.decision.id, { canonicalUnitId: fixture.unit.id, relation: 'separate-element', status: 'confirmed',
    renderCanonicalSeparately: true, canonicalStartMs: fixture.placement.startMs, canonicalEndMs: fixture.placement.startMs + 500, note: null });
}

function withInformationRule(project: Project, fixture: ReturnType<typeof placementFixture>, baseNotBeforeMs: number): Project {
  const informationId: string = 'PLACEMENT-INFO';
  return { ...project, dataset: { ...project.dataset,
    units: project.dataset.units.map((unit: SourceUnit): SourceUnit => unit.id === fixture.unit.id ? { ...unit, informationIds: [informationId] } : unit),
    informationRules: [...project.dataset.informationRules, { id: informationId, segmentId: fixture.placement.segmentId,
      baseNotBeforeMs, notBeforeUnitId: fixture.unit.id, notBeforeUnitOrder: fixture.unit.order, precision: 'exact-time', sourceRefs: fixture.unit.sourceRefs }] } };
}

function reviewCue(unit: SourceUnit, id: string): TextCue {
  return { id, segmentId: unit.segmentId, unitId: null, placementId: null, mappingDecisionId: null, authority: 'review-required',
    text: '검토 전', startMs: 5000, endMs: 5500, kind: 'overlay', timingStatus: 'proposed' };
}

function legacy14(project: Project): { [key: string]: unknown } {
  const legacy = JSON.parse(JSON.stringify(project)) as { [key: string]: unknown };
  legacy.schemaVersion = '1.4.0';
  delete legacy.textPlacementInformationDecisions;
  return legacy;
}

async function unit045Mutation(): Promise<{ base: Project; prepared: Project; cue: AudioCue; mutation: AttachedAudioAsset; bytes: Buffer }> {
  const base: Project = await productionOutline();
  const cue: AudioCue = base.audioCues.find((candidate: AudioCue): boolean => candidate.unitId === 'UNIT-045') as AudioCue;
  const prepared: Project = { ...base, audioCues: base.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id
    ? { ...candidate, startMs: 849000, endMs: 851000, timingRelation: 'j-cut', timingStatus: 'proposed' } : candidate) };
  const bytes: Buffer = await readFile('tests/fixtures/media/unit045-intercom-48000.wav');
  return { base, prepared, cue, bytes, mutation: await attachAudioAsset(prepared, cue.id, 'unit045-audio', {
    originalFileName: 'unit045-intercom-48000.wav', declaredMimeType: 'audio/wav', bytes }, testAudioNormalizer()) };
}

afterEach(async (): Promise<void> => {
  await Promise.all(roots.splice(0).map(async (root: string): Promise<void> => { await rm(root, { recursive: true, force: true }); }));
});

describe('A. AUDIO INSPECTION', (): void => {
  it('valid_pcm_wav_reports_actual_duration', async (): Promise<void> => {
    expect((await inspectAudioBytes(await nativeOutline(), pcmWav(1250, 48000, 1, 16), 'audio/wav', testAudioNormalizer())).durationMs).toBe(1250);
  });
  it('valid_pcm_wav_reports_sample_rate', async (): Promise<void> => {
    expect((await inspectAudioBytes(await nativeOutline(), pcmWav(200, 48000, 1, 16), 'audio/wav', testAudioNormalizer())).sampleRate).toBe(48000);
  });
  it('valid_pcm_wav_reports_channels', async (): Promise<void> => {
    expect((await inspectAudioBytes(await nativeOutline(), pcmWav(200, 48000, 2, 24), 'audio/wav', testAudioNormalizer())).channels).toBe(2);
  });
  it('truncated_wav_is_rejected', async (): Promise<void> => {
    const project: Project = await nativeOutline(); await expect(inspectAudioBytes(project, pcmWav(200, 48000, 1, 16).subarray(0, 50), 'audio/wav', testAudioNormalizer())).rejects.toThrowError();
  });
  it('declared_mime_mismatch_is_rejected', async (): Promise<void> => {
    const project: Project = await nativeOutline(); await expect(inspectAudioBytes(project, pcmWav(200, 48000, 1, 16), 'audio/mpeg', testAudioNormalizer())).rejects.toThrowError(expect.objectContaining({ code: 'ASSET_MIME_MISMATCH' }));
  });
  it('unsupported_audio_codec_is_rejected', async (): Promise<void> => {
    const bytes: Buffer = pcmWav(200, 48000, 1, 16); bytes.writeUInt16LE(3, 20);
    const project: Project = await nativeOutline(); await expect(inspectAudioBytes(project, bytes, 'audio/wav', testAudioNormalizer())).rejects.toThrowError(expect.objectContaining({ code: 'UNSUPPORTED_AUDIO_CODEC' }));
  });
  it('project_sample_rate_is_enforced', async (): Promise<void> => {
    expect((await inspectAudioBytes(await nativeOutline(), pcmWav(200, 44100, 1, 16), 'audio/wav', testAudioNormalizer())).sampleRate).toBe(48000);
  });
  it('normalized_audio_is_reinspected', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const first = await inspectAudioBytes(project, pcmWav(200, 44100, 2, 24), 'audio/wav', testAudioNormalizer());
    expect(await inspectAudioBytes(project, first.normalizedBytes, first.mimeType, testAudioNormalizer())).toEqual(expect.objectContaining({ sampleRate: 48000, channels: 2, codec: 'pcm_s16le' }));
  });
  it('audio_file_size_limit_is_enforced', async (): Promise<void> => {
    const project: Project = await nativeOutline(); await expect(inspectAudioBytes(project, Buffer.alloc(MAX_AUDIO_BYTES + 1), 'audio/wav', testAudioNormalizer())).rejects.toThrowError(expect.objectContaining({ code: 'AUDIO_FILE_SIZE_LIMIT' }));
  });
});

describe('B. AUDIO ASSET IMPORT', (): void => {
  it('sfx_audio_asset_can_be_attached', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const cue: AudioCue = sfxCue(project);
    expect((await attach(project, cue, 500, 'sfx')).project.audioCues.find((value: AudioCue): boolean => value.id === cue.id)?.assetId).toBe('sfx');
  });
  it('music_audio_asset_can_be_attached', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const cue: AudioCue = sfxCue(project);
    const music: Project = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((unit: SourceUnit): SourceUnit => unit.id === cue.unitId ? { ...unit, kind: 'MUSIC' } : unit) },
      audioCues: project.audioCues.map((candidate: AudioCue): AudioCue => candidate.id === cue.id ? { ...candidate, kind: 'music' } : candidate) };
    expect((await attach(music, { ...cue, kind: 'music' }, 500, 'music')).project.assets.at(-1)?.kind).toBe('audio');
  });
  it('imported_audio_sets_measured_status', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const cue: AudioCue = sfxCue(project);
    expect((await attach(project, cue, 500, 'measured')).project.audioCues.find((value: AudioCue): boolean => value.id === cue.id)?.timingStatus).toBe('measured');
  });
  it('imported_audio_updates_end_from_actual_duration', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const cue: AudioCue = sfxCue(project);
    expect((await attach(project, cue, 750, 'duration')).project.audioCues.find((value: AudioCue): boolean => value.id === cue.id)?.endMs).toBe(cue.startMs + 750);
  });
  it('imported_audio_creates_real_asset_file', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const cue: AudioCue = sfxCue(project); const { app, store } = await temporaryApp(project);
    const request = multipartAudio(pcmWav(500, 44100, 1, 16), 0);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.projectId}/audio/${cue.id}/asset`, ...request });
    expect(response.statusCode).toBe(201);
    const saved: Project = await store.read(project.projectId);
    const assetId: string | null = saved.audioCues.find((value: AudioCue): boolean => value.id === cue.id)?.assetId ?? null;
    expect(assetId).not.toBeNull();
    if (assetId === null) throw new Error('HTTP 등록 후 오디오 자산 ID가 없습니다.');
    expect((await readFile(await store.assetPath(project.projectId, assetId))).length).toBeGreaterThan(44);
    expect(saved.assets.find((asset: Asset): boolean => asset.id === assetId)?.audioMetadata?.sampleRate).toBe(project.handoff.timebase.sampleRate);
    await app.close();
  });
  it('imported_audio_sha_matches_stored_file', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const { store } = await temporaryStore(project); const mutation = await attach(project, sfxCue(project), 500, 'sha');
    const saved: Project = await saveMutation(store, project, mutation); const asset: Asset = saved.assets.find((value: Asset): boolean => value.id === 'sha') as Asset;
    expect(sha256Bytes(await readFile(await store.assetPath(project.projectId, asset.id)))).toBe(asset.sha256);
  });
  it('imported_audio_asset_subject_matches_cue', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const cue: AudioCue = sfxCue(project);
    expect((await attach(project, cue, 500, 'subject')).project.assets.at(-1)?.subjectId).toBe(cue.id);
  });
  it('replacing_audio_increments_asset_version', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const cue: AudioCue = sfxCue(project); const first = await attach(project, cue, 500, 'v1');
    expect((await attach(first.project, first.project.audioCues.find((value: AudioCue): boolean => value.id === cue.id) as AudioCue, 600, 'v2')).project.assets.at(-1)?.version).toBe(2);
  });
  it('replacing_audio_preserves_old_asset', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const cue: AudioCue = sfxCue(project); const first = await attach(project, cue, 500, 'old');
    expect((await attach(first.project, first.project.audioCues.find((value: AudioCue): boolean => value.id === cue.id) as AudioCue, 600, 'new')).project.assets.map((asset: Asset): string => asset.id)).toEqual(['old', 'new']);
  });
  it('invalid_j_cut_after_duration_is_rejected', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const cue: AudioCue = sfxCue(project);
    const jcut: Project = { ...project, audioCues: project.audioCues.map((value: AudioCue): AudioCue => value.id === cue.id ? { ...value, startMs: 4000, endMs: 6000, timingRelation: 'j-cut' } : value) };
    await expect(attach(jcut, { ...cue, startMs: 4000, endMs: 6000, timingRelation: 'j-cut' }, 10000, 'invalid')).rejects.toThrowError();
  });
  it('failed_audio_import_does_not_change_revision', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const { app, store } = await temporaryApp(project); const request = multipartAudio(Buffer.from('bad'), 0);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.projectId}/audio/${sfxCue(project).id}/asset`, ...request });
    expect(response.statusCode).toBe(400); expect((await store.read(project.projectId)).revision).toBe(0); await app.close();
  });
  it('failed_audio_import_leaves_no_orphan_file', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const { app, root } = await temporaryApp(project); const request = multipartAudio(Buffer.from('bad'), 0);
    await app.inject({ method: 'POST', url: `/api/projects/${project.projectId}/audio/${sfxCue(project).id}/asset`, ...request });
    expect(await readdir(join(root, 'data', sha256Text(project.projectId), 'assets'))).toHaveLength(0); await app.close();
  });
  it('audio_asset_import_requires_expected_revision', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const { app } = await temporaryApp(project); const request = multipartAudio(pcmWav(500, 48000, 1, 16), null);
    const response = await app.inject({ method: 'POST', url: `/api/projects/${project.projectId}/audio/${sfxCue(project).id}/asset`, ...request });
    expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('MISSING_EXPECTED_REVISION'); await app.close();
  });
});

describe('C. SAFE AUDIO OUTPUT', (): void => {
  async function storedAudio(): Promise<{ app: FastifyInstance; store: ProjectStore; project: Project; cue: AudioCue; bytes: Buffer; path: string }> {
    const base: Project = await nativeOutline(); const cue: AudioCue = sfxCue(base); const { app, store } = await temporaryApp(base); const mutation = await attach(base, cue, 500, 'safe-audio');
    const project: Project = await saveMutation(store, base, mutation); return { app, store, project, cue, bytes: mutation.content as Buffer, path: await store.assetPath(base.projectId, 'safe-audio') };
  }
  it('safe_audio_endpoint_returns_actual_bytes', async (): Promise<void> => {
    const fixture = await storedAudio(); const response = await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/audio/${fixture.cue.id}` });
    expect(response.rawPayload.equals(fixture.bytes)).toBe(true); await fixture.app.close();
  });
  it('safe_audio_endpoint_uses_no_store_cache', async (): Promise<void> => {
    const fixture = await storedAudio(); const response = await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/audio/${fixture.cue.id}` });
    expect(response.headers['cache-control']).toBe('no-store'); await fixture.app.close();
  });
  it('proposed_audio_is_not_returned', async (): Promise<void> => {
    const fixture = await storedAudio(); await fixture.store.update(fixture.project.projectId, 1, (project: Project): Project => ({ ...project,
      audioCues: project.audioCues.map((cue: AudioCue): AudioCue => cue.id === fixture.cue.id ? { ...cue, timingStatus: 'proposed' } : cue) }), []);
    expect((await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/audio/${fixture.cue.id}` })).statusCode).toBe(400); await fixture.app.close();
  });
  it('gate_blocked_audio_is_not_returned', async (): Promise<void> => {
    const gated = await lateGateAudioProject('gate-blocked'); const { app, store } = await temporaryApp(gated.project);
    await store.update(gated.project.projectId, 0, (project: Project): Project => project, [{ relativePath: gated.asset.path, content: gated.bytes }]);
    expect((await app.inject({ method: 'GET', url: `/api/projects/${gated.project.projectId}/output/audio/${gated.cue.id}` })).statusCode).toBe(400); await app.close();
  });
  it('missing_audio_file_is_blocked', async (): Promise<void> => {
    const fixture = await storedAudio(); await unlink(fixture.path);
    expect((await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/audio/${fixture.cue.id}` })).statusCode).not.toBe(200); await fixture.app.close();
  });
  it('audio_hash_mismatch_is_blocked', async (): Promise<void> => {
    const fixture = await storedAudio(); await writeFile(fixture.path, pcmWav(500, 48000, 1, 16).fill(1, 44));
    expect((await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/audio/${fixture.cue.id}` })).statusCode).not.toBe(200); await fixture.app.close();
  });
  it('corrupt_audio_file_is_blocked', async (): Promise<void> => {
    const fixture = await storedAudio(); const corrupt: Buffer = Buffer.from('RIFF-corrupt'); await writeFile(fixture.path, corrupt);
    await fixture.store.update(fixture.project.projectId, 1, (project: Project): Project => ({ ...project, assets: project.assets.map((asset: Asset): Asset => asset.id === 'safe-audio' ? { ...asset, sha256: sha256Bytes(corrupt) } : asset) }), []);
    expect((await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/audio/${fixture.cue.id}` })).statusCode).not.toBe(200); await fixture.app.close();
  });
  it('raw_review_asset_does_not_replace_safe_output_policy', async (): Promise<void> => {
    const fixture = await storedAudio(); await fixture.store.update(fixture.project.projectId, 1, (project: Project): Project => ({ ...project,
      audioCues: project.audioCues.map((cue: AudioCue): AudioCue => cue.id === fixture.cue.id ? { ...cue, timingStatus: 'proposed' } : cue) }), []);
    const raw = await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/assets/safe-audio` });
    const safe = await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/audio/${fixture.cue.id}` });
    expect(raw.statusCode).toBe(200); expect(safe.statusCode).toBe(400); await fixture.app.close();
  });
});

describe('D. PRJ-007 UNIT-045', (): void => {
  it('unit045_actual_wav_is_48000hz', async (): Promise<void> => {
    const fixture = await unit045Mutation(); expect(fixture.mutation.inspection.sampleRate).toBe(48000);
  });
  it('unit045_actual_wav_is_2000ms', async (): Promise<void> => {
    const fixture = await unit045Mutation(); expect(fixture.mutation.inspection.durationMs).toBe(2000);
  });
  it('unit045_asset_is_stored_in_project_store', async (): Promise<void> => {
    const fixture = await unit045Mutation(); const { store } = await temporaryStore(fixture.prepared); await saveMutation(store, fixture.prepared, fixture.mutation);
    expect((await store.asset('PRJ-007', 'unit045-audio')).content.equals(fixture.bytes)).toBe(true);
  });
  it('unit045_j_cut_is_playable_at_849500ms', async (): Promise<void> => {
    const fixture = await unit045Mutation(); expect(playableAudioCuesAt(fixture.mutation.project, 849500).some((cue: AudioCue): boolean => cue.unitId === 'UNIT-045')).toBe(true);
  });
  it('unit045_safe_audio_endpoint_returns_wav', async (): Promise<void> => {
    const fixture = await unit045Mutation(); const { app, store } = await temporaryApp(fixture.prepared); await saveMutation(store, fixture.prepared, fixture.mutation);
    const response = await app.inject({ method: 'GET', url: `/api/projects/PRJ-007/output/audio/${fixture.cue.id}` }); expect(response.rawPayload.subarray(0, 4).toString('ascii')).toBe('RIFF'); await app.close();
  });
  it('unit045_j_cut_does_not_change_information_gates', async (): Promise<void> => {
    const fixture = await unit045Mutation(); expect(fixture.mutation.project.dataset.informationRules).toEqual(fixture.base.dataset.informationRules);
  });
  it('unit045_json_round_trip_preserves_asset_and_relation', async (): Promise<void> => {
    const fixture = await unit045Mutation(); const reopened: Project = parseProject(JSON.parse(exportProjectJson(fixture.mutation.project)));
    expect(reopened.audioCues.find((cue: AudioCue): boolean => cue.unitId === 'UNIT-045')).toEqual(expect.objectContaining({ assetId: 'unit045-audio', timingRelation: 'j-cut' }));
  });
  it('unit045_within_segment_relation_is_rejected_for_cross_boundary_timing', async (): Promise<void> => {
    const fixture = await unit045Mutation(); const invalid: Project = { ...fixture.prepared, audioCues: fixture.prepared.audioCues.map((cue: AudioCue): AudioCue => cue.unitId === 'UNIT-045' ? { ...cue, timingRelation: 'within-segment' } : cue) };
    await expect(attachAudioAsset(invalid, fixture.cue.id, 'invalid-unit045', { originalFileName: 'unit045.wav', declaredMimeType: 'audio/wav', bytes: fixture.bytes }, testAudioNormalizer())).rejects.toThrowError();
  });
});

describe('E. PLACEMENT INFORMATION', (): void => {
  it('standalone_placement_requires_information_decision', async (): Promise<void> => {
    const project: Project = standalone(await nativeOutline()); const invalid: Project = { ...project, textPlacementInformationDecisions: [] };
    expect(validateProject(invalid, invalid.dataset).map((issue): string => issue.code)).toContain('PLACEMENT_INFORMATION_DECISION_COVERAGE');
  });
  it('unresolved_standalone_placement_is_not_playable', async (): Promise<void> => {
    const project: Project = standalone(await nativeOutline()); const fixture = placementFixture(project);
    expect(playableTextCuesAt(project, fixture.placement.startMs).map((cue: TextCue): string => cue.id)).not.toContain(fixture.cue.id);
  });
  it('standalone_can_be_marked_non_informational', async (): Promise<void> => {
    const project: Project = standalone(await nativeOutline()); const fixture = placementFixture(project);
    const changed: Project = updatePlacementInformationDecision(project, fixture.placement.id, { status: 'non-informational', informationIds: [], note: null });
    expect(playableTextCuesAt(changed, fixture.placement.startMs).map((cue: TextCue): string => cue.id)).toContain(fixture.cue.id);
  });
  it('standalone_can_link_information_ids', async (): Promise<void> => {
    const base: Project = standalone(await nativeOutline()); const fixture = placementFixture(base); const project: Project = withInformationRule(base, fixture, fixture.placement.startMs);
    expect(updatePlacementInformationDecision(project, fixture.placement.id, { status: 'informational', informationIds: ['PLACEMENT-INFO'], note: null }).textPlacementInformationDecisions[0]?.informationIds).toEqual(['PLACEMENT-INFO']);
  });
  it('informational_standalone_respects_gate', async (): Promise<void> => {
    const base: Project = standalone(await nativeOutline()); const fixture = placementFixture(base); const project: Project = withInformationRule(base, fixture, fixture.placement.startMs + 1);
    const changed: Project = updatePlacementInformationDecision(project, fixture.placement.id, { status: 'informational', informationIds: ['PLACEMENT-INFO'], note: null });
    expect(reviewTextPlaybackAt(changed, fixture.placement.startMs).blocked.find((entry): boolean => entry.cueId === fixture.cue.id)?.issues.map((issue): string => issue.code)).toContain('EARLY_INFORMATION_EMISSION');
  });
  it('separate_element_placement_requires_independent_decision', async (): Promise<void> => {
    const project: Project = separate(await nativeOutline()); expect(project.textPlacementInformationDecisions).toHaveLength(1);
  });
  it('separate_element_canonical_cue_keeps_canonical_information', async (): Promise<void> => {
    const base: Project = await nativeOutline(); const fixture = placementFixture(base); const informed: Project = withInformationRule(base, fixture, fixture.placement.startMs);
    const project: Project = separate(informed); const canonical: TextCue = project.textCues.find((cue: TextCue): boolean => cue.mappingDecisionId === fixture.decision.id) as TextCue;
    expect(textCueInformationIds(project, canonical)).toEqual(['PLACEMENT-INFO']);
  });
  it('separate_element_placement_does_not_inherit_canonical_information', async (): Promise<void> => {
    const base: Project = await nativeOutline(); const fixture = placementFixture(base); const project: Project = separate(withInformationRule(base, fixture, fixture.placement.startMs));
    const reviewed: Project = updatePlacementInformationDecision(project, fixture.placement.id, { status: 'non-informational', informationIds: [], note: null });
    expect(textCueInformationIds(reviewed, reviewed.textCues.find((cue: TextCue): boolean => cue.placementId === fixture.placement.id) as TextCue)).toEqual([]);
  });
  it('invalid_information_id_is_rejected', async (): Promise<void> => {
    const project: Project = standalone(await nativeOutline()); const fixture = placementFixture(project);
    expect(() => updatePlacementInformationDecision(project, fixture.placement.id, { status: 'informational', informationIds: ['UNKNOWN'], note: null })).toThrowError(expect.objectContaining({ code: 'INVALID_PLACEMENT_INFORMATION_ID' }));
  });
  it('duplicate_placement_information_decision_is_rejected', async (): Promise<void> => {
    const project: Project = standalone(await nativeOutline()); const existing: TextPlacementInformationDecision = project.textPlacementInformationDecisions[0] as TextPlacementInformationDecision;
    const invalid: Project = { ...project, textPlacementInformationDecisions: [...project.textPlacementInformationDecisions, { ...existing, id: `${existing.id}:duplicate` }] };
    expect(validateProject(invalid, invalid.dataset).map((issue): string => issue.code)).toContain('PLACEMENT_INFORMATION_DECISION_COVERAGE');
  });
  it('canonical_relation_does_not_use_independent_decision', async (): Promise<void> => {
    const project: Project = await nativeOutline(); expect(project.textPlacementInformationDecisions).toEqual([]);
  });
  it('changing_to_independent_relation_creates_unresolved_decision', async (): Promise<void> => {
    const project: Project = standalone(await nativeOutline()); expect(project.textPlacementInformationDecisions[0]?.status).toBe('unresolved');
  });
  it('changing_to_canonical_relation_removes_independent_decision', async (): Promise<void> => {
    const base: Project = await nativeOutline(); const fixture = placementFixture(base); const independent: Project = standalone(base);
    const canonical: Project = updateTextMappingDecision(independent, fixture.decision.id, { canonicalUnitId: fixture.unit.id, relation: 'exact', status: 'confirmed', renderCanonicalSeparately: false, canonicalStartMs: null, canonicalEndMs: null, note: null });
    expect(canonical.textPlacementInformationDecisions).toEqual([]);
  });
  it('placement_information_round_trip_is_preserved', async (): Promise<void> => {
    const base: Project = standalone(await nativeOutline()); const fixture = placementFixture(base); const changed = updatePlacementInformationDecision(base, fixture.placement.id, { status: 'non-informational', informationIds: [], note: '검토' });
    expect(parseProject(JSON.parse(exportProjectJson(changed))).textPlacementInformationDecisions).toEqual(changed.textPlacementInformationDecisions);
  });
});

describe('F. TEXT AUTHORITY HARDENING', (): void => {
  it('screen_text_can_resolve_to_overlay', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const unit: SourceUnit = project.dataset.units.find((value: SourceUnit): boolean => value.kind === 'SCREEN_TEXT') as SourceUnit; const cue = reviewCue(unit, 'screen-review');
    expect(resolveTextCueAuthority({ ...project, textCues: [...project.textCues, cue] }, cue.id, { authority: 'source-unit', unitId: unit.id, startMs: 0, endMs: 500, kind: 'overlay' }).textCues.at(-1)?.kind).toBe('overlay');
  });
  it('dialogue_can_resolve_to_dialogue_subtitle', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const unit: SourceUnit = project.dataset.units.find((value: SourceUnit): boolean => value.kind === 'NARRATION') as SourceUnit; const cue = reviewCue(unit, 'dialogue-review');
    expect(resolveTextCueAuthority({ ...project, textCues: [...project.textCues, cue] }, cue.id, { authority: 'source-unit', unitId: unit.id, startMs: 5000, endMs: 5500, kind: 'dialogue-subtitle' }).textCues.at(-1)?.kind).toBe('dialogue-subtitle');
  });
  it('action_cannot_resolve_to_text_cue', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const unit: SourceUnit = project.dataset.units.find((value: SourceUnit): boolean => value.kind === 'ACTION') as SourceUnit; const cue = reviewCue(unit, 'action-review');
    expect(() => resolveTextCueAuthority({ ...project, textCues: [...project.textCues, cue] }, cue.id, { authority: 'source-unit', unitId: unit.id, startMs: 0, endMs: 500, kind: 'overlay' })).toThrowError(expect.objectContaining({ code: 'SOURCE_UNIT_NOT_TEXTUAL' }));
  });
  it('sound_cannot_resolve_to_text_cue', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const unit: SourceUnit = project.dataset.units.find((value: SourceUnit): boolean => value.kind === 'SOUND') as SourceUnit; const cue = reviewCue(unit, 'sound-review');
    expect(() => resolveTextCueAuthority({ ...project, textCues: [...project.textCues, cue] }, cue.id, { authority: 'source-unit', unitId: unit.id, startMs: 5000, endMs: 5500, kind: 'overlay' })).toThrowError(expect.objectContaining({ code: 'SOURCE_UNIT_NOT_TEXTUAL' }));
  });
  it('music_cannot_resolve_to_text_cue', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const sound: SourceUnit = project.dataset.units.find((value: SourceUnit): boolean => value.kind === 'SOUND') as SourceUnit; const unit: SourceUnit = { ...sound, kind: 'MUSIC' };
    const changed: Project = { ...project, dataset: { ...project.dataset, units: project.dataset.units.map((value: SourceUnit): SourceUnit => value.id === unit.id ? unit : value) } }; const cue = reviewCue(unit, 'music-review');
    expect(() => resolveTextCueAuthority({ ...changed, textCues: [...changed.textCues, cue] }, cue.id, { authority: 'source-unit', unitId: unit.id, startMs: 5000, endMs: 5500, kind: 'overlay' })).toThrowError(expect.objectContaining({ code: 'SOURCE_UNIT_NOT_TEXTUAL' }));
  });
  it('incompatible_text_kind_is_rejected', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const unit: SourceUnit = project.dataset.units.find((value: SourceUnit): boolean => value.kind === 'SCREEN_TEXT') as SourceUnit; const cue = reviewCue(unit, 'kind-review');
    expect(() => resolveTextCueAuthority({ ...project, textCues: [...project.textCues, cue] }, cue.id, { authority: 'source-unit', unitId: unit.id, startMs: 0, endMs: 500, kind: 'dialogue-subtitle' })).toThrowError(expect.objectContaining({ code: 'INCOMPATIBLE_TEXT_KIND' }));
  });
  it('duplicate_source_unit_text_cue_is_rejected', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const unit: SourceUnit = project.dataset.units.find((value: SourceUnit): boolean => value.kind === 'SCREEN_TEXT') as SourceUnit;
    const first = reviewCue(unit, 'source-first'); const once = resolveTextCueAuthority({ ...project, textCues: [...project.textCues, first] }, first.id, { authority: 'source-unit', unitId: unit.id, startMs: 0, endMs: 500, kind: 'overlay' }); const second = reviewCue(unit, 'source-second');
    expect(() => resolveTextCueAuthority({ ...once, textCues: [...once.textCues, second] }, second.id, { authority: 'source-unit', unitId: unit.id, startMs: 500, endMs: 1000, kind: 'overlay' })).toThrowError(expect.objectContaining({ code: 'DUPLICATE_SOURCE_UNIT_TEXT_CUE' }));
  });
  it('placement_timing_is_read_only_in_ui_contract', async (): Promise<void> => {
    const source: string = await readFile('web/src/App.tsx', 'utf8'); expect(source).toContain('disabled={props.cue.placementId !== null || derived}');
  });
});

describe('G. IMAGE INTEGRITY', (): void => {
  it('truncated_png_signature_is_rejected', async (): Promise<void> => {
    await expect(inspectImageBytes(Buffer.from('89504e470d0a1a0a', 'hex'), 'image/png')).rejects.toEqual(expect.objectContaining({ code: 'ASSET_CONTENT_CORRUPT' }));
  });
  it('corrupted_jpeg_is_rejected', async (): Promise<void> => {
    await expect(inspectImageBytes(Buffer.from('ffd8ff000102', 'hex'), 'image/jpeg')).rejects.toEqual(expect.objectContaining({ code: 'ASSET_CONTENT_CORRUPT' }));
  });
  it('image_decode_reports_dimensions', async (): Promise<void> => {
    expect(await inspectImageBytes(await png(7, 9), 'image/png')).toEqual(expect.objectContaining({ width: 7, height: 9 }));
  });
  it('excessive_image_dimensions_are_rejected', async (): Promise<void> => {
    const bytes: Buffer = await png(1, 1); bytes.writeUInt32BE(50000, 16); bytes.writeUInt32BE(50000, 20);
    await expect(inspectImageBytes(bytes, 'image/png')).rejects.toBeTruthy();
  });
  it('stored_image_hash_mismatch_blocks_safe_output', async (): Promise<void> => {
    const fixture = await acceptedImageStore(); await writeFile(fixture.path, await png(3, 2));
    expect((await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/frame/${fixture.frame.id}` })).statusCode).not.toBe(200); await fixture.app.close();
  });
  it('missing_image_file_blocks_safe_output', async (): Promise<void> => {
    const fixture = await acceptedImageStore(); await unlink(fixture.path);
    expect((await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/frame/${fixture.frame.id}` })).statusCode).not.toBe(200); await fixture.app.close();
  });
  it('corrupt_image_is_omitted_from_pdf', async (): Promise<void> => {
    const base: Project = await nativeOutline(); const frame: StoryboardFrame = base.frames[0] as StoryboardFrame; const asset: Asset = { id: 'pdf-corrupt', kind: 'image', subjectId: frame.id, path: 'assets/corrupt.png', mimeType: 'image/png', sha256: '1'.repeat(64), description: '', durationMs: null, version: 1 };
    const project: Project = { ...base, assets: [asset], frames: base.frames.map((value: StoryboardFrame): StoryboardFrame => value.id === frame.id ? { ...value, imageAssetId: asset.id, visualReview: 'accepted' } : value) };
    expect((await exportProjectPdf(project, resolve('assets/fonts/NanumGothic-Regular.ttf'), async (): Promise<Buffer> => { throw contractError('ASSET_CONTENT_CORRUPT', '손상', []); })).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  });
  it('corrupt_image_uses_pdf_placeholder', async (): Promise<void> => {
    const base: Project = await nativeOutline(); const frame: StoryboardFrame = base.frames[0] as StoryboardFrame; const asset: Asset = { id: 'pdf-placeholder', kind: 'image', subjectId: frame.id, path: 'assets/corrupt.png', mimeType: 'image/png', sha256: '1'.repeat(64), description: '', durationMs: null, version: 1 };
    const project: Project = { ...base, assets: [asset], frames: base.frames.map((value: StoryboardFrame): StoryboardFrame => value.id === frame.id ? { ...value, imageAssetId: asset.id, visualReview: 'accepted' } : value) };
    const pdf: Buffer = await exportProjectPdf(project, resolve('assets/fonts/NanumGothic-Regular.ttf'), async (): Promise<Buffer> => { throw contractError('ASSET_HASH_MISMATCH', '손상', []); }); expect(pdf.length).toBeGreaterThan(1000);
  });
  it('safe_frame_endpoint_returns_valid_image', async (): Promise<void> => {
    const fixture = await acceptedImageStore(); const response = await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/frame/${fixture.frame.id}` });
    expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toContain('image/png'); await fixture.app.close();
  });
  it('safe_frame_endpoint_uses_no_store_cache', async (): Promise<void> => {
    const fixture = await acceptedImageStore(); const response = await fixture.app.inject({ method: 'GET', url: `/api/projects/${fixture.project.projectId}/output/frame/${fixture.frame.id}` });
    expect(response.headers['cache-control']).toBe('no-store'); await fixture.app.close();
  });
});

describe('H. SOURCE UPDATE', (): void => {
  it('unchanged_placement_information_decision_is_preserved', async (): Promise<void> => {
    const current: Project = standalone(await nativeOutline()); const fixture = placementFixture(current); const reviewed = updatePlacementInformationDecision(current, fixture.placement.id, { status: 'non-informational', informationIds: [], note: '유지' });
    expect(mergePlacementInformationDecisions(reviewed, reviewed, reviewed.textMappingDecisions)[0]?.note).toBe('유지');
  });
  it('changed_placement_information_decision_becomes_unresolved', async (): Promise<void> => {
    const current: Project = standalone(await nativeOutline()); const fixture = placementFixture(current); const reviewed = updatePlacementInformationDecision(current, fixture.placement.id, { status: 'non-informational', informationIds: [], note: '이전' });
    const incoming: Project = { ...reviewed, dataset: { ...reviewed.dataset, textPlacements: reviewed.dataset.textPlacements.map((placement: TextPlacement): TextPlacement => placement.id === fixture.placement.id ? { ...placement, text: `${placement.text} 변경` } : placement) } };
    expect(mergePlacementInformationDecisions(reviewed, incoming, reviewed.textMappingDecisions)[0]?.status).toBe('unresolved');
  });
  it('deleted_placement_removes_information_decision', async (): Promise<void> => {
    const current: Project = standalone(await nativeOutline()); expect(mergePlacementInformationDecisions(current, current, [])).toEqual([]);
  });
  it('new_independent_placement_gets_unresolved_decision', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const fixture = placementFixture(project); const mapping: TextMappingDecision = { ...fixture.decision, canonicalUnitId: null, relation: 'standalone-placement' };
    expect(mergePlacementInformationDecisions(project, project, [mapping])[0]?.status).toBe('unresolved');
  });
  it('preserved_mapping_rebuilds_text_derived_anchor', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const shot: Shot = project.shots.find((value: Shot): boolean => value.sourceLinks.some((link: ShotSourceLink): boolean => link.temporalAnchor.kind === 'shot-offset' && link.temporalAnchor.basis === 'text-cue')) as Shot;
    const link: ShotSourceLink = shot.sourceLinks.find((value: ShotSourceLink): boolean => value.temporalAnchor.kind === 'shot-offset' && value.temporalAnchor.basis === 'text-cue') as ShotSourceLink;
    const cue: TextCue = project.textCues.find((value: TextCue): boolean => value.unitId === link.unitId) as TextCue; const shifted: Project = { ...project, textCues: project.textCues.map((value: TextCue): TextCue => value.id === cue.id ? { ...value, startMs: value.startMs + 1 } : value) };
    const rebuilt: Shot = rebuildTextDerivedAnchors(shifted).find((value: Shot): boolean => value.id === shot.id) as Shot; expect((rebuilt.sourceLinks.find((value: ShotSourceLink): boolean => value.unitId === link.unitId)?.temporalAnchor as { startOffsetMs: number }).startOffsetMs).toBe(1);
  });
  it('incompatible_text_anchor_becomes_review_required', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const shot: Shot = project.shots.find((value: Shot): boolean => value.sourceLinks.some((link: ShotSourceLink): boolean => link.temporalAnchor.kind === 'shot-offset' && link.temporalAnchor.basis === 'text-cue')) as Shot;
    const link: ShotSourceLink = shot.sourceLinks.find((value: ShotSourceLink): boolean => value.temporalAnchor.kind === 'shot-offset' && value.temporalAnchor.basis === 'text-cue') as ShotSourceLink;
    const changed: Project = { ...project, textCues: project.textCues.filter((cue: TextCue): boolean => cue.unitId !== link.unitId) }; const rebuilt: Shot = rebuildTextDerivedAnchors(changed).find((value: Shot): boolean => value.id === shot.id) as Shot;
    expect(rebuilt.sourceLinks.find((value: ShotSourceLink): boolean => value.unitId === link.unitId)?.temporalAnchor.status).toBe('review-required');
  });
  it('multiple_text_cues_for_one_unit_become_review_required', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const shot: Shot = project.shots.find((value: Shot): boolean => value.sourceLinks.some((link: ShotSourceLink): boolean => link.temporalAnchor.kind === 'shot-offset' && link.temporalAnchor.basis === 'text-cue')) as Shot;
    const link: ShotSourceLink = shot.sourceLinks.find((value: ShotSourceLink): boolean => value.temporalAnchor.kind === 'shot-offset' && value.temporalAnchor.basis === 'text-cue') as ShotSourceLink;
    const cue: TextCue = project.textCues.find((value: TextCue): boolean => value.unitId === link.unitId && value.startMs >= shot.startMs && value.endMs <= shot.endMs) as TextCue;
    const changed: Project = { ...project, textCues: [...project.textCues, { ...cue, id: `${cue.id}-duplicate` }] };
    const rebuilt: Shot = rebuildTextDerivedAnchors(changed).find((value: Shot): boolean => value.id === shot.id) as Shot;
    expect(rebuilt.sourceLinks.find((value: ShotSourceLink): boolean => value.unitId === link.unitId)).toEqual(expect.objectContaining({
      status: 'mapping-required', temporalAnchor: { kind: 'unresolved', basis: 'source-update', status: 'review-required' },
    }));
  });
});

describe('I. READY METRICS', (): void => {
  it('stale_frame_is_not_counted_as_output_safe', async (): Promise<void> => {
    const base: Project = await nativeOutline(); const { store } = await temporaryStore(base); const frame: StoryboardFrame = base.frames[0] as StoryboardFrame;
    const mutation = await applyGeneratedImage(base, frame.id, 'stale-metric', '2026-09-06T00:00:00.000Z', { bytes: await png(1, 1), provider: 'codex-app', prompt: '', model: '', requestId: 'request', mimeType: 'image/png', referenceHashes: [] });
    await store.update(base.projectId, 0, (): Project => mutation.project, [{ relativePath: mutation.relativePath as string, content: mutation.content as Buffer }]); expect((await store.list())[0]?.framesOutputSafe).toBe(0);
  });
  it('rejected_frame_is_not_counted_as_output_safe', async (): Promise<void> => {
    const fixture = await acceptedImageStore(); await fixture.store.update(fixture.project.projectId, 2, (project: Project): Project => ({ ...project, frames: project.frames.map((frame: StoryboardFrame): StoryboardFrame => frame.id === fixture.frame.id ? { ...frame, visualReview: 'rejected' } : frame) }), []);
    expect((await fixture.store.list())[0]?.framesOutputSafe).toBe(0); await fixture.app.close();
  });
  it('proposed_audio_is_not_counted_as_playable', async (): Promise<void> => {
    const base: Project = await nativeOutline(); const { store } = await temporaryStore(base); const cue: AudioCue = sfxCue(base); const saved = await saveMutation(store, base, await attach(base, cue, 500, 'metric-proposed'));
    await store.update(base.projectId, saved.revision, (project: Project): Project => ({ ...project, audioCues: project.audioCues.map((value: AudioCue): AudioCue => value.id === cue.id ? { ...value, timingStatus: 'proposed' } : value) }), []); expect((await store.list())[0]?.audioPlayable).toBe(0);
  });
  it('gate_blocked_audio_is_not_counted_as_playable', async (): Promise<void> => {
    const gated = await lateGateAudioProject('metric-gate'); const { store } = await temporaryStore(gated.project);
    await store.update(gated.project.projectId, 0, (project: Project): Project => project, [{ relativePath: gated.asset.path, content: gated.bytes }]);
    expect((await store.list())[0]?.audioPlayable).toBe(0);
  });
  it('valid_measured_audio_is_counted_as_playable', async (): Promise<void> => {
    const base: Project = await nativeOutline(); const { store } = await temporaryStore(base); const cue: AudioCue = sfxCue(base); await saveMutation(store, base, await attach(base, cue, 500, 'metric-valid'));
    expect((await store.list())[0]?.audioPlayable).toBe(1);
  });
});

describe('J. MIGRATION', (): void => {
  it('migration_1_4_to_1_5_creates_unresolved_independent_decisions', async (): Promise<void> => {
    const project: Project = standalone(await nativeOutline()); expect(parseProject(legacy14(project)).textPlacementInformationDecisions[0]?.status).toBe('unresolved');
  });
  it('migration_does_not_create_decision_for_canonical_relations', async (): Promise<void> => {
    expect(parseProject(legacy14(await nativeOutline())).textPlacementInformationDecisions).toEqual([]);
  });
  it('migration_preserves_source_snapshot', async (): Promise<void> => {
    const project: Project = await nativeOutline(); expect(parseProject(legacy14(project)).sources).toEqual(project.sources);
  });
  it('migration_preserves_original_text', async (): Promise<void> => {
    const project: Project = await nativeOutline(); expect(parseProject(legacy14(project)).dataset.units.map((unit: SourceUnit): string => unit.text)).toEqual(project.dataset.units.map((unit: SourceUnit): string => unit.text));
  });
  it('migration_preserves_timeline', async (): Promise<void> => {
    const project: Project = await nativeOutline(); expect(parseProject(legacy14(project)).dataset.segments).toEqual(project.dataset.segments);
  });
  it('migration_preserves_assets', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const asset: Asset = { id: 'legacy-asset', kind: 'prop', subjectId: null, path: 'assets/a.png', mimeType: 'image/png', sha256: sha256Text('asset'), description: '', durationMs: null, version: 1 };
    expect(parseProject(legacy14({ ...project, assets: [asset] })).assets).toEqual([asset]);
  });
  it('migration_preserves_generation_records', async (): Promise<void> => {
    const project: Project = await nativeOutline(); const asset: Asset = { id: 'generated-asset', kind: 'prop', subjectId: null, path: 'assets/a.png', mimeType: 'image/png', sha256: sha256Text('asset'), description: '', durationMs: null, version: 1 };
    const record: GenerationRecord = { id: 'legacy-generation', provider: 'codex-app', model: 'model', modelVersion: null, requestId: null, prompt: '', templateVersion: '1.0.0', seed: null, referenceHashes: [], resultAssetIds: [asset.id], shotIds: [], createdAt: '2026-09-06T00:00:00.000Z' };
    expect(parseProject(legacy14({ ...project, assets: [asset], generationRecords: [record] })).generationRecords).toEqual([record]);
  });
});
