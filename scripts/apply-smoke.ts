import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { readBuildManifest } from '../src/build.js';
import { applyCodexImage, applyCodexProposal, applyCodexSpeech } from '../src/codex/apply.js';
import { readApplyEvidence } from '../src/codex/apply-evidence.js';
import { CodexRequestStore } from '../src/codex/requests.js';
import type { RequestFaultContext } from '../src/codex/requests.js';
import type { CodexRequest } from '../src/codex/schema.js';
import { codexRequestBasis } from '../src/codex/work.js';
import { WorkerAudioNormalizer } from '../src/domain/audio-normalizer.js';
import type { Project } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { createApp } from '../src/server/app.js';
import type { AppConfig } from '../src/server/config.js';
import { ProjectStore } from '../src/server/store.js';
import { controlledProcess } from '../tests/controlled-process.js';
import type { ControlledProcess } from '../tests/controlled-process.js';
import type { ApplyWorkerInput } from '../tests/apply-store-worker.js';
import { nativeData, nativePackage, pcmWav, png, TEST_AUDIO_NORMALIZATION_OPTIONS, withNativeData } from '../tests/helpers.js';

export type ApplySmokeEvidence = { requestId: string; status: string; resultRevision: number | null; currentRevision: number; recordId: string; recordRequestId: string | null; committedRevision: number; resultAssetIds: string[] };
export type ApplySmokeResult = { port: number; checks: string[]; evidence: ApplySmokeEvidence[]; killedProcessIds: number[] };
const now: string = '2026-09-09T02:00:00.000Z';
async function http(url: string, path: string, method: string, expectedStatus: number): Promise<unknown> {
  const response: Response = await fetch(`${url}${path}`, { method }); const value: unknown = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(value)); return value;
}
async function evidenceFor(request: CodexRequest, requests: CodexRequestStore, store: ProjectStore): Promise<ApplySmokeEvidence> {
  const completed: CodexRequest = await requests.read(request.id); const evidence = await readApplyEvidence(completed, store);
  assert.ok(evidence.receipt); const record = evidence.current.generationRecords.find((candidate): boolean => candidate.requestId === request.id);
  assert.ok(record); assert.equal(completed.resultRevision, evidence.receipt.committedRevision);
  return { requestId: request.id, status: completed.status, resultRevision: completed.resultRevision, currentRevision: evidence.current.revision,
    recordId: record.id, recordRequestId: record.requestId, committedRevision: evidence.receipt.committedRevision, resultAssetIds: evidence.receipt.resultAssetIds };
}

