import sharp from 'sharp';
import { createSegmentPlanBasis } from '../src/automation/plan-basis.js';
import { compileAutomaticSegmentPlan } from '../src/automation/plan-compiler.js';
import { addStoryboardFrame } from '../src/domain/frame.js';
import type { Asset, Project } from '../src/domain/schema.js';
import { sha256Bytes } from '../src/importers/integrity.js';
import type { AssetWrite } from '../src/server/store.js';
import { automaticPlanProject, automaticPlanProvenance, demonstrationPlan, stagedPlanSpeech } from './automatic-plan-helpers.js';

export async function producerPlaybackFixture(): Promise<{ source: Project; project: Project; writes: AssetWrite[]; shotId: string }> {
  const source: Project = await automaticPlanProject();
  const prepared = compileAutomaticSegmentPlan(source, createSegmentPlanBasis(source, 'demonstration', ['shot-2']), demonstrationPlan(source), [stagedPlanSpeech(source)], [], automaticPlanProvenance(), 64);
  const shotId: string = prepared.project.shots.find((shot): boolean => shot.segmentId === 'demonstration')!.id;
  const key = addStoryboardFrame(prepared.project, shotId, 'review-key', { role: 'key', offsetMs: 3000, description: '중간 동작 검토' });
  const project: Project = addStoryboardFrame(key, shotId, 'review-end', { role: 'end', offsetMs: 8500, description: '마지막 동작 검토' });
  const images: Asset[] = []; const writes: AssetWrite[] = [...prepared.writes];
  for (const [index, frame] of project.frames.filter((value): boolean => value.shotId === shotId).entries()) {
    const bytes: Buffer = await sharp({ create: { width: 90, height: 160, channels: 3, background: ['#667749', '#987123', '#304567'][index]! } }).png().toBuffer();
    const asset: Asset = { id: `${frame.id}:review-image`, kind: 'image', subjectId: frame.id, path: `assets/review-${index}.png`, mimeType: 'image/png', sha256: sha256Bytes(bytes), description: '합성 검증 그림', durationMs: null, version: 1 };
    images.push(asset); writes.push({ relativePath: asset.path, content: bytes });
  }
  return { source, shotId, writes, project: { ...project, assets: [...project.assets, ...images], frames: project.frames.map((frame) => {
    const asset = images.find((image): boolean => image.subjectId === frame.id);
    return asset === undefined ? frame : { ...frame, imageAssetId: asset.id, visualReview: 'pending' };
  }) } };
}
