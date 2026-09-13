import type { TextFontSource } from '../rendering/text-font-source.js';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import type { FinalReadinessReport } from '../domain/final-readiness.js';
import { withProjectTextReadiness } from '../rendering/project-text.js';
import { sha256Text } from '../importers/integrity.js';
import { stableJsonStringify } from '../io/stable-json.js';
import { initialOutputOptions, outputSelectionLabel, selectedOutputFrames, selectedOutputShots, StoryboardOutputOptionsSchema } from '../exporters/output-options.js';
import type { StoryboardOutputOptions } from '../exporters/output-options.js';
import { exportSelectedCsv, exportSelectedPdf } from '../exporters/selected-output.js';
import type { ProjectStore } from './store.js';

const OutputQuerySchema = z.strictObject({ maturity: z.enum(['draft', 'final']).optional(), options: z.string().max(32000).optional(),
  revision: z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().nonnegative().safe()).optional() });
const ProjectParamsSchema = z.strictObject({ projectId: z.string().min(1) });
type OutputRequestSnapshot = { projectId: string; options: StoryboardOutputOptions; maturity: 'draft' | 'final';
  snapshot: { project: Project; integrity: Record<string, string>; readiness: FinalReadinessReport } };

function outputOptions(value: string | undefined): StoryboardOutputOptions {
  if (value === undefined) return initialOutputOptions();
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; }
  catch (error: unknown) {
    if (!(error instanceof SyntaxError)) throw error;
    throw contractError('OUTPUT_OPTIONS_INVALID', '출력 설정 JSON이 올바르지 않습니다. 설정 화면에서 다시 내려받으세요.', []);
  }
  return StoryboardOutputOptionsSchema.parse(parsed);
}

function attachment(reply: FastifyReply, filename: string, extension: string, revision: number, maturity: string): void {
  const name: string = `${filename}-r${revision}-${maturity}.${extension}`;
  reply.header('Cache-Control', 'no-store').header('Content-Disposition', `attachment; filename="storyboard.${extension}"; filename*=UTF-8''${encodeURIComponent(name)}`);
}

/** 출력 선택은 원본 저장·승인에 영향을 주지 않으며 요청한 revision과 전체 Final 조건을 유지한다. */
export function registerOutputRoutes(app: FastifyInstance, store: ProjectStore, fontPath: TextFontSource): void {
  const snapshotFor = async (request: FastifyRequest): Promise<OutputRequestSnapshot> => {
    const { projectId } = ProjectParamsSchema.parse(request.params);
    const query = OutputQuerySchema.parse(request.query);
    const options: StoryboardOutputOptions = outputOptions(query.options);
    const snapshot = await store.outputSnapshot(projectId);
    if (query.revision !== undefined && query.revision !== snapshot.project.revision) throw contractError('REVISION_CONFLICT',
      `출력 기준 revision ${query.revision}과 현재 ${snapshot.project.revision}이 다릅니다. 새로고침 후 다시 내려받으세요.`, []);
    selectedOutputShots(snapshot.project, options);
    return { projectId, options, snapshot, maturity: query.maturity ?? 'draft' };
  };
  const assertUnchanged = async (project: Project): Promise<void> => {
    if ((await store.read(project.projectId)).revision !== project.revision) throw contractError('REVISION_CONFLICT',
      '출력 중 콘티가 변경됐습니다. 새로고침 후 같은 출력 설정으로 다시 내려받으세요.', []);
  };
  app.get('/api/projects/:projectId/export.csv', async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
    const { options, snapshot, maturity } = await snapshotFor(request);
    const content: string = await exportSelectedCsv(snapshot.project, fontPath, { maturity, channel: 'csv-export' }, snapshot.integrity, options);
    await assertUnchanged(snapshot.project);
    attachment(reply, options.filename, 'csv', snapshot.project.revision, maturity); reply.type('text/csv; charset=utf-8'); return content;
  });
  app.get('/api/projects/:projectId/export.pdf', async (request: FastifyRequest, reply: FastifyReply): Promise<Buffer> => {
    const { projectId, options, snapshot, maturity } = await snapshotFor(request);
    const content: Buffer = await exportSelectedPdf(snapshot.project, fontPath, async (id: string): Promise<Buffer> => (await store.asset(projectId, id)).content,
      { maturity, channel: 'pdf-export' }, snapshot.integrity, options, new Date().toISOString());
    await assertUnchanged(snapshot.project);
    attachment(reply, options.filename, 'pdf', snapshot.project.revision, maturity); reply.type('application/pdf'); return content;
  });
  app.get('/api/projects/:projectId/export-options.json', async (request: FastifyRequest, reply: FastifyReply): Promise<string> => {
    const { projectId, options, snapshot, maturity } = await snapshotFor(request);
    const result = { artifactType: 'storyboard-output-selection', version: '1.0.0', projectId, revision: snapshot.project.revision, maturity,
      projectSha256: sha256Text(stableJsonStringify(snapshot.project)), options, selection: outputSelectionLabel(snapshot.project, options),
      shotIds: selectedOutputShots(snapshot.project, options).map((shot): string => shot.id), frameIds: selectedOutputFrames(snapshot.project, options).map((frame): string => frame.id),
      finalReady: (await withProjectTextReadiness(snapshot.project, snapshot.readiness, fontPath)).finalReady, note: '출력 선택 기록입니다. 편집 프로젝트·최종 승인 증명이 아닙니다.' };
    await assertUnchanged(snapshot.project);
    attachment(reply, options.filename, 'output-options.json', snapshot.project.revision, maturity); reply.type('application/json; charset=utf-8'); return stableJsonStringify(result);
  });
}
