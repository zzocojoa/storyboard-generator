import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterEach, describe, expect, it } from 'vitest';
import { contractError } from '../src/domain/errors.js';
import { httpErrorPolicy } from '../src/server/app.js';
import { reviewProfile, reviewRedactionPatterns } from '../src/exporters/review-redaction.js';
import { generatorBuildProvenance, readBuildManifest } from '../src/build.js';
import type { Project } from '../src/domain/schema.js';
import { exportProjectJson } from '../src/exporters/json.js';
import { readReviewArchive, reviewMediaFiles, writeReviewBundle } from '../src/exporters/review-bundle.js';
import type { ReviewArchive, ReviewBundleOptions } from '../src/exporters/review-bundle.js';
import { sha256Bytes, sha256Text } from '../src/importers/integrity.js';
import { readyVisualFixture } from './readiness-fixtures.js';

type Options = ReviewBundleOptions & { profile: 'internal' | 'external'; piiPatterns: readonly string[] };
type Fixture = { root: string; archive: ReviewArchive; options: Options };
const email: string = 'reviewer@example.com'; const phone: string = '010-1234-5678';
const localPath: string = '/Users/private-person/private-note.txt'; const prompt: string = '개인 생성 지시 원문 SECRET-PROMPT';
const roots: string[] = [];
const execute = promisify(execFile);
afterEach(async (): Promise<void> => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(): Promise<Fixture> {
  const root: string = await mkdtemp(join(tmpdir(), 'review-redaction-')); roots.push(root);
  const { project: base, bytes } = await readyVisualFixture();
  const project: Project = { ...base, title: `${email} ${phone}`, shots: base.shots.map((shot) => ({ ...shot, action: `${email} ${phone} VIP-1234` })),
    assets: base.assets.map((asset, index) => ({ ...asset, path: index === 0 ? `assets/${email}.png` : asset.path, description: localPath })), generationRecords: [{ id: 'private-generation', provider: 'codex-app', model: 'imagegen', modelVersion: null,
      generatorBuild: generatorBuildProvenance(readBuildManifest()), requestId: 'private-request', prompt, templateVersion: '1', seed: null, referenceHashes: [], resultAssetIds: [base.assets[0]!.id], shotIds: [base.shots[0]!.id], createdAt: '2026-09-07T00:00:00.000Z' }] };
  const directory: string = join(root, 'data', sha256Text(project.projectId)); await mkdir(join(directory, 'versions'), { recursive: true }); await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'project.json'), exportProjectJson(project)); await writeFile(join(directory, 'versions/000000.json'), exportProjectJson(project));
  for (const asset of project.assets) await writeFile(join(directory, asset.path), bytes);
  return { root, archive: await readReviewArchive(join(root, 'data'), project.projectId), options: { output: join(root, 'EXTERNAL REDACTED'), profile: 'external', piiPatterns: ['VIP-[0-9]{4}'],
    maturity: 'draft', fontPath: resolve('assets/fonts/NanumGothic-Regular.ttf'), createdAt: '2026-09-07T00:00:00.000Z', build: readBuildManifest() } };
}
async function jsonContent(value: Fixture): Promise<string> {
  const names: string[] = (await readdir(value.options.output)).filter((path: string): boolean => path.endsWith('.json'));
  return (await Promise.all(names.map((path: string): Promise<string> => readFile(join(value.options.output, path), 'utf8')))).join('\n');
}
async function pdfContents(path: string): Promise<{ text: string; images: number }> {
  const task = getDocument({ data: new Uint8Array(await readFile(path)), useSystemFonts: false, disableFontFace: true });
  try {
    const document = await task.promise; const text: string[] = []; let images: number = 0;
    for (let pageNumber: number = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber); const content = await page.getTextContent();
      text.push(content.items.flatMap((item): string[] => 'str' in item ? [item.str] : []).join(' '));
      const operators = await page.getOperatorList(); images += operators.fnArray.filter((operation: number): boolean => [OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(operation)).length;
    }
    return { text: text.join('\n'), images };
  } finally { await task.destroy(); }
}

