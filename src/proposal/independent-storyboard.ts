import { IndependentStoryboardInputSchema } from '../domain/storyboard-creation.js';
import type { IndependentStoryboardInput } from '../domain/storyboard-creation.js';
import { ProjectSchema } from '../domain/schema.js';
import type { Project } from '../domain/schema.js';
import { sha256Text } from '../importers/integrity.js';
import { createSourceOutline } from './outline.js';

/** 검증한 패키지에서 새 초안만 만들고 원본 ID·문서·기존 콘티의 편집 내용은 변경하지 않는다. */
export function createIndependentStoryboard(source: Project, input: IndependentStoryboardInput): Project {
  const settings: IndependentStoryboardInput = IndependentStoryboardInputSchema.parse(input);
  const outline: Project = createSourceOutline(source, { proposedTextHoldMs: settings.proposedTextHoldMs });
  return ProjectSchema.parse({ ...outline, projectId: `storyboard:${settings.storyboardId}`, title: settings.name,
    storyboardIdentity: { sourceProjectId: source.handoff.projectId,
      creationFingerprint: sha256Text(JSON.stringify({ handoff: source.handoff, name: settings.name, proposedTextHoldMs: settings.proposedTextHoldMs })) },
  });
}
