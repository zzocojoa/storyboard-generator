import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { HashSchema, IdSchema } from '../domain/schema.js';
import type { Segment, Snapshot, SourceRef } from '../domain/schema.js';
import { parseJson, sha256Text } from '../importers/integrity.js';
import { documentError, documentRefs, documentRows } from './readable.js';
import type { DocumentSources } from './schema.js';

const SceneManifestSchema = z.looseObject({ scene_id: IdSchema, location_id: IdSchema, cast_ids: z.array(IdSchema) });
const DocumentManifestSchema = z.looseObject({
  schema_family: z.literal('production-manifest'), schema_version: z.literal('1.1.0'), project_id: IdSchema,
  source_footprint_sha256: HashSchema, scenes: z.array(SceneManifestSchema).min(1),
  deliverables: z.array(z.looseObject({ artifact_name: z.string(), path: z.string(), sha256: HashSchema })),
});
export type DocumentManifest = z.infer<typeof DocumentManifestSchema>;
export type NarrationRow = { segmentId: string; name: string; text: string; sourceRefs: SourceRef[] };
export type PanelBlock = { segmentId: string; reactionId: string; durationMs: number; turns: { personId: string; text: string; sourceRefs: SourceRef[] }[]; sourceRefs: SourceRef[] };

/** 패키지 내부의 산출물만 검증하고 존재하지 않는 상위 footprint 검증을 주장하지 않는다. */
export function parseDocumentManifest(sources: DocumentSources): DocumentManifest {
  const file: Snapshot = sources.manifest;
  const manifest: DocumentManifest = DocumentManifestSchema.parse(parseJson(file.content, file.path));
  const ids: string[] = manifest.scenes.map((scene): string => scene.scene_id);
  if (new Set(ids).size !== ids.length) documentError(file, 1, 'manifest 장면 ID가 중복되었습니다.');
  for (const deliverable of manifest.deliverables) {
    const matched: Snapshot | undefined = Object.values(sources).find((source: Snapshot): boolean => source.path === deliverable.path);
    if (matched === undefined) throw contractError('MISSING_DOCUMENT_DELIVERABLE', `${file.path}: 8개 입력 밖의 산출물이 선언됐습니다: ${deliverable.path}`, []);
    if (deliverable.sha256 !== sha256Text(matched.content)) throw contractError('INVALID_DOCUMENT_HASH', `${deliverable.path}: manifest 해시 불일치. expected=${deliverable.sha256}, actual=${sha256Text(matched.content)}`, []);
  }
  for (const key of ['edit', 'shooting', 'narration', 'subtitles', 'panel'] as const) {
    const header: string = documentRows(sources[key])[0]?.text ?? '';
    if (!header.startsWith(`# ${manifest.project_id} `)) documentError(sources[key], 1, `프로젝트 ID ${manifest.project_id}가 포함된 제목이 필요합니다.`);
  }
  if (!documentRows(sources.reenactment).some((row): boolean => row.text === `- 프로젝트: ${manifest.project_id}`)) documentError(sources.reenactment, 1, 'manifest와 인물 대본의 프로젝트 ID가 다릅니다.');
  for (const row of documentRows(sources.edit)) {
    if (row.text.startsWith('|') && !row.text.startsWith('| `') && !row.text.startsWith('| 구간 |') && !/^\|[-:| ]+\|$/u.test(row.text)) documentError(sources.edit, row.line, '지원하지 않는 편집표 행입니다. 구간·장면 ID를 명시하세요.');
  }
  for (const row of documentRows(sources.subtitles)) if (row.text.startsWith('- ') && !/^- \d{2,}:\d{2} `/u.test(row.text)) documentError(sources.subtitles, row.line, '자막 큐의 시각·구간 표기가 필요합니다.');
  let inShootingCues: boolean = false;
  for (const row of documentRows(sources.shooting)) {
    if (row.text.startsWith('## ')) inShootingCues = row.text === '## 촬영 큐';
    else if (inShootingCues && row.text !== '' && !row.text.startsWith('- `')) documentError(sources.shooting, row.line, '지원하지 않는 촬영 큐 행입니다.');
  }
  return manifest;
}

