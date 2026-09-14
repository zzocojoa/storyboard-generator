import { assertSpeechPronunciation } from '../codex/speech-pronunciation.js';
import { speechReadingText } from '../domain/speech-pronunciation.js';
import { audioTimingContext, audioTimingIssues } from '../domain/audio.js';
import { speechRetakeProtected } from '../domain/edit-protection.js';
import { contractError } from '../domain/errors.js';
import { assertGenerationRecordTransition } from '../domain/generation-records.js';
import { reviewIssuesForFrame } from '../domain/mapping.js';
import { ProjectSchema } from '../domain/schema.js';
import type { AudioCue, GenerationRecord, Issue, Project } from '../domain/schema.js';
import { validateProject } from '../domain/validation.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { automaticHash } from './application-evidence.js';
import { attachStagedSpeech, existingAudioEvidence } from './plan-audio.js';
import type { ExistingAudioFile, StagedSpeech } from './plan-audio.js';
import type { AutomaticPlanProvenance } from './plan-compiler.js';
import { automaticEmissionIssues } from './plan-validation.js';
import { SpeechRetakeInputSchema, SpeechRetakeIntentSchema } from './speech-retake-schema.js';
import type { SpeechRetakeInput, SpeechRetakeIntent } from './speech-retake-schema.js';
import type { AutomaticTaskCandidate } from './task-executor.js';

/** 시작 시각과 원문을 고정하고 선택한 한 발화의 교체 권한을 기록한다. */
export function createSpeechRetakeIntent(project: Project, raw: SpeechRetakeInput): SpeechRetakeIntent {
  const input = SpeechRetakeInputSchema.parse(raw);
  const cue = project.audioCues.find((value): boolean => value.id === input.cueId);
  if (cue === undefined || !['dialogue', 'voiceover', 'panel'].includes(cue.kind)) throw contractError('AUTOMATION_RETAKE_TARGET', `${input.cueId}: 대사·내레이션·패널 발화를 선택하세요. 효과음·음악·화면 글자는 낭독하지 않습니다.`, []);
  const context = audioTimingContext(project, cue);
  if (context === null) throw contractError('AUDIO_SOURCE_CONTEXT_MISSING', `${cue.id}: 원문·구간을 찾을 수 없습니다.`, []);
  speechReadingText(context.unit.text, input.pronunciation);
  const timingIssues = audioTimingIssues(project, { ...cue, endMs: input.latestEndMs });
  if (timingIssues.length > 0) throw contractError('AUTOMATION_RETAKE_WINDOW', `${cue.id}: 종료 허용 시각을 현재 시작 시각·구간 관계 안에서 지정하세요.`, timingIssues);
  if (speechRetakeProtected(project, cue)) throw contractError('AUTOMATION_RETAKE_PROTECTED', `${cue.id}: 확정·잠금 컷과 연결된 발화입니다. 해당 컷을 잠금 해제하여 검토 대기로 변경한 뒤 다시 생성하세요.`, []);
  return { ...input, kind: 'speech-retake', previousAssetId: cue.assetId, sourceHash: automaticHash({ projectId: project.projectId, cue, unit: context.unit }) };
}

export function assertSpeechRetakeIntent(project: Project, raw: SpeechRetakeIntent): AudioCue {
  const intent = SpeechRetakeIntentSchema.parse(raw);
  const current = createSpeechRetakeIntent(project, { cueId: intent.cueId, voice: intent.voice, latestEndMs: intent.latestEndMs, ...(intent.pronunciation === undefined ? {} : { pronunciation: intent.pronunciation }) });
  if (automaticHash(current) !== automaticHash(intent)) throw contractError('AUTOMATION_RETAKE_STALE', `${intent.cueId}: 재생성을 요청한 원문·기존 음원·배치가 변경되었습니다. 현재 결과에서 다시 요청하세요.`, []);
  return project.audioCues.find((cue): boolean => cue.id === intent.cueId)!;
}

function retakeIssues(project: Project): Issue[] {
  return [...validateProject(project, project.dataset), ...automaticEmissionIssues(project), ...project.frames.flatMap((frame): Issue[] => reviewIssuesForFrame(project, frame.id))];
}

