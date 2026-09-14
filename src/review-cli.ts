import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { StoryboardOutputOptionsSchema } from './exporters/output-options.js';
import { readBuildManifest } from './build.js';
import { contractError } from './domain/errors.js';
import { readReviewArchive, reviewMediaFiles, writeReviewBundle } from './exporters/review-bundle.js';
import { reviewProfile } from './exporters/review-redaction.js';
import { errorBody } from './server/app.js';
import { loadConfig } from './server/config.js';

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw contractError('MISSING_ARGUMENT', `${name} 인수를 지정하세요.`, []);
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'data-root': { type: 'string' },
    'project-id': { type: 'string' }, output: { type: 'string' }, maturity: { type: 'string' },
    'include-media': { type: 'boolean' }, profile: { type: 'string' }, 'redact-pattern': { type: 'string', multiple: true }, 'created-at': { type: 'string' }, 'output-selection': { type: 'string' } }, strict: true, allowPositionals: false });
  const profile = reviewProfile(values.profile);
  if (profile === 'external' && values['include-media'] === true) throw contractError('REVIEW_EXTERNAL_MEDIA_FORBIDDEN', 'External Profile은 --include-media를 허용하지 않습니다.', []);
  const config = await loadConfig(values.config ?? 'storyboard.config.json');
  const maturity: string = required(values.maturity, '--maturity draft|final');
  if (maturity !== 'draft' && maturity !== 'final') throw contractError('INVALID_OUTPUT_MATURITY', '--maturity는 draft 또는 final이어야 합니다.', []);
  const archive = await readReviewArchive(values['data-root'] === undefined ? config.dataRoot : resolve(values['data-root']), required(values['project-id'], '--project-id'));
  const selection = values['output-selection'] === undefined ? undefined : z.object({ artifactType: z.literal('storyboard-output-selection'), version: z.literal('1.0.0'),
    projectId: z.string(), revision: z.number().int().nonnegative(), options: StoryboardOutputOptionsSchema }).parse(JSON.parse(await readFile(resolve(values['output-selection']), 'utf8')) as unknown);
  if (selection !== undefined && (selection.projectId !== archive.project.projectId || selection.revision !== archive.project.revision)) throw contractError('OUTPUT_SELECTION_STALE',
    '출력 선택 기록의 프로젝트·revision이 현재 콘티와 다릅니다. 검토·출력에서 새 기록을 내려받으세요.', []);
  const manifest = await writeReviewBundle(archive, { output: required(values.output, '--output'), maturity, profile, piiPatterns: values['redact-pattern'] ?? [], includeMedia: values['include-media'] === true,
    ...(selection === undefined ? {} : { outputOptions: selection.options }),
    createdAt: values['created-at'] ?? new Date().toISOString(), build: readBuildManifest(), fontPath: { defaultPath: config.pdfFontPath, registrations: config.textFonts ?? [] } },
  values['include-media'] === true ? await reviewMediaFiles(archive) : []);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

void main().catch((error: unknown): void => {
  const failure: Error = error instanceof Error ? error : contractError('REVIEW_BUNDLE_FAILED', String(error), []);
  process.stderr.write(`${JSON.stringify(errorBody(failure).error, null, 2)}\n`);
  process.exitCode = 1;
});
