import type { Asset, Project, Shot, ShotSourceLink, StoryboardFrame } from '../src/domain/schema.js';
import { importPackage } from '../src/importers/import-package.js';
import { sha256Bytes } from '../src/importers/integrity.js';
import { createSourceOutline } from '../src/proposal/outline.js';
import { nativePackage, pcmWav, png } from './helpers.js';

export async function readinessOutline(): Promise<Project> {
  return createSourceOutline(importPackage(await nativePackage()), { proposedTextHoldMs: 2000 });
}

export async function readyVisualFixture(): Promise<{ project: Project; bytes: Buffer; integrity: Record<string, string> }> {
  const base: Project = await readinessOutline();
  const bytes: Buffer = await png(2, 2);
  const assets: Asset[] = base.frames.map((frame: StoryboardFrame): Asset => ({
    id: `image:${frame.id}`, kind: 'image', subjectId: frame.id, path: `assets/${frame.id}.png`,
    mimeType: 'image/png', sha256: sha256Bytes(bytes), description: '검증 이미지', durationMs: null, version: 1,
  }));
  const project: Project = { ...base, assets, frames: base.frames.map((frame: StoryboardFrame): StoryboardFrame => ({
    ...frame, imageAssetId: `image:${frame.id}`, visualReview: 'accepted',
  })) };
  return { project, bytes, integrity: Object.fromEntries(assets.map((asset: Asset): [string, string] => [asset.id, 'verified'])) };
}

export function nonSourcedShot(shot: Shot, mode: 'black' | 'hold-previous'): Shot {
  return { ...shot, visualMode: mode, sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => ({ ...link, usage: 'context-only' })) };
}

export function withFirstGap(project: Project, endOffsetMs: number): Project {
  const first: Shot = project.shots[0] as Shot;
  return { ...project, shots: project.shots.map((shot: Shot): Shot => shot.id === first.id ? { ...shot,
    sourceLinks: shot.sourceLinks.map((link: ShotSourceLink): ShotSourceLink => ({ ...link,
      temporalAnchor: { kind: 'shot-offset', startOffsetMs: 0, endOffsetMs, basis: 'manual', status: 'confirmed' },
    })) } : shot) };
}

export async function finalFixture(): Promise<{ project: Project; media: ReadonlyMap<string, Buffer>; integrity: Record<string, string> }> {
  const visual = await readyVisualFixture();
  const audioAssets: Asset[] = visual.project.audioCues.map((cue): Asset => ({ id: `wav:${cue.id}`, kind: 'audio', subjectId: cue.id,
    path: `assets/${cue.id}.wav`, mimeType: 'audio/wav', sha256: sha256Bytes(pcmWav(cue.endMs - cue.startMs, 48000, 1, 16)),
    description: '측정 PCM 검증', durationMs: cue.endMs - cue.startMs, version: 1,
    audioMetadata: { sampleRate: 48000, channels: 1, codec: 'pcm_s16le' } }));
  const project: Project = { ...visual.project, assets: [...visual.project.assets, ...audioAssets],
    shots: visual.project.shots.map((shot: Shot): Shot => ({ ...shot, approvalStatus: 'approved' })),
    audioCues: visual.project.audioCues.map((cue) => ({ ...cue, assetId: `wav:${cue.id}`, timingStatus: 'measured' as const })) };
  const media: Map<string, Buffer> = new Map(visual.project.assets.map((asset: Asset): [string, Buffer] => [asset.id, visual.bytes]));
  for (const asset of audioAssets) media.set(asset.id, pcmWav(asset.durationMs as number, 48000, 1, 16));
  return { project, media, integrity: Object.fromEntries(project.assets.map((asset: Asset): [string, string] => [asset.id, 'verified'])) };
}