/** 기존 자산·연출·공개 시각을 보존하고 실측한 새 음원만 원자 후보에 연결한다. */
export function compileSpeechRetake(project: Project, intent: SpeechRetakeIntent, speech: StagedSpeech, previousFile: ExistingAudioFile | null,
  provenance: Omit<AutomaticPlanProvenance, 'model' | 'turnId' | 'prompt'>): AutomaticTaskCandidate {
  const cue = assertSpeechRetakeIntent(project, intent);
  if ((previousFile === null) !== (cue.assetId === null) || previousFile !== null && (previousFile.cueId !== cue.id || previousFile.assetId !== cue.assetId)) throw contractError('AUTOMATION_RETAKE_PREVIOUS', `${cue.id}: 교체 전 실제 음원을 확인해야 합니다.`, []);
  const previous = previousFile === null ? null : existingAudioEvidence(project, previousFile);
  if (speech.cueId !== cue.id || automaticHash(speech.result.voice) !== automaticHash(intent.voice)) throw contractError('AUTOMATION_RETAKE_RESULT', `${cue.id}: 선택 발화·목소리와 다른 합성 결과입니다.`, []);
  const source = project.dataset.units.find((value): boolean => value.id === cue.unitId)!;
  assertSpeechPronunciation(source.text, intent.pronunciation, speech.result.pronunciation);
  const endMs: number = cue.startMs + speech.result.inspection.durationMs;
  if (!Number.isSafeInteger(endMs) || endMs > intent.latestEndMs) throw contractError('AUTOMATION_RETAKE_TOO_LONG', `${cue.id}: 새 음성 ${speech.result.inspection.durationMs}ms가 허용 길이 ${intent.latestEndMs - cue.startMs}ms를 넘었습니다. 속도 또는 종료 허용 시각을 수정하세요. 기존 음원은 유지하며 음성을 자르거나 늘이지 않습니다.`, []);
  const changed: AudioCue = { ...cue, endMs, ...(cue.mix?.mode !== 'automatic' ? {} : { mix: { ...cue.mix, plannedInputHash: null, reason: '새 음원을 듣고 음량·페이드를 다시 검토하세요.' } }) };
  if (speechRetakeProtected(project, changed)) throw contractError('AUTOMATION_RETAKE_PROTECTED', `${cue.id}: 새 음성의 재생 범위가 보호된 컷과 겹칩니다. 종료 허용 시각과 속도를 조정하세요.`, []);
  const unit = project.dataset.units.find((value): boolean => value.id === cue.unitId)!;
  const overlap = project.audioCues.find((other): boolean => other.id !== cue.id && ['dialogue', 'voiceover', 'panel'].includes(other.kind)
    && project.dataset.units.some((source): boolean => source.id === other.unitId && source.speakerId === unit.speakerId)
    && Math.max(0, Math.min(endMs, other.endMs) - Math.max(cue.startMs, other.startMs)) > Math.max(0, Math.min(cue.endMs, other.endMs) - Math.max(cue.startMs, other.startMs)));
  if (overlap !== undefined) throw contractError('AUTOMATION_RETAKE_OVERLAP', `${cue.id}: 새 음성이 같은 화자의 다음 발화 ${overlap.id}와 겹칩니다. 허용 종료를 ${overlap.startMs}ms 이하로 지정하거나 속도를 조정하세요.`, []);
  const entry = attachStagedSpeech(project, changed, speech, provenance.generationId);
  if (entry.asset === null || entry.write === null) throw contractError('AUTOMATION_RETAKE_RESULT', `${cue.id}: 실제 음성 자산과 저장 파일이 필요합니다.`, []);
  const record: GenerationRecord = { id: provenance.generationId, requestId: provenance.generationId, provider: 'macos-speech', model: `say:${intent.voice.name}`,
    modelVersion: null, templateVersion: intent.pronunciation === undefined ? 'automatic-speech-retake-1.0.0' : 'automatic-speech-retake-1.1.0', seed: null, createdAt: provenance.createdAt, generatorBuild: provenance.generatorBuild,
    prompt: stableJsonStringify({ intent, sourceText: unit.text, sourceTextHash: speech.result.sourceTextHash, voice: intent.voice, previousAudio: previous,
      ...(speech.result.pronunciation === undefined ? {} : { pronunciation: speech.result.pronunciation, spokenText: speechReadingText(unit.text, intent.pronunciation) }),
      result: speech.result.inspection, cacheEvidence: speech.result.cacheEvidence ?? null }),
    referenceHashes: [automaticHash(project), intent.sourceHash, speech.result.sourceTextHash, ...(speech.result.pronunciation === undefined ? [] : [speech.result.pronunciation.spokenTextHash]), ...(previous === null ? [] : [previous.inspection.sha256])],
    resultAssetIds: [entry.asset.id], shotIds: project.shots.filter((shot): boolean => shot.sourceLinks.some((link): boolean => link.unitId === cue.unitId)).map((shot): string => shot.id) };
  const next = ProjectSchema.parse({ ...project, audioCues: project.audioCues.map((value): AudioCue => value.id === cue.id ? entry.cue : value),
    assets: [...project.assets, entry.asset], generationRecords: [...project.generationRecords, record] });
  assertGenerationRecordTransition(project, next);
  const prior: Set<string> = new Set(retakeIssues(project).map((value): string => stableJsonStringify(value)));
  const exceptions = retakeIssues(next);
  const blocking = exceptions.filter((value): boolean => value.severity === 'error' || value.severity === 'conflict' && (value.entityId === cue.id || !prior.has(stableJsonStringify(value))));
  if (blocking.length > 0) throw contractError('AUTOMATION_RETAKE_INVALID', `${cue.id}: 새 음원의 배치·정보 공개 검사를 통과하지 못했습니다. 기존 결과를 보존했습니다.`, blocking);
  return { project: next, writes: [entry.write], exceptions };
}
