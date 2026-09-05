import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { parseJson } from '../importers/integrity.js';
import { readUtf8 } from '../io/package.js';

export const AppConfigSchema = z.strictObject({
  host: z.literal('127.0.0.1'), port: z.number().int().min(1024).max(65535),
  dataRoot: z.string().min(1), webRoot: z.string().min(1), pdfFontPath: z.string().min(1),
  generation: z.strictObject({
    proposalModel: z.string().min(1), imageModel: z.string().min(1), imageQuality: z.enum(['low', 'medium', 'high']),
    speechModel: z.string().min(1), speechVoice: z.string().min(1), speechInstructions: z.string().min(1),
    requestTimeoutMs: z.number().int().positive(), retryCount: z.number().int().nonnegative().max(8), retryBackoffMs: z.number().int().nonnegative(),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export async function loadConfig(path: string): Promise<AppConfig> {
  const absolutePath: string = resolve(path);
  const parsed: AppConfig = AppConfigSchema.parse(parseJson(await readUtf8(absolutePath), absolutePath));
  return { ...parsed, dataRoot: resolve(dirname(absolutePath), parsed.dataRoot), webRoot: resolve(dirname(absolutePath), parsed.webRoot), pdfFontPath: resolve(dirname(absolutePath), parsed.pdfFontPath) };
}
