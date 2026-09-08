import { z } from 'zod';
import { REQUEST_JOURNAL_VERSION, REQUEST_LOCK_VERSION } from './codex/storage-contract.js';
import { GeneratorBuildProvenanceSchema } from './domain/schema.js';

export const BuildManifestSchema = GeneratorBuildProvenanceSchema.extend({
  provenanceVersion: z.literal(3), gitStateAvailable: z.boolean(), worktreeDirty: z.boolean().nullable(), generationInputsDirty: z.boolean().nullable(),
  sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u), generationContractSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  runtimeGenerationConfigSha256: z.string().regex(/^[a-f0-9]{64}$/u), builtAt: z.iso.datetime(),
  requestJournalVersion: z.literal(REQUEST_JOURNAL_VERSION), requestLockVersion: z.literal(REQUEST_LOCK_VERSION),
  journalVersion: z.literal(3), lockVersion: z.literal(3), registryVersion: z.literal(1),
}).superRefine((build, context): void => {
  if (build.gitStateAvailable && (build.headCommitSha === null || build.worktreeDirty === null || build.generationInputsDirty === null)) {
    context.addIssue({ code: 'custom', path: ['gitStateAvailable'], message: '확인된 Git 상태에는 HEAD와 두 Dirty 값이 필요합니다.' });
  }
  if (!build.gitStateAvailable && (build.worktreeDirty !== null || build.generationInputsDirty !== null)) {
    context.addIssue({ code: 'custom', path: ['gitStateAvailable'], message: 'Git 상태 확인 실패 시 Dirty 상태는 null이어야 합니다.' });
  }
});
export type BuildManifest = z.infer<typeof BuildManifestSchema>;
