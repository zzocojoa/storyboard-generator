import { z } from 'zod';
import { audioCueSource, audioInstructionMatches } from './audio-source.js';
import { audioInstructionContentIssues, audioInstructionEvidenceIssues } from './audio-instruction-evidence.js';
import { automaticAudioProtected } from './edit-protection.js';
import { assertNoErrors, contractError, issue } from './errors.js';
import { AudioInstructionDecisionSchema, AudioInstructionEvidenceSchema, IdSchema, ProjectSchema } from './schema.js';
import type { AudioCue, AudioInstructionDecision, Instruction, Issue, Project } from './schema.js';

export const AudioInstructionInputSchema = z.strictObject({
  instructionId: IdSchema, resolution: z.enum(['none', 'required']), cueIds: z.array(IdSchema), informationIds: z.array(IdSchema), reason: z.string().trim().min(1),
  sourceEvidence: z.array(AudioInstructionEvidenceSchema).max(64).optional(),
});
export type AudioInstructionInput = z.infer<typeof AudioInstructionInputSchema>;

export function audioInstructions(project: Project): Instruction[] {
  return project.dataset.instructions.filter((instruction): boolean => instruction.kind === 'music' || instruction.kind === 'ambience');
}

/** 연결과 판정이 존재할 때의 구조만 검사한다. 아직 판정하지 않은 원문은 Final 검토 항목이다. */
export function audioInstructionStructureIssues(project: Project): Issue[] {
  const decisions = project.audioInstructionDecisions ?? [];
  return decisions.flatMap((decision): Issue[] => {
    const instruction = audioInstructions(project).find((value): boolean => value.id === decision.instructionId);
    const failure = (field: string, message: string): Issue => issue('INVALID_AUDIO_INSTRUCTION', 'error', decision.instructionId, field, message, null, null, instruction?.sourceRefs ?? []);
    if (instruction === undefined) return [failure('instructionId', '연결할 환경 음향·음악 지시가 없습니다.')];
    const cues = decision.cueIds.map((id) => project.audioCues.find((cue): boolean => cue.id === id));
    return [
      ...audioInstructionEvidenceIssues(project, instruction, decision),
      ...(decisions.filter((value): boolean => value.instructionId === instruction.id).length !== 1 ? [failure('instructionId', '같은 음향 지시의 판정이 중복됩니다.')] : []),
      ...(!audioInstructionMatches(instruction, decision.sourceSnapshot) ? [failure('sourceSnapshot', '음향 지시 원문이나 출처가 변경됐습니다. 새 원문을 검토하세요.')] : []),
      ...(new Set(decision.cueIds).size !== decision.cueIds.length || new Set(decision.informationIds).size !== decision.informationIds.length ? [failure('cueIds', '음향 연결 또는 정보 ID가 중복됩니다.')] : []),
      ...(decision.resolution === 'none' && (decision.cueIds.length > 0 || decision.informationIds.length > 0) ? [failure('resolution', '명시적 음향 부재에는 음원과 정보 연결을 둘 수 없습니다.')] : []),
      ...(decision.resolution === 'required' && decision.cueIds.length === 0 ? [failure('cueIds', '필요한 음향에는 준비할 트랙 또는 기존 음향 트랙 연결이 필요합니다.')] : []),
      ...cues.flatMap((cue): Issue[] => {
        if (cue === undefined) return [failure('cueIds', '연결한 음향 트랙이 없습니다.')];
        const source = audioCueSource(project, cue);
        const kind: AudioCue['kind'] = instruction.kind === 'music' ? 'music' : 'sfx';
        return source === null || source.segmentId !== instruction.segmentId || cue.kind !== kind
          ? [failure('cueIds', '같은 구간·종류의 음향에 연결하세요. 발화를 환경 음향 대신 사용할 수 없습니다.')] : [];
      }),
      ...decision.informationIds.filter((id): boolean => !project.dataset.informationRules.some((rule): boolean => rule.id === id && rule.segmentId === instruction.segmentId)).map((): Issue => failure('informationIds', '해당 구간의 원문에 정의되지 않은 정보 ID입니다.')),
      ...(decision.origin === 'automatic' && !project.generationRecords.some((record): boolean => record.id === decision.generationId) ? [failure('generationId', '자동 음향 판정의 생성 이력이 없습니다.')] : []),
      ...(decision.origin === 'manual' && decision.generationId !== null ? [failure('generationId', '직접 입력한 판정에 자동 생성 ID를 지정할 수 없습니다.')] : []),
    ];
  });
}

export function audioInstructionOutputIssues(project: Project): Issue[] {
  return audioInstructions(project).flatMap((instruction): Issue[] => {
    const decision = (project.audioInstructionDecisions ?? []).find((value): boolean => value.instructionId === instruction.id);
    if (decision === undefined || decision.reviewStatus !== 'confirmed') return [issue('AUDIO_INSTRUCTION_REVIEW_REQUIRED', 'conflict', instruction.id, 'audioInstructionDecisions',
      '음향 지시의 필요 여부와 트랙 연결을 검토하세요. 음악 없음도 원문 근거를 확인해야 합니다.', 'confirmed instruction decision', decision?.reviewStatus ?? 'missing', instruction.sourceRefs)];
    return audioInstructionContentIssues(project, instruction, decision);
  });
}

