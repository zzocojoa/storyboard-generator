import type { Project } from '../domain/schema.js';
import { parseProject } from '../io/project.js';

export function exportProjectJson(project: Project): string {
  return `${JSON.stringify(parseProject(project), null, 2)}\n`;
}
