import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { readDocumentSources, writeDocumentPackage } from '../src/documents/io.js';
import { verifyDocumentOutput } from '../src/documents/verify-output.js';
import { prepareStoryboardAttempt } from '../web/src/storyboard-creation-attempts.js';
import { documentTestSettings, SYNTHETIC_DOCUMENT_BINDINGS } from './document-helpers.js';

test('document_output_recovery_requires_complete_matching_bytes_and_preserves_changed_files', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'document-output-recovery-'));
  try {
    const directory: string = resolve('tests/fixtures/documents');
    const settings = documentTestSettings(await readDocumentSources(directory), SYNTHETIC_DOCUMENT_BINDINGS);
    const output: string = join(root, 'package');
    await expect(verifyDocumentOutput(directory, settings, output)).rejects.toMatchObject({ code: 'MISSING_DOCUMENT_OUTPUT' });
    await expect(verifyDocumentOutput(directory, settings, join(root, 'missing', 'package'))).rejects.toMatchObject({ code: 'MISSING_DOCUMENT_OUTPUT' });
    const result = await writeDocumentPackage(directory, settings, output);
    expect(await verifyDocumentOutput(directory, settings, output)).toEqual(result);
    const path: string = join(output, '09_PRODUCTION', 'narration.md');
    const original: string = await readFile(path, 'utf8');
    await writeFile(path, original + '\nchanged');
    await expect(verifyDocumentOutput(directory, settings, output)).rejects.toMatchObject({ code: 'DOCUMENT_OUTPUT_MISMATCH' });
    expect(await readFile(path, 'utf8')).toBe(original + '\nchanged');
    await writeFile(path, original);
    await expect(verifyDocumentOutput(directory, { ...settings, packageVersion: 'another' }, output)).rejects.toMatchObject({ code: 'DOCUMENT_OUTPUT_MISMATCH' });
    await symlink(output, join(root, 'alias'));
    await expect(verifyDocumentOutput(directory, settings, join(root, 'alias'))).rejects.toMatchObject({ code: 'INVALID_DOCUMENT_OUTPUT' });
    await rm(result.handoffPath);
    await expect(verifyDocumentOutput(directory, settings, output)).rejects.toMatchObject({ code: 'MISSING_DOCUMENT_FILE' });
    expect(await readFile(path, 'utf8')).toBe(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('storyboard_creation_intent_survives_new_reader_and_rejects_corrupt_or_unwritable_storage', (): void => {
  const data: Map<string, string> = new Map<string, string>();
  const storage: Pick<Storage, 'getItem' | 'setItem'> = { getItem: (key: string): string | null => data.get(key) ?? null,
    setItem: (key: string, value: string): void => { data.set(key, value); } };
  const flowId: string = crypto.randomUUID(); const fields = { handoffPath: '/package/handoff.json', name: '새 콘티', proposedTextHoldMs: 2000 };
  const first = prepareStoryboardAttempt(storage, flowId, fields);
  expect(prepareStoryboardAttempt({ ...storage }, flowId, fields)).toEqual(first);
  expect(prepareStoryboardAttempt(storage, flowId, { ...fields, name: '다른 입력' }).storyboardId).not.toBe(first.storyboardId);
  expect(prepareStoryboardAttempt(storage, crypto.randomUUID(), fields).storyboardId).not.toBe(first.storyboardId);
  const key: string = `cutroom:storyboard-create:1:${flowId}`;
  storage.setItem(key, '{broken');
  expect(() => prepareStoryboardAttempt(storage, flowId, fields)).toThrow();
  expect(storage.getItem(key)).toBe('{broken');
  expect(() => prepareStoryboardAttempt({ ...storage, setItem: (): never => { throw new Error('QuotaExceededError'); } }, crypto.randomUUID(), fields)).toThrow('QuotaExceededError');
});
