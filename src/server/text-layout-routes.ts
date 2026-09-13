import type { TextFontSource } from '../rendering/text-font-source.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { reviewTextPlaybackWithPolicy } from '../domain/playback.js';
import { IdSchema, MillisecondsSchema } from '../domain/schema.js';
import { TextLayoutPresetSchema } from '../domain/text-layout-settings.js';
import { textLayoutControl } from '../domain/text-layout-control.js';
import { TextReadabilityPolicySchema } from '../domain/text-readability.js';
import { projectTextLayoutAt, textLayoutTimelineIssues } from '../rendering/project-text.js';
import { textLayoutSvg, vectorTextLayout } from '../rendering/text-font.js';
import { readSelectedTextFont, readTextFontCatalog } from '../rendering/text-font-source.js';
import { TextTypographySchema } from '../domain/text-typography.js';
import { TextPresentationValuesSchema, updateTextPresentation, resetTextPresentation } from '../domain/text-presentation.js';
import type { Project } from '../domain/schema.js';
import type { ProjectStore } from './store.js';

const Params = z.strictObject({ projectId: IdSchema });
const Query = z.strictObject({ atMs: z.string().regex(/^\d+$/u).transform(Number).pipe(MillisecondsSchema),
  revision: z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().nonnegative()), maturity: z.enum(['draft', 'final']) });

async function previewCandidateText(store: ProjectStore, candidate: Project, expectedRevision: number, atMs: number, fontPath: TextFontSource): Promise<object> {
  if (candidate.revision !== expectedRevision) throw contractError('REVISION_CONFLICT', '글자 미리보기의 기준이 변경됐습니다. 현재 콘티를 다시 불러오세요.', []);
  const font = await readSelectedTextFont(candidate.textTypography, fontPath);
  const layout = projectTextLayoutAt(candidate, atMs, 'draft', font);
  const blocked = reviewTextPlaybackWithPolicy(candidate, atMs, { maturity: 'draft', channel: 'program-monitor' }).blocked;
  if ((await store.read(candidate.projectId)).revision !== expectedRevision) throw contractError('REVISION_CONFLICT', '글자 미리보기 중 콘티가 변경됐습니다. 현재 콘티를 다시 불러오세요.', []);
  return { projectId: candidate.projectId, revision: expectedRevision, fontSha256: font.sha256, atMs,
    svg: textLayoutSvg(vectorTextLayout(layout, font)), issues: [...textLayoutTimelineIssues(candidate, font),
      ...blocked.flatMap((cue) => cue.issues.map((problem) => ({ ...problem, entityId: cue.cueId, message: `${cue.cueId}: ${problem.message}` })))] };
}

