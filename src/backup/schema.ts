import { z } from 'zod';
import { HashSchema, IdSchema } from '../domain/schema.js';

export const BACKUP_MAX_BYTES: number = 512 * 1024 * 1024;
export const BACKUP_MAX_FILES: number = 20_000;
export const BACKUP_JSON_MAX_BYTES: number = 32 * 1024 * 1024;
export const BackupFileSchema = z.strictObject({ path: z.string().min(1).max(1024), size: z.number().int().positive(), sha256: HashSchema });
export type BackupFile = z.infer<typeof BackupFileSchema>;
export const BackupManifestSchema = z.strictObject({
  artifactType: z.literal('cutroom-project-backup'), artifactVersion: z.literal('1.0.0'),
  scope: z.literal('committed-project-history'), projectId: IdSchema, title: z.string(), revision: z.number().int().min(0).max(999999),
  createdAt: z.iso.datetime(), files: z.array(BackupFileSchema).min(2).max(BACKUP_MAX_FILES),
});
export type BackupManifest = z.infer<typeof BackupManifestSchema>;
export const BackupSelectionSchema = z.strictObject({
  parentPath: z.string().trim().min(1).max(4096), folderName: z.string().trim().min(1).max(120).regex(/^[\p{L}\p{N}_-][\p{L}\p{N}_. -]*$/u),
});
export type BackupSelection = z.infer<typeof BackupSelectionSchema>;
export const BackupPreviewSchema = z.strictObject({
  manifest: BackupManifestSchema, basisSha256: HashSchema, outputPath: z.string(), totalBytes: z.number().int().positive(),
  versions: z.number().int().positive(), assets: z.number().int().nonnegative(),
});
export type BackupPreview = z.infer<typeof BackupPreviewSchema>;
export const BackupResultSchema = z.strictObject({ outputPath: z.string(), manifestSha256: HashSchema, manifest: BackupManifestSchema });
export type BackupResult = z.infer<typeof BackupResultSchema>;
