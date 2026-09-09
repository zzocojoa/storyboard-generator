import { describe, expect, it } from 'vitest';
import { approveShot } from '../src/domain/edit.js';
import { reviewFrameOutput } from '../src/domain/frame-output.js';
import { sourceAnchorRange, updateShotSourceLinks } from '../src/domain/mapping.js';
import type { Asset, Project, Shot, ShotSourceLink, StoryboardFrame } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativePackage } from './helpers.js';

async function visualFixture(): Promise<Project> {
  const base: Project = createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
  const assets: Asset[] = base.frames.map((frame: StoryboardFrame): Asset => ({
    id: `image:${frame.id}`, kind: 'image', subjectId: frame.id, path: `assets/${frame.id}.png`,
    mimeType: 'image/png', sha256: 'a'.repeat(64), description: '검증 이미지', durationMs: null, version: 1,
  }));
  return { ...base, assets, frames: base.frames.map((frame: StoryboardFrame): StoryboardFrame => ({
    ...frame, imageAssetId: `image:${frame.id}`, visualReview: 'accepted',
  })) };
}

function gapProject(project: Project): Project {
  const shot: Shot = project.shots[0] as Shot;
  const links: ShotSourceLink[] = shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => ({ ...link,
    temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs: 1000, basis: 'manual', status: 'confirmed' },
  }));
  return { ...project, shots: project.shots.map((candidate: Shot): Shot => candidate.id === shot.id ? { ...shot, sourceLinks: links } : candidate) };
}

describe('Final 출력 계약 최초 재현', (): void => {
  it('manual_source_edit_cannot_introduce_visual_coverage_gap', async (): Promise<void> => {
    const project: Project = await visualFixture();
    const shot: Shot = project.shots[0] as Shot;
    const gap: Shot = gapProject(project).shots[0] as Shot;
    expect((): Project => updateShotSourceLinks(project, shot.id, { links: gap.sourceLinks })).toThrow();
  });

  it('sourced_gap_blocks_shot_approval', async (): Promise<void> => {
    const project: Project = gapProject(await visualFixture());
    expect((): Project => approveShot(project, (project.shots[0] as Shot).id)).toThrow();
  });

  it('frame_anchor_reveal_does_not_create_one_millisecond_visual', async (): Promise<void> => {
    const project: Project = await visualFixture();
    const shot: Shot = project.shots[0] as Shot;
    const link: ShotSourceLink = { ...(shot.sourceLinks[0] as ShotSourceLink), temporalAnchor: {
      kind: 'frame', frameId: (project.frames[0] as StoryboardFrame).id, basis: 'manual', status: 'confirmed',
    } };
    expect(sourceAnchorRange(project, shot, link)).toBeNull();
  });

  it('hold_previous_source_gap_predecessor_is_not_output_ready', async (): Promise<void> => {
    const base: Project = gapProject(await visualFixture());
    const second: Shot = base.shots[1] as Shot;
    const project: Project = { ...base, shots: base.shots.map((shot: Shot): Shot => shot.id === second.id
      ? { ...shot, visualMode: 'hold-previous', sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => ({ ...link, usage: 'context-only' })) } : shot) };
    const frame: StoryboardFrame = project.frames.find((candidate: StoryboardFrame): boolean => candidate.shotId === second.id) as StoryboardFrame;
    expect(reviewFrameOutput(project, frame.id, 'program-monitor').renderMode).toBe('blocked');
  });
});
