import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import { ProjectStore } from '../src/server/store.js';
import { sha256Text } from '../src/importers/integrity.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from './automatic-plan-helpers.js';

it('automation_candidate_commits_plan_and_measured_media_in_one_revision_and_rejects_stale_apply', async (): Promise<void> => {
  const root: string = await mkdtemp(join(tmpdir(), 'cutroom-automatic-candidate-'));
  const store: ProjectStore = new ProjectStore(root);
  try {
    const original = await automaticPlanProject(); await store.create(original);
    const basis = createSegmentPlanBasis(original, 'demonstration', ['shot-2']);
    const plan = demonstrationPlan(original); const staged = [stagedPlanSpeech(original)]; const provenance = automaticPlanProvenance();
    const candidate = compileAutomaticSegmentPlan(original, basis, plan, staged, [], provenance, 64);
    const applied = await store.update(original.projectId, original.revision, (current) => compileAutomaticSegmentPlan(current, basis, plan, staged, [], provenance, 64).project, candidate.writes);
    expect(applied.revision).toBe(1);
    expect(applied.assets).toHaveLength(1); expect(applied.generationRecords).toHaveLength(2);
    expect(applied.dataset).toEqual(original.dataset);
    const saved = JSON.parse(await readFile(join(root, sha256Text(original.projectId), 'project.json'), 'utf8')) as unknown;
    expect(saved).toEqual(applied);
    expect(await readFile(join(root, sha256Text(original.projectId), candidate.writes[0]!.relativePath))).toEqual(candidate.writes[0]!.content);
    await expect(store.update(original.projectId, original.revision, (current) => compileAutomaticSegmentPlan(current, basis, plan, staged, [], provenance, 64).project, candidate.writes)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const previous = JSON.parse(await readFile(join(root, sha256Text(original.projectId), 'versions', '000000.json'), 'utf8')) as unknown;
    expect(previous).toEqual(original);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});
