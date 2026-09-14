import type { ReactElement, ReactNode } from 'react';
import type { Project, Shot } from '../../src/domain/schema.js';
import { activeStoryboardShot } from '../../src/domain/playback.js';
import { transitionVisualPolicy } from '../../src/domain/transition.js';
import type { TransitionVisualPolicy } from '../../src/domain/transition.js';

export type VisualComposition = {
  shot: Shot | null; nextShot: Shot | undefined; transitionPolicy: TransitionVisualPolicy | null;
  transitionActive: boolean; incomingActive: boolean; transitionProgress: number;
  currentOpacity: number; nextOpacity: number; nextClip: string;
};

/** 저장된 재생 화면과 미저장 글자 검토에 같은 전환 노출·합성 값을 적용한다. */
export function visualCompositionAt(project: Project, atMs: number): VisualComposition {
  const shot: Shot | null = activeStoryboardShot(project, atMs);
  const shotIndex: number = shot === null ? -1 : project.shots.findIndex((candidate): boolean => candidate.id === shot.id);
  const nextShot: Shot | undefined = shotIndex < 0 ? undefined : project.shots[shotIndex + 1];
  const transitionPolicy: TransitionVisualPolicy | null = shot === null ? null : transitionVisualPolicy(shot.transitionOut, shot, nextShot ?? null);
  const transitionStart: number = transitionPolicy?.transitionStartMs ?? 0;
  const transitionActive: boolean = shot !== null && shot.transitionOut.kind !== 'cut' && shot.transitionOut.durationMs > 0 && atMs >= transitionStart && atMs < shot.endMs;
  const incomingActive: boolean = transitionPolicy !== null && transitionPolicy.incomingRevealMs !== null && atMs >= transitionPolicy.incomingRevealMs && atMs < transitionPolicy.transitionEndMs;
  const throughBlack: boolean = transitionPolicy?.incomingExposure === 'after-black-midpoint';
  const transitionProgress: number = transitionActive && shot !== null ? (atMs - transitionStart) / shot.transitionOut.durationMs : 0;
  return { shot, nextShot, transitionPolicy, transitionActive, incomingActive, transitionProgress,
    currentOpacity: transitionActive && shot?.transitionOut.kind !== 'wipe' ? Math.max(0, 1 - transitionProgress * (throughBlack ? 2 : 1)) : 1,
    nextOpacity: throughBlack ? Math.max(0, transitionProgress * 2 - 1) : shot?.transitionOut.kind === 'match-cut' ? (transitionProgress >= .5 ? 1 : 0) : transitionProgress,
    nextClip: shot?.transitionOut.kind === 'wipe' ? `inset(0 ${100 - transitionProgress * 100}% 0 0)` : 'none' };
}

export function VisualCompositionStage(props: { aspectWidth: number; aspectHeight: number; composition: VisualComposition;
  current: ReactNode; incoming: ReactNode; children: ReactNode }): ReactElement {
  const aspect: number = props.aspectWidth / props.aspectHeight;
  return <div className="monitor-stage"><div className="monitor-frame" style={{ width: `min(100cqw, calc(100cqh * ${aspect}))`, height: `min(100cqh, calc(100cqw / ${aspect}))` }}>
    <div className="monitor-layer" style={{ opacity: props.composition.currentOpacity }}>{props.current}</div>
    {props.composition.incomingActive && props.composition.nextShot !== undefined && props.incoming !== null && <div className="monitor-layer next" style={{ opacity: props.composition.nextOpacity, clipPath: props.composition.nextClip }}>{props.incoming}</div>}
    {props.children}
  </div></div>;
}
