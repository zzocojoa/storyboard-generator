import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { AudioNormalizationWorkerOptionsSchema } from '../domain/audio-normalizer.js';
import { parseJson } from '../importers/integrity.js';
import { readUtf8 } from '../io/package.js';

export const AppConfigSchema = z.strictObject({
  host: z.literal('127.0.0.1'), port: z.number().int().min(1024).max(65535),
  dataRoot: z.string().min(1), webRoot: z.string().min(1), pdfFontPath: z.string().min(1),
  audioNormalization: AudioNormalizationWorkerOptionsSchema,
  codex: z.strictObject({ requestRoot: z.string().min(1), speechVoice: z.string().min(1) }),
  documentReview: z.strictObject({ executable: z.string().min(1), requestRoot: z.string().min(1), timeoutMs: z.number().int().min(1000).max(600000) }).optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export async function loadConfig(path: string): Promise<AppConfig> {
  const absolutePath: string = resolve(path);
  const parsed: AppConfig = AppConfigSchema.parse(parseJson(await readUtf8(absolutePath), absolutePath));
  return { ...parsed, dataRoot: resolve(dirname(absolutePath), parsed.dataRoot), webRoot: resolve(dirname(absolutePath), parsed.webRoot),
    ...(parsed.documentReview === undefined ? {} : { documentReview: { ...parsed.documentReview,
      executable: resolve(dirname(absolutePath), parsed.documentReview.executable), requestRoot: resolve(dirname(absolutePath), parsed.documentReview.requestRoot) } }),
    pdfFontPath: resolve(dirname(absolutePath), parsed.pdfFontPath), codex: { ...parsed.codex, requestRoot: resolve(dirname(absolutePath), parsed.codex.requestRoot) } };
}
