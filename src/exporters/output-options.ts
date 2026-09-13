import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import type { Project, Shot, StoryboardFrame } from '../domain/schema.js';

export const OutputSectionSchema = z.enum(['direction', 'sources', 'text', 'audio']);
export type OutputSection = z.infer<typeof OutputSectionSchema>;
export const PdfFormatSchema = z.strictObject({
  pageSize: z.enum(['A4', 'A3']), orientation: z.enum(['landscape', 'portrait']),
  layout: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('detail') }),
    z.strictObject({ kind: z.literal('board'), framesPerPage: z.union([z.literal(2), z.literal(4), z.literal(6)]) })]),
  sections: z.array(OutputSectionSchema).max(4).refine((values): boolean => new Set(values).size === values.length, '출력 항목이 중복됩니다.'),
});
export type PdfFormat = z.infer<typeof PdfFormatSchema>;
export const StoryboardOutputOptionsSchema = z.strictObject({
  version: z.literal('1.0.0'),
  scope: z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('all') }),
    z.strictObject({ kind: z.literal('segments'), segmentIds: z.array(z.string().min(1).max(512)).min(1).max(256)
      .refine((ids): boolean => new Set(ids).size === ids.length, '선택 구간이 중복됩니다.') })]),
  frames: z.enum(['all', 'representative']), pdf: PdfFormatSchema, csv: z.enum(['technical', 'readable']),
  filename: z.string().min(1).max(100).regex(/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u, '파일 이름은 문자·숫자로 시작하고 경로·확장자를 제외하세요.')
    .refine((value): boolean => !value.endsWith('.') && !value.endsWith(' '), '파일 이름 끝의 공백·마침표를 제거하세요.'),
});
export type StoryboardOutputOptions = z.infer<typeof StoryboardOutputOptionsSchema>;

/** 출력 선호는 제작 원문·승인과 분리하며 호출마다 명시적 스냅샷을 만든다. */
export function initialOutputOptions(): StoryboardOutputOptions {
  return { version: '1.0.0', scope: { kind: 'all' }, frames: 'all', csv: 'technical', filename: 'storyboard',
    pdf: { pageSize: 'A4', orientation: 'landscape', layout: { kind: 'detail' }, sections: ['direction', 'sources', 'text', 'audio'] } };
}

export function selectedOutputShots(project: Project, input: StoryboardOutputOptions): Shot[] {
  const options: StoryboardOutputOptions = StoryboardOutputOptionsSchema.parse(input);
  if (options.scope.kind === 'all') return [...project.shots];
  const selected: ReadonlySet<string> = new Set(options.scope.segmentIds);
  for (const id of selected) if (!project.dataset.segments.some((segment): boolean => segment.id === id)) {
    throw contractError('OUTPUT_SEGMENT_NOT_FOUND', `출력 구간 ${id}가 현재 프로젝트 ${project.projectId}에 없습니다. 구간 선택을 다시 확인하세요.`, []);
  }
  const shots: Shot[] = project.shots.filter((shot): boolean => selected.has(shot.segmentId));
  if (shots.length === 0) throw contractError('OUTPUT_SELECTION_EMPTY', '선택한 구간에 출력할 컷이 없습니다.', []);
  return shots;
}

/** 대표 그림은 저장된 첫 키 프레임, 시작 프레임, 첫 프레임 순으로 고른다. 승인 여부로 바꾸지 않는다. */
export function selectedOutputFrames(project: Project, options: StoryboardOutputOptions): StoryboardFrame[] {
  return selectedOutputShots(project, options).flatMap((shot): StoryboardFrame[] => {
    const frames: StoryboardFrame[] = project.frames.filter((frame): boolean => frame.shotId === shot.id)
      .sort((left, right): number => left.offsetMs - right.offsetMs);
    if (options.frames === 'all') return frames;
    const representative: StoryboardFrame | undefined = frames.find((frame): boolean => frame.role === 'key')
      ?? frames.find((frame): boolean => frame.role === 'start') ?? frames[0];
    return representative === undefined ? [] : [representative];
  });
}

export function outputSelectionLabel(project: Project, options: StoryboardOutputOptions): string {
  const shots: Shot[] = selectedOutputShots(project, options);
  return `${options.scope.kind === 'all' ? '전체 구간' : '선택 구간'} · ${shots.length}/${project.shots.length}컷 · ${options.frames === 'all' ? '전체 프레임' : '컷별 대표 프레임'} · ${selectedOutputFrames(project, options).length}개`;
}