describe('Internal·External 검토 출력', (): void => {
  it('internal_bundle_preserves_full_review_content', async (): Promise<void> => {
    const value = await fixture(); const manifest = await writeReviewBundle(value.archive, { ...value.options, profile: 'internal' }, []);
    expect(manifest).toMatchObject({ profile: 'internal' }); const content: string = await jsonContent(value);
    for (const raw of [email, phone, localPath, prompt]) expect(content).toContain(raw);
    const output = JSON.parse(await readFile(join(value.options.output, 'project.json'), 'utf8')); expect(output.project.sources).toEqual(value.archive.project.sources);
    expect((await pdfContents(join(value.options.output, 'storyboard.pdf'))).images).toBeGreaterThan(0);
  });
  it('external_bundle_removes_source_snapshot_content', async (): Promise<void> => {
    const value = await fixture(); await writeReviewBundle(value.archive, value.options, []); const output = JSON.parse(await readFile(join(value.options.output, 'project.json'), 'utf8'));
    expect(output.project.sources[0].content).toContain('[REDACTED:source-content:'); expect(output.project.sources[0].content).not.toBe(value.archive.project.sources[0]!.content);
  });
  it('external_bundle_removes_generation_prompts', async (): Promise<void> => {
    const value = await fixture(); await writeReviewBundle(value.archive, value.options, []); expect(await jsonContent(value)).not.toContain(prompt);
  });
  it('external_bundle_removes_absolute_paths', async (): Promise<void> => {
    const value = await fixture(); await writeReviewBundle(value.archive, value.options, []); expect(await jsonContent(value)).not.toContain(localPath);
  });
  it('external_bundle_redacts_email_and_phone', async (): Promise<void> => {
    const value = await fixture(); await writeReviewBundle(value.archive, value.options, []); const content: string = await jsonContent(value);
    expect(content).not.toContain(email); expect(content).not.toContain(phone); expect(content).not.toContain('VIP-1234');
  });
  it('external_csv_uses_redacted_projection', async (): Promise<void> => {
    const value = await fixture(); await writeReviewBundle(value.archive, value.options, []); const content: string = await readFile(join(value.options.output, 'shots.csv'), 'utf8');
    expect(content).not.toContain(email); expect(content).not.toContain(phone); expect(content).not.toContain(localPath); expect(content).not.toContain('VIP-1234'); expect(content).toContain('EXTERNAL REDACTED');
  });
  it('external_pdf_uses_redacted_projection', async (): Promise<void> => {
    const value = await fixture(); await writeReviewBundle(value.archive, value.options, []); const output = await pdfContents(join(value.options.output, 'storyboard.pdf'));
    expect(output.text).not.toContain(email); expect(output.text).not.toContain(phone); expect(output.text).not.toContain('VIP-1234'); expect(output.text).toContain('EXTERNAL REDACTED');
  });
  it('external_bundle_rejects_include_media', async (): Promise<void> => {
    const value = await fixture(); await expect(writeReviewBundle(value.archive, value.options, await reviewMediaFiles(value.archive))).rejects.toMatchObject({ code: 'REVIEW_EXTERNAL_MEDIA_FORBIDDEN' });
    await expect(readdir(value.options.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('external_bundle_uses_image_placeholders', async (): Promise<void> => {
    const value = await fixture(); const manifest = await writeReviewBundle(value.archive, value.options, []);
    expect(manifest).toMatchObject({ externalImagePolicy: 'placeholder', embeddedImageRedaction: 'not-performed' });
    expect((await pdfContents(join(value.options.output, 'storyboard.pdf'))).images).toBe(0);
  });
  it('redaction_manifest_contains_hashes_but_not_raw_values', async (): Promise<void> => {
    const value = await fixture(); await writeReviewBundle(value.archive, value.options, []); const content: string = await readFile(join(value.options.output, 'redaction-manifest.json'), 'utf8');
    expect(content).toContain(sha256Text(prompt)); for (const raw of [email, phone, localPath, prompt, 'VIP-1234']) expect(content).not.toContain(raw);
    expect(JSON.parse(content)).toMatchObject({ profile: 'external', policyVersion: '1.0.0', entries: expect.arrayContaining([expect.objectContaining({ category: 'generation-prompt' })]) });
  });
  it('external_bundle_does_not_modify_source_project', async (): Promise<void> => {
    const value = await fixture(); const path: string = join(value.root, 'data', sha256Text(value.archive.project.projectId), 'project.json'); const before: string = sha256Bytes(await readFile(path));
    await writeReviewBundle(value.archive, value.options, []); expect(sha256Bytes(await readFile(path))).toBe(before); await value.archive.assertUnchanged();
  });
  it('external_bundle_redacts_builder_metadata_and_source_hash_keys', async (): Promise<void> => {
    const value = await fixture();
    await writeReviewBundle(value.archive, { ...value.options, build: { ...value.options.build, appVersion: email } }, []);
    expect(await jsonContent(value)).not.toContain(email);
  });
  it('review_profiles_validate_explicit_requests_without_silent_switch', (): void => {
    expect(reviewProfile(undefined)).toBe('internal'); expect(reviewProfile('external')).toBe('external');
    expect((): void => { reviewProfile('unknown'); }).toThrowError(expect.objectContaining({ code: 'REVIEW_REDACTION_PROFILE_INVALID' }));
    expect((): void => { reviewRedactionPatterns(['[broken']); }).toThrowError(expect.objectContaining({ code: 'REVIEW_REDACTION_PATTERN_INVALID' }));
    for (const code of ['REVIEW_REDACTION_PROFILE_INVALID', 'REVIEW_EXTERNAL_MEDIA_FORBIDDEN']) expect(httpErrorPolicy(contractError(code, '검토', []))).toMatchObject({ status: 400, mutationBlocked: false });
    expect(httpErrorPolicy(contractError('REVIEW_SOURCE_NOT_QUIESCENT', '검토', []))).toMatchObject({ status: 423, scope: 'project', mutationBlocked: false });
  });

  it('review_cli_writes_internal_and_external_profiles_without_source_changes', async (): Promise<void> => {
    const value = await fixture();
    for (const profile of ['internal', 'external'] as const) {
      const output: string = join(value.root, `cli-${profile}`);
      const result = await execute(process.execPath, ['--import', 'tsx', 'src/review-cli.ts', '--data-root', join(value.root, 'data'),
        '--project-id', value.archive.project.projectId, '--output', output, '--maturity', 'draft', '--profile', profile, '--redact-pattern', 'VIP-[0-9]{4}']);
      expect(JSON.parse(result.stdout)).toMatchObject({ profile });
      const csv: string = await readFile(join(output, 'shots.csv'), 'utf8');
      expect(csv.includes(email)).toBe(profile === 'internal');
      expect(csv.includes('VIP-1234')).toBe(profile === 'internal');
      await value.archive.assertUnchanged();
    }
  }, 15_000);

  it('review_cli_errors_keep_complete_scoped_contract_before_opening_store', async (): Promise<void> => {
    for (const [args, code] of [
      [['--profile', 'unknown'], 'REVIEW_REDACTION_PROFILE_INVALID'],
      [['--profile', 'external', '--include-media'], 'REVIEW_EXTERNAL_MEDIA_FORBIDDEN'],
    ] as const) {
      const result: unknown = await execute(process.execPath, ['--import', 'tsx', 'src/review-cli.ts', '--config', '/missing/config.json', ...args]).then(
        (): never => { throw new Error('CLI가 잘못된 Profile 요청을 허용했습니다.'); },
        (error: unknown): unknown => error,
      );
      expect(result).toMatchObject({ code: 1, stdout: '' });
      if (!(result instanceof Error) || !('stderr' in result) || typeof result.stderr !== 'string') throw new Error('CLI 오류에 stderr가 없습니다.');
      expect(JSON.parse(result.stderr)).toMatchObject({ code, issues: [], mutationBlocked: false, retryable: false, operatorActionRequired: false,
        category: expect.any(String), scope: expect.any(String), projectId: null, resourceId: null });
    }
  }, 15_000);

});
