import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { storyboardAudioIssues } from '../domain/audio-storyboard.js';
import { contractError } from '../domain/errors.js';
import { AudioCueSchema, AudioInstructionDecisionSchema, IdSchema, InformationRuleSchema, InstructionSchema, SegmentSchema, UnitSchema } from '../domain/schema.js';
import type { AudioCue, GenerationRecord, Project } from '../domain/schema.js';
import { AutomaticAudioTimingSchema } from './plan-schema.js';

const TimingRecordSchema = z.object({
  input: z.string(), basis: z.object({ projectId: IdSchema, segmentId: IdSchema }),
  output: z.object({ segmentId: IdSchema, audioTimings: z.array(AutomaticAudioTimingSchema) }),
});
const TimingContextSchema = z.object({
  segment: SegmentSchema, units: z.array(UnitSchema), informationRules: z.array(InformationRuleSchema),
  instructions: z.array(InstructionSchema), audioCues: z.array(AudioCueSchema),
  audioInstructionDecisions: z.array(AudioInstructionDecisionSchema),
});
type TimingContext = z.infer<typeof TimingContextSchema>;

function recordJson(text: string, record: GenerationRecord): unknown {
  try { return JSON.parse(text) as unknown; }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    throw contractError('AUTOMATION_AUDIO_TIMING_EVIDENCE', `${record.id}: 저장한 음향 배치 근거의 JSON을 읽을 수 없습니다. 생성 기록을 확인하세요.`, []);
  }
}

function timingSources(project: Project, segmentId: string): Omit<TimingContext, 'audioCues' | 'audioInstructionDecisions'> {
  const units = project.dataset.units.filter((unit): boolean => unit.segmentId === segmentId);
  const segment = project.dataset.segments.find((value): boolean => value.id === segmentId);
  if (segment === undefined) throw contractError('SEGMENT_NOT_FOUND', `음향 배치 근거의 구간이 없습니다: ${segmentId}`, []);
  return { segment, units,
    informationRules: project.dataset.informationRules.filter((rule): boolean => rule.segmentId === segmentId || units.some((unit): boolean => unit.informationIds.includes(rule.id))),
    instructions: project.dataset.instructions.filter((instruction): boolean => instruction.segmentId === segmentId) };
}

function decisionsForCue(decisions: TimingContext['audioInstructionDecisions'], cueId: string): Array<Omit<TimingContext['audioInstructionDecisions'][number], 'reviewStatus'>> {
  return decisions.filter((decision): boolean => decision.cueIds.includes(cueId)).map(({ reviewStatus: _reviewStatus, ...decision }) => decision);
}

/** 최근 실제 배치와 현재 원문·발생·시각을 대조한다. 사람 미확인을 재생성 요청으로 해석하지 않는다. */
export function plannedSoundCueIds(project: Project, cues: readonly AudioCue[]): ReadonlySet<string> {
  const remaining: Set<string> = new Set(cues.map((cue): string => cue.id));
  const planned: Set<string> = new Set();
  for (const record of [...project.generationRecords].reverse()) {
    if (remaining.size === 0) break;
    if (!['automatic-source-repair-1.2.0', 'automatic-segment-plan-1.0.0'].includes(record.templateVersion)) continue;
    const parsed = TimingRecordSchema.safeParse(recordJson(record.prompt, record));
    if (!parsed.success) throw contractError('AUTOMATION_AUDIO_TIMING_EVIDENCE', `${record.id}: 저장한 음향 배치 결과 형식이 유효하지 않습니다. 생성 기록을 확인하세요.`, []);
    const { input, basis, output } = parsed.data;
    const targets = output.audioTimings.filter((timing): boolean => remaining.has(timing.cueId));
    if (targets.length === 0) continue;
    for (const timing of targets) remaining.delete(timing.cueId);
    if (basis.projectId !== project.projectId || basis.segmentId !== output.segmentId) throw contractError('AUTOMATION_AUDIO_TIMING_EVIDENCE', `${record.id}: 음향 배치의 프로젝트·구간 근거가 일치하지 않습니다.`, []);
    const marker: string = '입력 스냅샷:\n';
    const start: number = input.indexOf(marker);
    // 입력 스냅샷이 없는 이전 기록은 완료 근거로 추측하지 않는다.
    if (start < 0) continue;
    const context = TimingContextSchema.safeParse(recordJson(input.slice(start + marker.length), record));
    if (!context.success) throw contractError('AUTOMATION_AUDIO_TIMING_EVIDENCE', `${record.id}: 음향 배치 입력 스냅샷을 검증할 수 없습니다.`, []);
    const { audioCues, audioInstructionDecisions, ...sources } = context.data;
    if (!isDeepStrictEqual(sources, timingSources(project, basis.segmentId))) continue;
    for (const timing of targets) {
      if (output.audioTimings.filter((value): boolean => value.cueId === timing.cueId).length !== 1) throw contractError('AUTOMATION_AUDIO_TIMING_EVIDENCE', `${record.id}/${timing.cueId}: 음향 배치 결과가 중복됐습니다.`, []);
      const current = cues.find((cue): boolean => cue.id === timing.cueId)!;
      const previous = audioCues.find((cue): boolean => cue.id === timing.cueId);
      if (previous === undefined || current.unitId !== previous.unitId || current.instructionId !== previous.instructionId || current.kind !== previous.kind
        || current.startMs !== timing.startMs || current.endMs !== timing.endMs || current.timingRelation !== timing.timingRelation) continue;
      if (!isDeepStrictEqual(decisionsForCue(audioInstructionDecisions, current.id), decisionsForCue(project.audioInstructionDecisions ?? [], current.id))) continue;
      if (storyboardAudioIssues(project, current).length === 0) planned.add(current.id);
    }
  }
  return planned;
}
