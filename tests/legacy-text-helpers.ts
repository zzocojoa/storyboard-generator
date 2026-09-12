import type { Project } from '../src/domain/schema.js';

/** 이전 저장 형식 검증에는 당시 존재하지 않던 조판 필드를 넣지 않는다. */
export function legacyTextProject(project: Project): Omit<Project, 'textLayout' | 'textReadability' | 'textLayoutControl'> {
  const { textLayout: _textLayout, textReadability: _textReadability, textLayoutControl: _control, ...legacy } = project;
  return legacy;
}
