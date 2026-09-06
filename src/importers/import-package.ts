import { assertNoErrors, contractError } from '../domain/errors.js';
import { createInitialTextMappingDecisions } from '../domain/mapping.js';
import { createInitialPlacementInformationDecisions } from '../domain/placement-information.js';
import { DatasetSchema, ProjectSchema } from '../domain/schema.js';
import type { Dataset, Issue, Project, TextMappingDecision, TextPlacementInformationDecision } from '../domain/schema.js';
import { validateTimebase } from '../domain/time.js';
import { validateDataset } from '../domain/validation.js';
import { validatePackage } from './integrity.js';
import { importNative } from './native.js';
import { importProduction } from './production.js';

export function importPackage(input: unknown): Project {
  const { payload, snapshots } = validatePackage(input);
  assertNoErrors(validateTimebase(payload.handoff.timebase), 'INVALID_TIMEBASE');
  const normalized: { dataset: Dataset; issues: Issue[] } = payload.handoff.adapter === 'native-v1'
    ? { dataset: importNative(payload.handoff, snapshots), issues: [] }
    : importProduction(payload.handoff, snapshots);
  const initialDataset: Dataset = DatasetSchema.parse(normalized.dataset);
  const textMappingDecisions: TextMappingDecision[] = createInitialTextMappingDecisions(initialDataset);
  const textPlacementInformationDecisions: TextPlacementInformationDecision[] = createInitialPlacementInformationDecisions(textMappingDecisions);
  const dataset: Dataset = initialDataset;
  if (dataset.projectId !== payload.handoff.projectId) throw contractError('PROJECT_MISMATCH', `handoff=${payload.handoff.projectId}, dataset=${dataset.projectId}`, []);
  const issues: Issue[] = [...normalized.issues, ...validateDataset(dataset, snapshots)];
  assertNoErrors(issues, 'INVALID_SOURCE_DATASET');
  return ProjectSchema.parse({
    schemaVersion: '1.5.0', projectId: dataset.projectId, title: dataset.title, revision: 0, profile: payload.handoff.profile,
    handoff: payload.handoff, sources: snapshots, dataset, importIssues: issues,
    textMappingDecisions, textPlacementInformationDecisions, shots: [], frames: [], audioCues: [], textCues: [], assets: [], generationRecords: [],
  });
}

export function recoverSourceProject(project: Project): Project {
  return importPackage({ handoff: project.handoff, files: project.sources.map((file) => ({ path: file.path, content: file.content })) });
}
