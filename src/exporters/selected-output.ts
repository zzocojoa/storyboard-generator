import type { TextFontSource } from '../rendering/text-font-source.js';
import { assertFinalReadiness, reviewFinalReadiness } from '../domain/final-readiness.js';
import type { AssetIntegrityStatuses } from '../domain/final-readiness.js';
import type { OutputPolicy } from '../domain/output-policy.js';
import type { Project, Shot } from '../domain/schema.js';
import { withProjectTextReadiness } from '../rendering/project-text.js';
import { createCsvProjection, renderCsvProjection } from './csv.js';
import { audioTrackEntry, createSelectedPdfProjection, renderPdfProjection, textTrackEntry } from './pdf.js';
import type { AssetLoader, PdfTrackEntry } from './pdf.js';
import { outputSelectionLabel, selectedOutputFrames, selectedOutputShots, StoryboardOutputOptionsSchema } from './output-options.js';
import type { StoryboardOutputOptions } from './output-options.js';

function trackText(entries: PdfTrackEntry[]): string {
  return entries.map((entry): string => `${entry.id} · ${entry.label}\n${entry.timeText}\n${entry.body}\n${entry.statusText}`).join('\n\n');
}

/** 먼저 전체 프로젝트에서 출력 권한을 계산한 뒤 선택한 행과 열만 투영한다. */
export function createSelectedCsvProjection(project: Project, integrity: AssetIntegrityStatuses, policy: OutputPolicy, options: StoryboardOutputOptions): string[][] {
  StoryboardOutputOptionsSchema.parse(options);
  const shots: Shot[] = selectedOutputShots(project, options);
  const ids: ReadonlySet<string> = new Set(shots.map((shot): string => shot.id));
  const frames = selectedOutputFrames(project, options);
  const selectedFrameIds: ReadonlySet<string> = new Set(frames.map((frame): string => frame.id));
  const base: string[][] = createCsvProjection(project, integrity, policy);
  const header: string[] = base[0]!;
  const rows: string[][] = base.slice(1).filter((row): boolean => ids.has(row[header.indexOf('shot_id')]!));
  if (options.csv === 'technical') return [header, ...rows.map((row): string[] => row.map((cell, index): string =>
    header[index] === 'frames' ? JSON.stringify((JSON.parse(cell) as { id: string }[]).filter((frame): boolean => selectedFrameIds.has(frame.id))) : cell))];
  const sections: ReadonlySet<string> = new Set(options.pdf.sections);
  const columns: string[] = ['프로젝트', '출력 범위', '컷', '구간', '시작', '종료', '프레임', '선택 프레임 설명',
    ...(sections.has('direction') ? ['행동·연출', '구도·카메라', '전환'] : []), ...(sections.has('sources') ? ['원문 연결'] : []),
    ...(sections.has('text') ? ['화면 글자'] : []), ...(sections.has('audio') ? ['음성·음향'] : []), '검토 상태', '차단 사유'];
  const outputRows: string[][] = rows.map((row): string[] => {
    const cell = (name: string): string => row[header.indexOf(name)]!;
    const shot: Shot = shots.find((value): boolean => value.id === cell('shot_id'))!;
    const selected = frames.filter((frame): boolean => frame.shotId === shot.id);
    const units = JSON.parse(cell('source_units')) as { id: string; text?: string; outputSafety: string }[];
    return [project.title, `${policy.exportLabel ?? policy.maturity.toUpperCase()} · ${outputSelectionLabel(project, options)}`, shot.id, shot.segmentId, cell('start_time'), cell('end_time'),
      selected.map((frame): string => frame.id).join('\n'), selected.map((frame): string => `${frame.id}: ${frame.description}`).join('\n'),
      ...(sections.has('direction') ? [shot.action, `${shot.camera.size} · ${shot.camera.angle} · ${shot.camera.move}`, `${shot.transitionOut.kind} ${shot.transitionOut.durationMs}ms ${shot.transitionOut.note}`] : []),
      ...(sections.has('sources') ? [units.map((unit): string => `${unit.id}: ${unit.text ?? '[OUTPUT BLOCKED]'}`).join('\n')] : []),
      ...(sections.has('text') ? [trackText(project.textCues.filter((cue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs).map((cue): PdfTrackEntry => textTrackEntry(project, cue, policy)))] : []),
      ...(sections.has('audio') ? [trackText(project.audioCues.filter((cue): boolean => cue.startMs < shot.endMs && cue.endMs > shot.startMs).map((cue): PdfTrackEntry => audioTrackEntry(project, cue)))] : []),
      cell('output_safety_status'), cell('blocked_issue_codes')];
  });
  return [columns, ...outputRows];
}

export async function assertSelectedOutputReady(project: Project, integrity: AssetIntegrityStatuses, policy: OutputPolicy, fontPath: TextFontSource): Promise<void> {
  if (policy.maturity === 'final') assertFinalReadiness(await withProjectTextReadiness(project, reviewFinalReadiness(project, integrity), fontPath));
}

export async function exportSelectedPdf(project: Project, fontPath: TextFontSource, loadAsset: AssetLoader, policy: OutputPolicy, integrity: AssetIntegrityStatuses, options: StoryboardOutputOptions, createdAt: string): Promise<Buffer> {
  await assertSelectedOutputReady(project, integrity, policy, fontPath);
  return renderPdfProjection(await createSelectedPdfProjection(project, loadAsset, policy, integrity, options), fontPath, createdAt);
}

export async function exportSelectedCsv(project: Project, fontPath: TextFontSource, policy: OutputPolicy, integrity: AssetIntegrityStatuses, options: StoryboardOutputOptions): Promise<string> {
  await assertSelectedOutputReady(project, integrity, policy, fontPath);
  return renderCsvProjection(createSelectedCsvProjection(project, integrity, policy, options));
}
