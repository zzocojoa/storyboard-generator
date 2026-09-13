import { TextFontRegistrationsSchema } from '../domain/text-typography.js';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { AudioNormalizationWorkerOptionsSchema } from '../domain/audio-normalizer.js';
import { parseJson } from '../importers/integrity.js';
import { readUtf8 } from '../io/package.js';

export const AppConfigSchema = z.strictObject({
  host: z.literal('127.0.0.1'), port: z.number().int().min(1024).max(65535),
  dataRoot: z.string().min(1), webRoot: z.string().min(1), pdfFontPath: z.string().min(1),
  audioNormalization: AudioNormalizationWorkerOptionsSchema, textFonts: TextFontRegistrationsSchema.optional(),
  codex: z.strictObject({ requestRoot: z.string().min(1), speechVoice: z.string().min(1) }),
  documentReview: z.strictObject({ executable: z.string().min(1), requestRoot: z.string().min(1), timeoutMs: z.number().int().min(1000).max(600000) }).optional(),
  automation: z.strictObject({ root: z.string().min(1), codexExecutable: z.string().min(1), sayExecutable: z.string().min(1), audioConvertExecutable: z.string().min(1), minimumFreeBytes: z.number().int().min(268435456).max(1099511627776) }).optional(),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export async function loadConfig(path: string): Promise<AppConfig> {
  const absolutePath: string = resolve(path);
  const parsed: AppConfig = AppConfigSchema.parse(parseJson(await readUtf8(absolutePath), absolutePath));
  return { ...parsed, dataRoot: resolve(dirname(absolutePath), parsed.dataRoot), webRoot: resolve(dirname(absolutePath), parsed.webRoot),
    ...(parsed.automation === undefined ? {} : { automation: { minimumFreeBytes: parsed.automation.minimumFreeBytes, root: resolve(dirname(absolutePath), parsed.automation.root), codexExecutable: resolve(dirname(absolutePath), parsed.automation.codexExecutable),
      sayExecutable: resolve(dirname(absolutePath), parsed.automation.sayExecutable), audioConvertExecutable: resolve(dirname(absolutePath), parsed.automation.audioConvertExecutable) } }),
    ...(parsed.documentReview === undefined ? {} : { documentReview: { ...parsed.documentReview,
      executable: resolve(dirname(absolutePath), parsed.documentReview.executable), requestRoot: resolve(dirname(absolutePath), parsed.documentReview.requestRoot) } }),
    ...(parsed.textFonts === undefined ? {} : { textFonts: parsed.textFonts.map((font) => ({ ...font, path: resolve(dirname(absolutePath), font.path) })) }),
    pdfFontPath: resolve(dirname(absolutePath), parsed.pdfFontPath), codex: { ...parsed.codex, requestRoot: resolve(dirname(absolutePath), parsed.codex.requestRoot) } };
}
