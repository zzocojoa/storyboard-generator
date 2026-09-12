import { legacyTextProject } from './legacy-text-helpers.js';
import { describe, expect, it } from 'vitest';
import { auditGenerationRecords } from '../src/domain/generation-records.js';
import type { GenerationRecord, Project } from '../src/domain/schema.js';
import { applyGeneratedImage } from '../src/domain/media.js';
import { parseProject } from '../src/io/project.js';
import { png, testGeneratorBuild } from './helpers.js';
import { readinessOutline } from './readiness-fixtures.js';

function record(project: Project): GenerationRecord {
  return { id: 'audited', provider: 'codex-app', model: 'current', modelVersion: null, generatorBuild: null,
    requestId: 'audit-request', prompt: '검토 원본', templateVersion: '1', seed: null, referenceHashes: [], resultAssetIds: [],
    shotIds: [project.shots[0]!.id], createdAt: '2026-09-07T00:00:00.000Z' };
}
async function history(): Promise<Project[]> {
  const project: Project = await readinessOutline(); const original: GenerationRecord = record(project);
  return [0, 1, 2, 3, 4, 5].map((revision: number): Project => ({ ...project, revision,
    generationRecords: revision === 1 || revision === 4 ? [] : [{ ...original, prompt: revision === 3 ? '변경됨' : original.prompt }] }));
}

describe('Canonical Generation Audit', (): void => {
  it('audit_deduplicates_current_revision_snapshot', async (): Promise<void> => {
    const versions: Project[] = await history(); expect(auditGenerationRecords(versions[5]!, [...versions, versions[5]!])[0]?.observedRevisions).toEqual([0, 2, 3, 5]);
  });
  it('audit_rejects_stable_current_version_mismatch', async (): Promise<void> => {
    const versions: Project[] = await history(); const current: Project = { ...versions[5]!, title: '안정적으로 다른 Current' };
    expect(() => auditGenerationRecords(current, versions)).toThrowError(expect.objectContaining({ code: 'AUDIT_CURRENT_VERSION_MISMATCH' }));
  });
  it('audit_records_only_absent_to_present_reappearance', async (): Promise<void> => {
    const versions: Project[] = await history(); expect(auditGenerationRecords(versions[5]!, versions)[0]?.reappearedAtRevisions).toEqual([2, 5]);
  });
  it('audit_does_not_repeat_reappearance_for_continuous_presence', async (): Promise<void> => {
    const versions: Project[] = await history(); expect(auditGenerationRecords(versions[3]!, versions.slice(0, 4))[0]?.reappearedAtRevisions).toEqual([2]);
  });
  it('audit_target_history_starts_at_introduced_revision', async (): Promise<void> => {
    const base: Project = await readinessOutline(); const initial: Project = { ...base, generationRecords: [] };
    const introduced: Project = { ...base, revision: 1, shots: base.shots.slice(1), generationRecords: [record(base)] };
    const result = auditGenerationRecords(introduced, [initial, introduced])[0]; expect(result?.shotTargets[0]?.state).toBe('unresolved'); expect(result?.validAtIntroduction).toBe(false);
  });
  it('invalid_introduction_target_is_unresolved_not_historical', async (): Promise<void> => {
    const base: Project = await readinessOutline(); const introduced: Project = { ...base, shots: base.shots.slice(1), generationRecords: [record(base)] };
    const returned: Project = { ...base, revision: 1, generationRecords: introduced.generationRecords };
    expect(auditGenerationRecords(returned, [introduced, returned])[0]?.shotTargets[0]?.state).toBe('unresolved');
  });
  it('audit_revision_arrays_are_unique_and_sorted', async (): Promise<void> => {
    const versions: Project[] = await history(); const result = auditGenerationRecords(versions[5]!, [...versions].reverse().concat(versions))[0];
    for (const revisions of [result!.observedRevisions, result!.mutatedAtRevisions, result!.reappearedAtRevisions]) expect(revisions).toEqual([...new Set(revisions)].sort((a: number, b: number): number => a - b));
  });
  it('audit_still_detects_removed_mutated_and_reappeared_records', async (): Promise<void> => {
    const versions: Project[] = await history(); expect(auditGenerationRecords(versions[5]!, versions)[0]).toMatchObject({ removedAtRevision: 1, mutatedAtRevisions: [3], reappearedAtRevisions: [2, 5], recordIntegrityState: 'legacy-mutated', recordPresenceState: 'legacy-reappeared' });
  });
  it('new_generation_record_contains_build_provenance', async (): Promise<void> => {
    const project: Project = await readinessOutline(); const build = { ...testGeneratorBuild(), commitSha: 'b'.repeat(40), sourceTreeSha256: 'c'.repeat(64) };
    const result = await applyGeneratedImage(project, project.frames[0]!.id, 'built-image', '2026-09-07T00:00:00.000Z', { generatorBuild: build, provider: 'codex-app', model: 'imagegen', requestId: 'build-request', prompt: '검증', bytes: await png(2, 2), mimeType: 'image/png', referenceHashes: [] });
    expect(result.project.generationRecords[0]?.generatorBuild).toEqual(build);
    expect(result.project.generationRecords[0]?.resultAssetIds).toEqual([result.project.assets[0]?.id]);
  });
  it('legacy_generation_record_migrates_build_to_null', async (): Promise<void> => {
    const project: Project = await readinessOutline(); const { generatorBuild: omitted, ...legacy } = record(project); expect(omitted).toBeNull();
    const migrated: Project = parseProject({ ...legacyTextProject(project), schemaVersion: '1.6.0', generationRecords: [legacy] });
    expect(migrated.generationRecords).toEqual([{ ...legacy, generatorBuild: null }]); expect(migrated.schemaVersion).toBe('1.22.0'); expect(parseProject(migrated)).toEqual(migrated);
  });
});
