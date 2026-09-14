import { currentTextPresentations } from '../src/automation/text-cue-schema.js';
import { testTextTypography } from './typography-helpers.js';
import { TEST_TEXT_FONT_PATH } from './helpers.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { automaticHash } from '../src/automation/application-evidence.js';
import { AutomationApplicationStore } from '../src/automation/application-store.js';
import type { AutomaticApplicationFault } from '../src/automation/application-store.js';
import type { AutomationRunExecutionServices } from '../src/automation/run-executor.js';
import { AutomationDiskSpace, readDiskSpace } from '../src/automation/disk-space.js';
import type { AutomationRunCreated, AutomationSettings } from '../src/automation/run-schema.js';
import { AutomationRunStore } from '../src/automation/run-store.js';
import { AutomaticSpeechCache } from '../src/automation/speech-cache.js';
import type { AutomationEngines } from '../src/automation/task-executor.js';
import { inspectImageBytes } from '../src/domain/media-inspection.js';
import type { Project } from '../src/domain/schema.js';
import { ProjectStore } from '../src/server/store.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from './automatic-plan-helpers.js';

export const settings: AutomationSettings = { model: null, voice: { name: 'Yuna', rateWordsPerMinute: 180 }, productionBatchSize: 16,
  maxModelCorrections: 1, maxFramesPerSegment: 32, maxAttemptsPerJob: 2, maxImageAttempts: 4, maxJobs: 32, maxStagedBytes: 64 * 1024 * 1024, maxActiveMs: 60000 };

export function initial(project: Project): AutomationRunCreated {
  return { type: 'created', id: randomUUID(), projectId: project.projectId, revision: project.revision, projectHash: automaticHash(project), segmentIds: ['demonstration'],
    settings: structuredClone(settings), generatorBuild: { ...automaticPlanProvenance().generatorBuild, sourceTreeSha256: 'a'.repeat(64), generationContractSha256: 'b'.repeat(64), runtimeGenerationConfigSha256: 'c'.repeat(64) }, at: new Date().toISOString() };
}

export async function createExecutionHarness(fault: AutomaticApplicationFault): Promise<{
  source: Project; id: string; root: string; services: AutomationRunExecutionServices; engine: AutomationEngines;
  close: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'cutroom-executor-'));
  const projects = new ProjectStore(join(root, 'data'));
  const runs = new AutomationRunStore(join(root, 'automatic'), async (): Promise<void> => {}); await runs.initialize();
  const applications = new AutomationApplicationStore(join(root, 'automatic'), settings.maxStagedBytes, fault); await applications.initialize();
  const speechCache = new AutomaticSpeechCache(join(root, 'automatic'), async (): Promise<void> => {}); await speechCache.initialize();
  const source = await automaticPlanProject(); await projects.create(source);
  const created = initial(source); await runs.create(created, source);
  const engine: AutomationEngines = {
    model: { run: async (input) => {
      const project = await projects.read(source.projectId);
      const output = JSON.stringify(input.outputSchema).includes('"volumeDb"') ? { schemaVersion: '1.0.0', segmentId: 'demonstration', summary: '실제 음원 검토', cues: project.audioCues.filter((cue): boolean => cue.assetId !== null && cue.timingStatus === 'measured').map((cue) => ({ cueId: cue.id, volumeDb: -3, fadeInMs: 0, fadeOutMs: 0, reason: '가이드 발화를 원래 파일보다 조금 낮춰 검토합니다.' })) } : JSON.stringify(input.outputSchema).includes('"preset"') ? { schemaVersion: '1.0.0', cuePresentations: currentTextPresentations(project), textTypography: project.textTypography ?? await testTextTypography(), preset: { ...project.textLayout, fontSize: 0.045 }, reason: '문구 길이와 세로 화면비에 맞춰 글자 크기를 정했습니다.' } : JSON.stringify(input.outputSchema).includes('"resources"') ? {
        schemaVersion: '1.1.0', profile: { ...project.profile, medium: 'ai', visualStyle: '밝은 연필 콘티' }, profileReason: '시연 동작을 검토할 제작 기준',
        resources: [{ key: 'bench', kind: 'location', subjectId: 'workbench', name: '작업대', description: '밝은 나무 작업대', reason: '화분 시연 장소', sourceRefs: project.dataset.locations[0]!.sourceRefs, sourceUnitIds: [], referenceAssetId: null, propContinuity: null }],
        segments: [{ segmentId: 'demonstration', resourceKeys: ['bench'], locationResourceKey: 'bench', continuityGroup: 'plant', entryState: '흙이 보이는 화분', exitState: '물을 준 화분', reason: '동작의 연속성' }],
      } : demonstrationPlan(project);
      return { model: 'test-planner', turnId: randomUUID(), result: z.json().parse(output) };
    } },
    image: { run: async (input) => {
      const bytes = await sharp({ create: { width: input.aspectRatio.width * 10, height: input.aspectRatio.height * 10, channels: 3, background: '#698674' } }).png().toBuffer();
      return { bytes, model: 'test-image', turnId: randomUUID(), itemId: randomUUID(), revisedPrompt: null, inspection: await inspectImageBytes(bytes, 'image/png') };
    } },
    speech: { run: async () => stagedPlanSpeech(await projects.read(source.projectId)).result },
  };
  const services: AutomationRunExecutionServices = { textFontPath: TEST_TEXT_FONT_PATH, projects, runs, applications, speechCache, generatorBuild: created.generatorBuild,
    diskSpace: new AutomationDiskSpace({ project: join(root, 'data'), automation: join(root, 'automatic'), temporary: tmpdir() }, 268435456, readDiskSpace),
    engines: (): AutomationEngines => engine, onProgress: async (): Promise<void> => {}, onSpeechReady: async (): Promise<void> => {}, onWarning: async (): Promise<void> => {} };
  return { source, id: created.id, root, services, engine, close: async (): Promise<void> => { await projects.close(); await rm(root, { recursive: true, force: true }); } };
}