/** 임시 저장소와 실제 HTTP에서 적용·경쟁·중단·Revision 복구를 연결하고 소유 Process·App을 모두 닫는다. */
export async function runApplySmoke(root: string): Promise<ApplySmokeResult> {
  const config: AppConfig = { host: '127.0.0.1', port: 0, dataRoot: join(root, 'data'), webRoot: resolve('dist/web'),
    pdfFontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), audioNormalization: TEST_AUDIO_NORMALIZATION_OPTIONS,
    codex: { requestRoot: join(root, 'requests'), speechVoice: 'Yuna' } };
  const store: ProjectStore = new ProjectStore(config.dataRoot);
  const reached = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let pause: boolean = false;
  const requests: CodexRequestStore = new CodexRequestStore(config.codex.requestRoot, readBuildManifest(), {
    async trigger(context: RequestFaultContext): Promise<void> { if (pause && context.point === 'after-apply-intent-persisted') { pause = false; reached.resolve(); await release.promise; } },
  });
  const normalizer: WorkerAudioNormalizer = new WorkerAudioNormalizer(config.audioNormalization);
  let app: FastifyInstance | null = null; let child: ControlledProcess | null = null; let applying: Promise<Project> | null = null;
  try {
    app = await createApp(config, store, requests, normalizer); const url: string = await app.listen({ host: '127.0.0.1', port: 0 });
    let project: Project = await store.create(createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 }));
    const checks: string[] = []; const evidence: ApplySmokeEvidence[] = [];
    const segment = project.dataset.segments[0]!; const proposalPath: string = join(root, 'proposal.json');
    await writeFile(proposalPath, JSON.stringify({ shots: [{ sourceLinks: project.dataset.units.filter((unit): boolean => unit.segmentId === segment.id).map((unit) => ({ unitId: unit.id, usage: 'primary-visual' })), durationWeight: 1,
      action: '원문 행동', visualLocationId: project.dataset.scenes[0]!.storyLocationId, camera: { size: 'MS', angle: 'eye-level', move: 'static' }, presence: [], propIds: [], cameraAxis: null, screenDirection: null,
      informationIds: [], transitionOut: { kind: 'cut', durationMs: 0, note: '' }, frameDescription: '원문 프레임' }] }));
    const proposal: CodexRequest = await requests.create('proposal', project.projectId, segment.id, codexRequestBasis(project, 'proposal', segment.id), now);
    project = await applyCodexProposal(proposal.id, proposalPath, store, requests, now); checks.push('apply:proposal');
    const imagePath: string = join(root, 'result.png'); await writeFile(imagePath, await png(3, 3));
    const frameId: string = project.frames[0]!.id;
    const image: CodexRequest = await requests.create('image', project.projectId, frameId, codexRequestBasis(project, 'image', frameId), now);
    project = await applyCodexImage(image.id, imagePath, store, requests, now); checks.push('apply:image');
    const cueId: string = project.audioCues[0]!.id; const speechPath: string = join(root, 'result.wav'); await writeFile(speechPath, pcmWav(200, 48000, 1, 16));
    const speech: CodexRequest = await requests.create('speech', project.projectId, cueId, codexRequestBasis(project, 'speech', cueId), now);
    project = await applyCodexSpeech(speech.id, speechPath, 'Yuna', store, requests, now, normalizer); checks.push('apply:speech');
    assert.deepEqual(await applyCodexProposal(proposal.id, proposalPath, store, requests, now), project);
    assert.deepEqual(await applyCodexImage(image.id, imagePath, store, requests, now), project);
    assert.deepEqual(await applyCodexSpeech(speech.id, speechPath, 'Yuna', store, requests, now, normalizer), project); checks.push('apply:all-kinds-replay-once');
    for (const applied of [proposal, image, speech]) evidence.push(await evidenceFor(applied, requests, store));
    const superseded: CodexRequest = await requests.create('image', project.projectId, frameId, codexRequestBasis(project, 'image', frameId), now);
    await new CodexRequestStore(config.codex.requestRoot, { ...readBuildManifest(), generationContractSha256: 'e'.repeat(64) })
      .create(superseded.kind, superseded.projectId, superseded.targetId, superseded.basisHash, now);
    await assert.rejects(applyCodexImage(superseded.id, imagePath, store, requests, now), { code: 'CODEX_REQUEST_SETTLED' });
    assert.deepEqual(await store.read(project.projectId), project); checks.push('apply:supersede-first-no-result');
    const failed: CodexRequest = await requests.create('image', project.projectId, frameId, codexRequestBasis(project, 'image', frameId), now);
    await requests.fail(failed.id, 'SMOKE_FAILURE', '적용 전 실패', now);
    await assert.rejects(applyCodexImage(failed.id, imagePath, store, requests, now), { code: 'CODEX_REQUEST_SETTLED' });
    assert.deepEqual(await store.read(project.projectId), project); checks.push('apply:fail-first-no-result');
    const racing: CodexRequest = await requests.create('image', project.projectId, frameId, codexRequestBasis(project, 'image', frameId), now);
    pause = true; applying = applyCodexImage(racing.id, imagePath, store, requests, now); await reached.promise;
    await assert.rejects(requests.fail(racing.id, 'FAIL', '경쟁 실패', now), { code: 'CODEX_REQUEST_APPLY_IN_PROGRESS' });
    await assert.rejects(new CodexRequestStore(config.codex.requestRoot, { ...readBuildManifest(), generationContractSha256: 'e'.repeat(64) })
      .create(racing.kind, racing.projectId, racing.targetId, racing.basisHash, now), { code: 'CODEX_REQUEST_APPLY_IN_PROGRESS' });
    const activeStatus = await http(url, `/api/codex/requests/${racing.id}/apply-status`, 'GET', 200) as { apply: { state: string } }; assert.equal(activeStatus.apply.state, 'applying');
    release.resolve(); project = await applying; applying = null; checks.push('apply:claim-first-rejects-fail-and-supersede');
    evidence.push(await evidenceFor(racing, requests, store));
    const crashing: CodexRequest = await requests.create('image', project.projectId, frameId, codexRequestBasis(project, 'image', frameId), now);
    child = controlledProcess('tests/apply-store-worker.ts', JSON.stringify({ root, requestId: crashing.id, action: 'apply', point: 'before-request-completion' } satisfies ApplyWorkerInput));
    await child.event('ready'); child.send('start'); await child.event('paused');
    const killedPid: number | undefined = child.child.pid; assert.ok(killedPid);
    await child.stop(); child = null; checks.push('apply:process-killed-after-commit');
    const committed: Project = await store.read(project.projectId);
    const waiting = await http(url, `/api/codex/requests/${crashing.id}/apply-status`, 'GET', 200) as { apply: { state: string; committedRevision: number } };
    assert.equal(waiting.apply.state, 'committed-awaiting-request-settlement'); assert.equal(waiting.apply.committedRevision, committed.revision);
    const later: Project = await store.update(project.projectId, committed.revision, (current: Project): Project => ({ ...current, title: '중단 뒤 사용자 편집' }), []); checks.push('apply:later-revision-preserved');
    await unlink(imagePath);
    await http(url, `/api/codex/requests/${crashing.id}/reconcile`, 'POST', 200);
    assert.equal((await requests.read(crashing.id)).resultRevision, committed.revision); assert.deepEqual(await store.read(project.projectId), later);
    assert.deepEqual(await applyCodexImage(crashing.id, imagePath, store, requests, now), later); checks.push('apply:original-revision-recovered-without-input', 'apply:lost-response-replay');
    evidence.push(await evidenceFor(crashing, requests, store));
    const requestPath: string = join(config.codex.requestRoot, `${crashing.id}.json`); const originalBytes: Buffer = await readFile(requestPath);
    const completed: CodexRequest = await requests.read(crashing.id);
    await writeFile(requestPath, JSON.stringify({ ...completed, applyIntent: { ...completed.applyIntent, resultProjectSha256: '0'.repeat(64) } }));
    const conflict = await http(url, `/api/codex/requests/${crashing.id}/reconcile`, 'POST', 423) as { error: { code: string; scope: string; projectId: string; resourceId: string; mutationBlocked: boolean } };
    assert.deepEqual({ code: conflict.error.code, scope: conflict.error.scope, projectId: conflict.error.projectId, resourceId: conflict.error.resourceId, mutationBlocked: conflict.error.mutationBlocked },
      { code: 'CODEX_APPLY_EVIDENCE_CONFLICT', scope: 'request', projectId: project.projectId, resourceId: crashing.id, mutationBlocked: false }); checks.push('apply:evidence-conflict-scoped-423');
    const payload = await nativePackage(); const data = nativeData(payload);
    const other: Project = await store.create(createSourceOutline(importPackage(withNativeData(payload, { ...data, projectId: 'apply-smoke-other' })), { proposedTextHoldMs: 2000 }));
    await http(url, `/api/projects/${other.projectId}`, 'GET', 200); checks.push('apply:unrelated-project-available');
    await writeFile(requestPath, originalBytes);
    await http(url, `/api/projects/${project.projectId}/final-readiness`, 'GET', 200);
    await http(url, `/api/projects/${project.projectId}/output/visual?atMs=0&channel=program-monitor`, 'GET', 409); checks.push('apply:existing-final-and-safe-output');
    assert.equal((await store.read(project.projectId)).generationRecords.length, 5); checks.push('apply:request-record-receipt-consistent');
    return { port: Number(new URL(url).port), checks, evidence, killedProcessIds: [killedPid] };
  } finally {
    release.resolve();
    try {
      if (child !== null) await child.stop();
      if (applying !== null) await applying;
    } finally {
      if (app !== null) await app.close(); else { try { await normalizer.close(); } finally { await store.close(); } }
    }
  }
}