export function parseNarration(file: Snapshot, segments: readonly Segment[]): NarrationRow[] {
  const rows: NarrationRow[] = documentRows(file).filter((row): boolean => row.text.startsWith('- ')).map((row): NarrationRow => {
    const match: RegExpExecArray | null = /^- `([^`]+)` \/ ([^:]+): (.+)$/u.exec(row.text);
    if (!match?.[1] || !match[2] || !match[3]) documentError(file, row.line, '지원하는 내레이션 구간/화자/원문 표기가 필요합니다.');
    const segment: Segment | undefined = segments.find((item: Segment): boolean => item.id === match[1]);
    if (segment?.mode !== 'NARRATION') documentError(file, row.line, `내레이션이 편집표의 NARRATION 구간에 연결되지 않았습니다: ${match[1]}`);
    return { segmentId: match[1], name: match[2], text: match[3], sourceRefs: documentRefs(file, row.line) };
  });
  for (const segment of segments.filter((item: Segment): boolean => item.mode === 'NARRATION')) {
    if (!rows.some((row: NarrationRow): boolean => row.segmentId === segment.id)) documentError(file, 1, `${segment.id}: 내레이션이 누락되었습니다.`);
  }
  return rows;
}

export function parsePanels(file: Snapshot, segments: readonly Segment[]): PanelBlock[] {
  const blocks: PanelBlock[] = [];
  let current: PanelBlock | null = null;
  for (const row of documentRows(file)) {
    if (row.text.startsWith('## ')) {
      const match: RegExpExecArray | null = /^## `([^`]+)` \/ `([^`]+)` \/ (\d+)초$/u.exec(row.text);
      if (!match?.[1] || !match[2] || !match[3]) documentError(file, row.line, '패널 구간·반응 ID·길이 표기가 필요합니다.');
      const segment: Segment | undefined = segments.find((item: Segment): boolean => item.id === match[1]);
      if (segment?.mode !== 'PANEL_REACTION' || segment.endMs - segment.startMs !== Number(match[3]) * 1000) documentError(file, row.line, '패널 시간 또는 모드가 편집표와 다릅니다.');
      current = { segmentId: match[1], reactionId: match[2], durationMs: Number(match[3]) * 1000, turns: [], sourceRefs: documentRefs(file, row.line) };
      blocks.push(current);
    } else if (row.text.startsWith('- ')) {
      const match: RegExpExecArray | null = /^- `([^`]+)`: (.+)$/u.exec(row.text);
      if (current === null || !match?.[1] || !match[2]) documentError(file, row.line, '패널 구간 안에 ID와 발화를 지정하세요.');
      current.turns.push({ personId: match[1], text: match[2], sourceRefs: documentRefs(file, row.line) });
    }
  }
  const ids: string[] = blocks.map((block: PanelBlock): string => block.segmentId);
  const reactions: string[] = blocks.map((block: PanelBlock): string => block.reactionId);
  if (new Set(ids).size !== ids.length || new Set(reactions).size !== reactions.length || blocks.some((block: PanelBlock): boolean => block.turns.length === 0)) documentError(file, 1, '패널 구간/반응 ID 중복 또는 발화 누락입니다.');
  if (segments.some((segment: Segment): boolean => segment.mode === 'PANEL_REACTION' && !ids.includes(segment.id))) documentError(file, 1, '편집표에 있는 패널 구간이 누락됐습니다.');
  return blocks;
}

export function verifyShootingManifest(file: Snapshot, manifest: DocumentManifest): void {
  const rows = documentRows(file).filter((row): boolean => row.text.includes('<!-- PRODUCTION_SCENE:'));
  if (rows.length !== manifest.scenes.length) documentError(file, 1, '촬영 문서와 manifest의 장면 수가 다릅니다.');
  const seen: string[] = [];
  for (const row of rows) {
    const match: RegExpExecArray | null = /^<!-- PRODUCTION_SCENE:(\S+) LOCATION:(\S+) CAST:(\S*) CHILD:(\S+) VEHICLE:(\S+) SFX:(\S+) VIOLENCE:(\S+) COMPLEXITY:(\S+) -->$/u.exec(row.text);
    if (!match?.[1] || !match[2] || match[3] === undefined) documentError(file, row.line, '지원하지 않는 촬영 manifest 표기입니다.');
    const scene = manifest.scenes.find((item): boolean => item.scene_id === match[1]);
    if (seen.includes(match[1]) || scene === undefined || scene.location_id !== match[2] || JSON.stringify(scene.cast_ids) !== JSON.stringify(match[3] === '' ? [] : match[3].split(','))) documentError(file, row.line, '촬영 문서와 manifest의 장면·장소·출연 ID가 다릅니다.');
    const fields: string[] = ['child_actor_use', 'vehicle_scene', 'special_effect_level', 'graphic_violence', 'production_complexity'];
    if (fields.some((field: string, index: number): boolean => scene[field] !== match[index + 4])) documentError(file, row.line, '촬영 문서와 manifest의 제작 조건이 다릅니다.');
    seen.push(match[1]);
  }
}