/** 요청한 revision의 허용된 글자만 조판하고 Project와 Cue 원문은 수정하지 않는다. */
export function registerTextLayoutRoutes(app: FastifyInstance, store: ProjectStore, fontPath: TextFontSource): void {
  app.patch('/api/projects/:projectId/text/:cueId/presentation', async (request): Promise<object> => {
    const { projectId, cueId } = z.strictObject({ projectId: IdSchema, cueId: IdSchema }).parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), presentation: TextPresentationValuesSchema }).parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (current): Project => updateTextPresentation(current, cueId, body.presentation), []) };
  });
  app.delete('/api/projects/:projectId/text/:cueId/presentation', async (request): Promise<object> => {
    const { projectId, cueId } = z.strictObject({ projectId: IdSchema, cueId: IdSchema }).parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative() }).parse(request.body);
    return { project: await store.update(projectId, body.expectedRevision, (current): Project => resetTextPresentation(current, cueId), []) };
  });
  app.post('/api/projects/:projectId/text/:cueId/presentation/preview', async (request, reply): Promise<object> => {
    const { projectId, cueId } = z.strictObject({ projectId: IdSchema, cueId: IdSchema }).parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), presentation: TextPresentationValuesSchema, atMs: MillisecondsSchema }).parse(request.body);
    const project = await store.read(projectId);
    if (project.revision !== body.expectedRevision) throw contractError('REVISION_CONFLICT', '개별 배치 미리보기의 기준이 변경됐습니다. 현재 콘티를 다시 불러오세요.', []);
    reply.header('Cache-Control', 'no-store');
    return previewCandidateText(store, updateTextPresentation(project, cueId, body.presentation), body.expectedRevision, body.atMs, fontPath);
  });
  app.get('/api/text-fonts', async (_request, reply): Promise<object> => {
    reply.header('Cache-Control', 'no-store');
    return readTextFontCatalog(fontPath);
  });
  app.patch('/api/projects/:projectId/text-typography', async (request): Promise<object> => {
    const { projectId } = Params.parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), textTypography: TextTypographySchema }).parse(request.body);
    await readSelectedTextFont(body.textTypography, fontPath);
    const project = await store.update(projectId, body.expectedRevision, (current) => ({ ...current,
      textTypography: body.textTypography, textLayoutControl: { ...current.textLayoutControl, plannedInputHash: null } }), []);
    return { project };
  });
  app.post('/api/projects/:projectId/text-typography/preview', async (request, reply): Promise<object> => {
    const { projectId } = Params.parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), textTypography: TextTypographySchema, atMs: MillisecondsSchema }).parse(request.body);
    const current = await store.read(projectId);
    reply.header('Cache-Control', 'no-store');
    return previewCandidateText(store, { ...current, textTypography: body.textTypography }, body.expectedRevision, body.atMs, fontPath);
  });
  app.patch('/api/projects/:projectId/text-readability', async (request): Promise<object> => {
    const { projectId } = Params.parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), textReadability: TextReadabilityPolicySchema }).parse(request.body);
    const project = await store.update(projectId, body.expectedRevision, (current) => ({ ...current, textReadability: body.textReadability }), []);
    return { project };
  });
  app.patch('/api/projects/:projectId/text-layout', async (request): Promise<object> => {
    const { projectId } = Params.parse(request.params);
    const body = z.strictObject({ expectedRevision: z.number().int().nonnegative(), textLayout: TextLayoutPresetSchema, mode: z.enum(['automatic', 'manual']).optional() }).parse(request.body);
    const project = await store.update(projectId, body.expectedRevision, (current) => ({ ...current, textLayout: body.textLayout,
      textLayoutControl: textLayoutControl(body.mode === 'automatic' ? 'automatic' : 'manual') }), []);
    return { project };
  });
  app.get('/api/projects/:projectId/text-layout', async (request, reply): Promise<object> => {
    const { projectId } = Params.parse(request.params); const query = Query.parse(request.query);
    const project = await store.read(projectId);
    if (project.revision !== query.revision) throw contractError('REVISION_CONFLICT', `${projectId}: 글자 조판 요청의 revision이 다릅니다. 현재 결과를 불러오세요.`, []);
    const font = await readSelectedTextFont(project.textTypography, fontPath);
    const layout = projectTextLayoutAt(project, query.atMs, query.maturity, font);
    const svg: string = textLayoutSvg(vectorTextLayout(layout, font));
    if ((await store.read(projectId)).revision !== query.revision) throw contractError('REVISION_CONFLICT', `${projectId}: 조판 중 콘티가 변경됐습니다. 현재 결과를 불러오세요.`, []);
    const review = reviewTextPlaybackWithPolicy(project, query.atMs, { maturity: query.maturity, channel: 'program-monitor' });
    reply.header('Cache-Control', 'no-store');
    return { projectId, revision: query.revision, atMs: query.atMs, maturity: query.maturity, svg, fontSha256: font.sha256,
      problems: layout.problems, visibleTexts: review.playable.filter((cue): boolean => layout.boxes.some((box): boolean => box.cueId === cue.id)).map((cue) => ({ cueId: cue.id, text: cue.text, timingStatus: cue.timingStatus })),
      boxes: layout.boxes.map(({ lines: _lines, ...box }) => box) };
  });
}
