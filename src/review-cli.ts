import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { readBuildManifest } from './build.js';
import { contractError } from './domain/errors.js';
import { readReviewArchive, reviewMediaFiles, writeReviewBundle } from './exporters/review-bundle.js';
import { loadConfig } from './server/config.js';

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw contractError('MISSING_ARGUMENT', `${name} 인수를 지정하세요.`, []);
  return value;
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, 'data-root': { type: 'string' },
    'project-id': { type: 'string' }, output: { type: 'string' }, maturity: { type: 'string' },
    'include-media': { type: 'boolean' }, 'created-at': { type: 'string' } }, strict: true, allowPositionals: false });
  const config = await loadConfig(values.config ?? 'storyboard.config.json');
  const maturity: string = required(values.maturity, '--maturity draft|final');
  if (maturity !== 'draft' && maturity !== 'final') throw contractError('INVALID_OUTPUT_MATURITY', '--maturity는 draft 또는 final이어야 합니다.', []);
  const archive = await readReviewArchive(values['data-root'] === undefined ? config.dataRoot : resolve(values['data-root']), required(values['project-id'], '--project-id'));
  const manifest = await writeReviewBundle(archive, { output: required(values.output, '--output'), maturity,
    createdAt: values['created-at'] ?? new Date().toISOString(), build: readBuildManifest(), fontPath: config.pdfFontPath },
  values['include-media'] === true ? await reviewMediaFiles(archive) : []);
  process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
}

void main().catch((error: unknown): void => {
  process.stderr.write(`${JSON.stringify({ code: error instanceof Error && 'code' in error ? error.code : 'REVIEW_BUNDLE_FAILED',
    message: error instanceof Error ? error.message : String(error), issues: error instanceof Error && 'issues' in error ? error.issues : [] }, null, 2)}\n`);
  process.exitCode = 1;
});
