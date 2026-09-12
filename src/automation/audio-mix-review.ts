import { z } from 'zod';
import { audioMixValues } from '../domain/audio-mix.js';
import { IssueSchema } from '../domain/schema.js';
import type { Project } from '../domain/schema.js';
import { AutomaticAudioMixPlanSchema } from './audio-mix-schema.js';

const RecordSchema = z.object({ output: AutomaticAudioMixPlanSchema, problems: z.array(IssueSchema), evidence: z.array(z.object({
  cueId: z.string(), assetId: z.string(), startMs: z.number(), endMs: z.number(), levels: z.object({ sha256: z.string(), peakDbfs: z.number().nullable(), rmsDbfs: z.number().nullable(), silent: z.boolean() }),
})) });
export type AudioMixReview = { status: 'none' } | { status: 'invalid'; message: string }
  | { status: 'recorded'; model: string; matchesCurrent: boolean; summary: string; problems: string[]; peakDbfs: number | null; rmsDbfs: number | null };

/** 최근 자동 음량의 실제 측정·잔여 검토를 보여 주되 수동 수정 뒤의 값과 구별한다. */
export function audioMixReview(project: Project, cueId: string): AudioMixReview {
  const cue = project.audioCues.find((item): boolean => item.id === cueId);
  if (cue === undefined) return { status: 'none' };
  for (const record of [...project.generationRecords].reverse()) {
    if (record.templateVersion !== 'automatic-audio-mix-1.0.0') continue;
    let raw: unknown;
    try { raw = JSON.parse(record.prompt) as unknown; }
    catch (error: unknown) { if (!(error instanceof SyntaxError)) throw error; return { status: 'invalid', message: '자동 음량 기록을 읽을 수 없습니다. 저장 기록을 확인하세요.' }; }
    const parsed = RecordSchema.safeParse(raw);
    if (!parsed.success) return { status: 'invalid', message: '자동 음량 기록의 측정·계획 형식이 유효하지 않습니다.' };
    const planned = parsed.data.output.cues.find((item): boolean => item.cueId === cueId);
    if (planned === undefined) continue;
    const evidence = parsed.data.evidence.find((item): boolean => item.cueId === cueId);
    const levels = evidence?.levels;
    if (levels === undefined) return { status: 'invalid', message: '자동 음량 기록에 이 음원의 실측 근거가 없습니다.' };
    const values = audioMixValues(cue);
    return { status: 'recorded', model: record.model, summary: parsed.data.output.summary,
      matchesCurrent: evidence?.assetId === cue.assetId && evidence.startMs === cue.startMs && evidence.endMs === cue.endMs
        && levels.sha256 === project.assets.find((asset): boolean => asset.id === cue.assetId)?.sha256 && cue.mix?.mode === 'automatic' && values.volumeDb === planned.volumeDb && values.fadeInMs === planned.fadeInMs && values.fadeOutMs === planned.fadeOutMs,
      problems: parsed.data.problems.map((problem): string => `${problem.entityId}: ${problem.message}`), peakDbfs: levels.peakDbfs, rmsDbfs: levels.rmsDbfs };
  }
  return { status: 'none' };
}