/** 판정과 필요한 빈 음향 트랙을 함께 만든다. 파일·시각·사람 승인을 만들어 내지 않는다. */
export function applyAudioInstructionDecision(project: Project, input: AudioInstructionDecision, newCueId: string): Project {
  const decision = AudioInstructionDecisionSchema.parse(input);
  const instruction = audioInstructions(project).find((value): boolean => value.id === decision.instructionId);
  const segment = project.dataset.segments.find((value): boolean => value.id === instruction?.segmentId);
  if (instruction === undefined || segment === undefined || !audioInstructionMatches(instruction, decision.sourceSnapshot)) throw contractError('AUDIO_INSTRUCTION_SOURCE_CHANGED', '현재 음향 지시와 기준 구간을 다시 확인하세요.', []);
  const previous = (project.audioInstructionDecisions ?? []).find((value): boolean => value.instructionId === instruction.id);
  if (decision.origin === 'automatic' && previous !== undefined && (previous.origin === 'manual' || previous.reviewStatus === 'confirmed')) throw contractError('AUDIO_INSTRUCTION_PROTECTED', `${instruction.id}: 직접 입력하거나 확인한 판정은 보존합니다.`, []);
  const owned = project.audioCues.filter((cue): boolean => cue.instructionId === instruction.id);
  if (owned.some((cue): boolean => !decision.cueIds.includes(cue.id) && (cue.assetId !== null || automaticAudioProtected(project, cue)))) throw contractError('AUDIO_INSTRUCTION_AUDIO_IN_USE', '이미 준비한 음원이나 보호된 컷의 음향을 제거할 수 없습니다. 기존 연결을 유지하세요.', []);
  const create: boolean = decision.resolution === 'required' && decision.cueIds.length === 0;
  if (create && project.audioCues.some((cue): boolean => cue.id === newCueId)) throw contractError('DUPLICATE_AUDIO_CUE', `새 음향 트랙 ID가 이미 있습니다: ${newCueId}`, []);
  const newCue: AudioCue = { id: newCueId, unitId: null, instructionId: instruction.id, kind: instruction.kind === 'music' ? 'music' : 'sfx',
    startMs: segment.startMs, endMs: segment.endMs, timingStatus: 'proposed', timingRelation: 'within-segment', assetId: null };
  if (create && automaticAudioProtected(project, newCue)) throw contractError('AUDIO_INSTRUCTION_PROTECTED', '보호된 컷의 시간대에 새 음향을 추가할 수 없습니다.', []);
  const completed: AudioInstructionDecision = { ...decision, cueIds: create ? [newCueId] : [...decision.cueIds] };
  const next = ProjectSchema.parse({ ...project,
    audioInstructionDecisions: [...(project.audioInstructionDecisions ?? []).filter((value): boolean => value.instructionId !== instruction.id), completed],
    audioCues: [...project.audioCues.filter((cue): boolean => cue.instructionId !== instruction.id || completed.cueIds.includes(cue.id)), ...(create ? [newCue] : [])],
  });
  assertNoErrors(audioInstructionStructureIssues(next), 'INVALID_AUDIO_INSTRUCTION');
  const contentIssues: Issue[] = audioInstructionContentIssues(next, instruction, completed);
  if (contentIssues.length > 0) throw contractError('INVALID_AUDIO_INSTRUCTION', contentIssues[0]!.message, contentIssues);
  return next;
}

export function updateAudioInstruction(project: Project, input: AudioInstructionInput, newCueId: string): Project {
  const value = AudioInstructionInputSchema.parse(input);
  const instruction = audioInstructions(project).find((candidate): boolean => candidate.id === value.instructionId);
  if (instruction === undefined) throw contractError('AUDIO_INSTRUCTION_NOT_FOUND', `음향 지시가 없습니다: ${value.instructionId}`, []);
  return applyAudioInstructionDecision(project, { ...value, sourceSnapshot: structuredClone(instruction), reviewStatus: 'proposed', origin: 'manual', generationId: null }, newCueId);
}

export function confirmAudioInstruction(project: Project, instructionId: string): Project {
  const decision = (project.audioInstructionDecisions ?? []).find((value): boolean => value.instructionId === instructionId);
  if (decision === undefined) throw contractError('AUDIO_INSTRUCTION_NOT_PLANNED', '음향 필요 여부와 연결을 먼저 저장하세요.', []);
  assertNoErrors(audioInstructionStructureIssues(project), 'INVALID_AUDIO_INSTRUCTION');
  const instruction = audioInstructions(project).find((value): boolean => value.id === instructionId)!;
  const contentIssues: Issue[] = audioInstructionContentIssues(project, instruction, decision);
  if (contentIssues.length > 0) throw contractError('INVALID_AUDIO_INSTRUCTION', contentIssues[0]!.message, contentIssues);
  return { ...project, audioInstructionDecisions: (project.audioInstructionDecisions ?? []).map((value): AudioInstructionDecision => value.instructionId === instructionId ? { ...value, reviewStatus: 'confirmed' } : value) };
}
