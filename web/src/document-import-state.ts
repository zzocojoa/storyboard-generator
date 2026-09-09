import { ProfileSchema, TimebaseSchema } from '../../src/domain/schema.js';
import type { Profile, Timebase } from '../../src/domain/schema.js';
import { validateTimebase } from '../../src/domain/time.js';
import type { DocumentBindings, DocumentPreview, MappingChoice } from '../../src/documents/schema.js';

export type MappingField = keyof DocumentBindings;
export type ProductionFields = { fps: string; sampleRate: string; width: string; height: string; startTimecode: string };
export type FieldProblem = { id: string; message: string };
export type ProductionReview = { valid: true; timebase: Timebase; profile: Profile } | { valid: false; problems: FieldProblem[] };
export const MAPPING_GROUPS: readonly { field: MappingField; title: string }[] = [
  { field: 'people', title: '인물 ID' }, { field: 'scenes', title: '장면 ID' }, { field: 'units', title: '원문 구간' },
];

export function choiceValue(choice: MappingChoice, bindings: DocumentBindings[MappingField]): string {
  return bindings.find((entry): boolean => entry.key === choice.key)?.targetId ?? choice.selected ?? '';
}

export function mappingInputId(field: MappingField, key: string): string {
  return 'document-' + field + '-' + encodeURIComponent(key);
}

export function selectedBindings(bindings: DocumentBindings): DocumentBindings {
  return { people: bindings.people.filter((entry): boolean => entry.targetId !== ''),
    scenes: bindings.scenes.filter((entry): boolean => entry.targetId !== ''), units: bindings.units.filter((entry): boolean => entry.targetId !== '') };
}

export function mappingProblems(preview: DocumentPreview, bindings: DocumentBindings): FieldProblem[] {
  return MAPPING_GROUPS.flatMap(({ field, title }): FieldProblem[] => preview[field].flatMap((choice: MappingChoice): FieldProblem[] => {
    const value: string = choiceValue(choice, bindings[field]);
    const id: string = mappingInputId(field, choice.key);
    if (value === '') return [{ id, message: title + ': ' + choice.key + '의 연결을 선택하세요.' }];
    if (!choice.candidates.includes(value)) return [{ id, message: choice.key + ': 변경된 장면에 맞는 연결을 다시 선택하세요.' }];
    if (field !== 'units' && preview[field].some((other: MappingChoice): boolean => other.key !== choice.key && choiceValue(other, bindings[field]) === value)) {
      return [{ id, message: choice.key + ': ' + value + '가 다른 항목에도 선택되어 있습니다.' }];
    }
    return [];
  }));
}

export function reviewProductionFields(fields: ProductionFields): ProductionReview {
  const problems: FieldProblem[] = [];
  const [numerator, denominator] = fields.fps.split('/').map(Number);
  if (!fields.fps) problems.push({ id: 'document-fps', message: '프레임레이트를 선택하세요.' });
  if (!fields.sampleRate) problems.push({ id: 'document-sampleRate', message: '음성 샘플레이트를 선택하세요.' });
  for (const field of ['width', 'height'] as const) {
    if (!ProfileSchema.shape[field === 'width' ? 'aspectWidth' : 'aspectHeight'].safeParse(Number(fields[field])).success) problems.push({ id: 'document-' + field, message: '화면비 ' + (field === 'width' ? '가로' : '세로') + '는 1~16384 사이의 정수로 입력하세요.' });
  }
  const timebase = TimebaseSchema.safeParse({ fpsNumerator: numerator, fpsDenominator: denominator, dropFrame: false,
    sampleRate: Number(fields.sampleRate), startTimecode: fields.startTimecode });
  if (fields.fps && fields.sampleRate && (!timebase.success || validateTimebase(timebase.data).length > 0)) {
    problems.push({ id: 'document-startTimecode', message: '시작 타임코드를 HH:MM:SS:FF 형식으로 입력하고 프레임레이트와 맞는지 확인하세요.' });
  }
  const profile = ProfileSchema.safeParse({ medium: 'unspecified', aspectWidth: Number(fields.width), aspectHeight: Number(fields.height), visualStyle: null });
  if (problems.length > 0 || !timebase.success || !profile.success) return { valid: false, problems };
  return { valid: true, timebase: timebase.data, profile: profile.data };
}
