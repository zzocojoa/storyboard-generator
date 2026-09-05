import { issue } from './errors.js';
import type { Dataset, Issue, Project, Segment, Snapshot, SourceRef, SourceUnit } from './schema.js';

function duplicateIssues(ids: readonly string[], entity: string): Issue[] {
  return [...new Set(ids.filter((id: string, index: number): boolean => ids.indexOf(id) !== index))]
    .map((id: string): Issue => issue('DUPLICATE_ID', 'error', id, entity, '같은 프로젝트 안에서 ID가 중복되었습니다.', null, id, []));
}

function referenceIssue(exists: boolean, entityId: string, field: string, value: string, refs: readonly SourceRef[]): Issue[] {
  return exists ? [] : [issue('UNKNOWN_REFERENCE', 'error', entityId, field, '참조 대상을 찾을 수 없습니다.', null, value, refs)];
}

function intervalIssues(entityId: string, start: number, end: number, parentStart: number, parentEnd: number): Issue[] {
  return end > start && start >= parentStart && end <= parentEnd ? [] : [issue('INVALID_INTERVAL', 'error', entityId, 'timing', '시간 범위가 비어 있거나 허용 범위를 벗어났습니다.', `${parentStart}..${parentEnd}`, `${start}..${end}`, [])];
}

function validateSegmentOrder(segments: readonly Segment[]): Issue[] {
  return segments.flatMap((segment: Segment, index: number): Issue[] => {
    const previous: Segment | undefined = segments[index - 1];
    const expectedStart: number = previous?.endMs ?? 0;
    return segment.startMs === expectedStart ? [] : [issue('TIMELINE_GAP_OR_OVERLAP', 'error', segment.id, 'startMs', '방송 구간은 시작 0부터 순서대로 공백과 겹침 없이 연결돼야 합니다.', String(expectedStart), String(segment.startMs), segment.sourceRefs)];
  });
}

export function validateDataset(dataset: Dataset, snapshots: readonly Snapshot[]): Issue[] {
  const totalEnd: number = dataset.segments.at(-1)?.endMs ?? 0;
  const groups: { name: string; ids: string[] }[] = [
    { name: 'people', ids: dataset.people.map((value): string => value.id) },
    { name: 'locations', ids: dataset.locations.map((value): string => value.id) },
    { name: 'scenes', ids: dataset.scenes.map((value): string => value.id) },
    { name: 'segments', ids: dataset.segments.map((value): string => value.id) },
    { name: 'units', ids: dataset.units.map((value): string => value.id) },
    { name: 'informationRules', ids: dataset.informationRules.map((value): string => value.id) },
    { name: 'instructions', ids: dataset.instructions.map((value): string => value.id) },
    { name: 'textPlacements', ids: dataset.textPlacements.map((value): string => value.id) },
  ];
  const sourceEntities: { id: string; sourceRefs: SourceRef[] }[] = [
    ...dataset.people, ...dataset.locations, ...dataset.scenes, ...dataset.segments, ...dataset.units,
    ...dataset.informationRules, ...dataset.instructions, ...dataset.textPlacements,
  ];
  const sourceIssues: Issue[] = sourceEntities.flatMap((entity): Issue[] => entity.sourceRefs.flatMap((ref: SourceRef): Issue[] => referenceIssue(snapshots.some((snapshot: Snapshot): boolean => snapshot.id === ref.fileId), entity.id, 'sourceRefs', ref.fileId, [ref])));
  const sceneIssues: Issue[] = dataset.scenes.flatMap((scene): Issue[] => [
    ...(scene.storyLocationId === null ? [] : referenceIssue(dataset.locations.some((location): boolean => location.id === scene.storyLocationId), scene.id, 'storyLocationId', scene.storyLocationId, scene.sourceRefs)),
    ...scene.declaredCastIds.flatMap((id: string): Issue[] => referenceIssue(dataset.people.some((person): boolean => person.id === id), scene.id, 'declaredCastIds', id, scene.sourceRefs)),
  ]);
  const segmentIssues: Issue[] = dataset.segments.flatMap((segment): Issue[] => [
    ...referenceIssue(dataset.scenes.some((scene): boolean => scene.id === segment.sceneId), segment.id, 'sceneId', segment.sceneId, segment.sourceRefs),
    ...intervalIssues(segment.id, segment.startMs, segment.endMs, 0, totalEnd),
    ...duplicateIssues(dataset.units.filter((unit): boolean => unit.segmentId === segment.id).map((unit): string => String(unit.order)), `${segment.id}.unitOrder`),
  ]);
  const unitIssues: Issue[] = dataset.units.flatMap((unit: SourceUnit): Issue[] => {
    const segment: Segment | undefined = dataset.segments.find((candidate): boolean => candidate.id === unit.segmentId);
    const speakerRequired: boolean = ['DIALOGUE', 'NARRATION', 'PANEL'].includes(unit.kind);
    const speakerProhibited: boolean = ['ACTION', 'SOUND', 'MUSIC', 'SCREEN_TEXT'].includes(unit.kind);
    return [
      ...referenceIssue(segment !== undefined, unit.id, 'segmentId', unit.segmentId, unit.sourceRefs),
      ...(unit.speakerId === null ? [] : referenceIssue(dataset.people.some((person): boolean => person.id === unit.speakerId), unit.id, 'speakerId', unit.speakerId, unit.sourceRefs)),
      ...((speakerRequired && unit.speakerId === null) || (speakerProhibited && unit.speakerId !== null) ? [issue('INVALID_UNIT_SPEAKER', 'error', unit.id, 'speakerId', '원문 유형과 화자 선언이 맞지 않습니다.', speakerRequired ? '화자 ID' : 'null', unit.speakerId, unit.sourceRefs)] : []),
      ...unit.informationIds.flatMap((id: string): Issue[] => {
        const rule = dataset.informationRules.find((candidate): boolean => candidate.id === id);
        if (rule === undefined) return [issue('UNRESOLVED_INFORMATION_RULE', 'warning', unit.id, 'informationIds', '공개 시점 정의가 없는 정보 참조입니다. 공개 범위 검토가 필요합니다.', null, id, unit.sourceRefs)];
        return segment !== undefined && segment.startMs < rule.notBeforeMs ? [issue('SOURCE_REVEAL_CONFLICT', 'conflict', unit.id, 'informationIds', '원문의 정보 참조가 선언된 공개 시점보다 앞섭니다.', String(rule.notBeforeMs), String(segment.startMs), [...unit.sourceRefs, ...rule.sourceRefs])] : [];
      }),
    ];
  });
  const instructionIssues: Issue[] = dataset.instructions.flatMap((instruction): Issue[] => referenceIssue(dataset.segments.some((segment): boolean => segment.id === instruction.segmentId), instruction.id, 'segmentId', instruction.segmentId, instruction.sourceRefs));
  const placementIssues: Issue[] = dataset.textPlacements.flatMap((placement): Issue[] => {
    const segment = dataset.segments.find((candidate): boolean => candidate.id === placement.segmentId);
    const unit = placement.unitId === null ? null : dataset.units.find((candidate): boolean => candidate.id === placement.unitId);
    return [
      ...referenceIssue(segment !== undefined, placement.id, 'segmentId', placement.segmentId, placement.sourceRefs),
      ...(placement.unitId === null ? [] : referenceIssue(unit !== undefined && unit !== null && unit.segmentId === placement.segmentId, placement.id, 'unitId', placement.unitId, placement.sourceRefs)),
      ...(segment !== undefined && (placement.startMs < segment.startMs || placement.startMs >= segment.endMs || (placement.endMs !== null && (placement.endMs <= placement.startMs || placement.endMs > segment.endMs))) ? [issue('TEXT_PLACEMENT_TIME', 'error', placement.id, 'startMs', '자막 위치가 지정 구간 밖입니다.', `${segment.startMs}..${segment.endMs}`, String(placement.startMs), placement.sourceRefs)] : []),
      ...(unit !== null && unit !== undefined && unit.text !== placement.text ? [issue('SCREEN_TEXT_CONFLICT', 'conflict', placement.id, 'text', '원문 문구와 연결된 자막 문구가 다릅니다.', unit.text, placement.text, [...unit.sourceRefs, ...placement.sourceRefs])] : []),
    ];
  });
  return [...groups.flatMap((group): Issue[] => duplicateIssues(group.ids, group.name)), ...sourceIssues, ...sceneIssues, ...segmentIssues, ...validateSegmentOrder(dataset.segments), ...unitIssues, ...instructionIssues, ...placementIssues];
}

export function validateProject(project: Project, expectedDataset: Dataset): Issue[] {
  const dataset: Dataset = project.dataset;
  const totalEnd: number = dataset.segments.at(-1)?.endMs ?? 0;
  const sourceIssues: Issue[] = JSON.stringify(dataset) === JSON.stringify(expectedDataset) ? [] : [issue('SOURCE_DATASET_MODIFIED', 'error', project.projectId, 'dataset', '원본 데이터가 변경되었습니다. 새 패키지로 가져온 후 변경안을 검토하세요.', null, null, [])];
  const projectIssues: Issue[] = project.projectId === dataset.projectId && project.projectId === project.handoff.projectId ? [] : [issue('PROJECT_MISMATCH', 'error', project.projectId, 'projectId', '프로젝트와 입력 패키지의 ID가 다릅니다.', dataset.projectId, project.projectId, [])];
  const groups = [
    { name: 'shots', ids: project.shots.map((value): string => value.id) },
    { name: 'frames', ids: project.frames.map((value): string => value.id) },
    { name: 'audioCues', ids: project.audioCues.map((value): string => value.id) },
    { name: 'textCues', ids: project.textCues.map((value): string => value.id) },
    { name: 'assets', ids: project.assets.map((value): string => value.id) },
    { name: 'generationRecords', ids: project.generationRecords.map((value): string => value.id) },
  ];
  const shotIssues: Issue[] = project.shots.flatMap((shot): Issue[] => {
    const segment = dataset.segments.find((value): boolean => value.id === shot.segmentId);
    return [
      ...referenceIssue(segment !== undefined, shot.id, 'segmentId', shot.segmentId, []),
      ...duplicateIssues(shot.sourceUnitIds, `${shot.id}.sourceUnitIds`),
      ...duplicateIssues(shot.propIds, `${shot.id}.propIds`),
      ...duplicateIssues(shot.informationIds, `${shot.id}.informationIds`),
      ...duplicateIssues(shot.lockedFields, `${shot.id}.lockedFields`),
      ...duplicateIssues(shot.continuityBefore.map((state): string => state.assetId), `${shot.id}.continuityBefore`),
      ...duplicateIssues(shot.continuityAfter.map((state): string => state.assetId), `${shot.id}.continuityAfter`),
      ...(segment === undefined ? [] : intervalIssues(shot.id, shot.startMs, shot.endMs, segment.startMs, segment.endMs)),
      ...shot.sourceUnitIds.flatMap((id: string): Issue[] => referenceIssue(dataset.units.some((unit): boolean => unit.id === id && unit.segmentId === shot.segmentId), shot.id, 'sourceUnitIds', id, [])),
      ...(shot.visualLocationId === null ? [] : referenceIssue(dataset.locations.some((location): boolean => location.id === shot.visualLocationId), shot.id, 'visualLocationId', shot.visualLocationId, [])),
      ...shot.presence.flatMap((presence): Issue[] => referenceIssue(dataset.people.some((person): boolean => person.id === presence.personId), shot.id, 'presence', presence.personId, [])),
      ...shot.propIds.flatMap((id: string): Issue[] => referenceIssue(project.assets.some((asset): boolean => asset.id === id && asset.kind === 'prop'), shot.id, 'propIds', id, [])),
      ...[...shot.continuityBefore, ...shot.continuityAfter].flatMap((state): Issue[] => referenceIssue(project.assets.some((asset): boolean => asset.id === state.assetId && ['character', 'location', 'prop'].includes(asset.kind)), shot.id, 'continuity', state.assetId, [])),
      ...(project.frames.some((frame): boolean => frame.shotId === shot.id) ? [] : [issue('SHOT_WITHOUT_FRAME', 'error', shot.id, 'frames', '컷에는 검토용 프레임이 하나 이상 필요합니다.', null, null, [])]),
      ...((shot.transitionOut.kind === 'cut' && shot.transitionOut.durationMs !== 0) || (shot.transitionOut.kind !== 'cut' && (shot.transitionOut.durationMs <= 0 || shot.transitionOut.durationMs > shot.endMs - shot.startMs)) ? [issue('INVALID_TRANSITION_DURATION', 'error', shot.id, 'transitionOut', 'CUT은 0ms, 그 밖의 전환은 컷 길이 안의 양수 밀리초여야 합니다.', `0..${shot.endMs - shot.startMs}`, String(shot.transitionOut.durationMs), [])] : []),
      ...(shot.transitionOut.kind === 'custom' && shot.transitionOut.note.trim() === '' ? [issue('MISSING_CUSTOM_TRANSITION_NOTE', 'error', shot.id, 'transitionOut.note', '사용자 정의 전환에는 구현 메모가 필요합니다.', '설명', '', [])] : []),
      ...shot.informationIds.flatMap((id: string): Issue[] => {
        const rule = dataset.informationRules.find((value): boolean => value.id === id);
        if (rule === undefined) return [issue('UNKNOWN_SHOT_INFORMATION', 'error', shot.id, 'informationIds', '정의되지 않은 정보를 컷에 추가할 수 없습니다.', null, id, [])];
        return shot.startMs >= rule.notBeforeMs ? [] : [issue('FORBIDDEN_REVEAL', 'error', shot.id, 'informationIds', '컷이 정보를 허용 시점보다 먼저 공개합니다.', String(rule.notBeforeMs), String(shot.startMs), rule.sourceRefs)];
      }),
    ];
  });
  const coverageIssues: Issue[] = dataset.segments.flatMap((segment): Issue[] => {
    const shots = project.shots.filter((shot): boolean => shot.segmentId === segment.id);
    if (shots.length === 0) return [issue('SEGMENT_WITHOUT_SHOTS', 'error', segment.id, 'shots', '이 구간에 컷이 없습니다.', null, null, segment.sourceRefs)];
    return [
      ...shots.flatMap((shot, index): Issue[] => {
        const expectedStart: number = shots[index - 1]?.endMs ?? segment.startMs;
        return expectedStart === shot.startMs ? [] : [issue('SHOT_GAP_OR_OVERLAP', 'error', shot.id, 'startMs', '컷의 순서에 공백 또는 겹침이 있습니다.', String(expectedStart), String(shot.startMs), [])];
      }),
      ...(shots.at(-1)?.endMs === segment.endMs ? [] : [issue('SEGMENT_END_MISMATCH', 'error', segment.id, 'shots', '마지막 컷이 구간 종료와 맞지 않습니다.', String(segment.endMs), String(shots.at(-1)?.endMs), [])]),
    ];
  });
  const unitCoverage: Issue[] = dataset.units.flatMap((unit): Issue[] => {
    const referenced: boolean = project.shots.some((shot): boolean => shot.sourceUnitIds.includes(unit.id));
    const audio = project.audioCues.filter((cue): boolean => cue.unitId === unit.id);
    const spoken: boolean = ['DIALOGUE', 'NARRATION', 'PANEL'].includes(unit.kind);
    const screenText: boolean = ['SCREEN_TEXT', 'CHAT', 'NOTE'].includes(unit.kind);
    return [
      ...(referenced ? [] : [issue('UNCOVERED_SOURCE_UNIT', 'error', unit.id, 'shots', '원문 단위가 컷에 연결되지 않았습니다.', null, null, unit.sourceRefs)]),
      ...(spoken && audio.length !== 1 ? [issue('SPOKEN_UNIT_COVERAGE', 'error', unit.id, 'audioCues', '발화는 오디오 이벤트 하나에 연결돼야 합니다.', '1', String(audio.length), unit.sourceRefs)] : []),
      ...(!spoken && !['SOUND', 'MUSIC'].includes(unit.kind) && audio.length > 0 ? [issue('NON_SPOKEN_UNIT_AUDIO', 'error', unit.id, 'audioCues', '채팅·메모·화면 문구·지문은 자동 발화로 바꿀 수 없습니다.', '0', String(audio.length), unit.sourceRefs)] : []),
      ...(screenText && !project.textCues.some((cue): boolean => cue.unitId === unit.id && cue.text === unit.text) ? [issue('UNCOVERED_SCREEN_TEXT', 'error', unit.id, 'textCues', '화면 문구 원문이 글자 트랙에 연결되지 않았습니다.', unit.text, null, unit.sourceRefs)] : []),
    ];
  });
  const frameIssues: Issue[] = project.frames.flatMap((frame): Issue[] => {
    const shot = project.shots.find((value): boolean => value.id === frame.shotId);
    return [
      ...referenceIssue(shot !== undefined, frame.id, 'shotId', frame.shotId, []),
      ...(shot !== undefined && frame.offsetMs > shot.endMs - shot.startMs ? [issue('FRAME_OUTSIDE_SHOT', 'error', frame.id, 'offsetMs', '프레임 위치가 컷 범위를 벗어났습니다.', String(shot.endMs - shot.startMs), String(frame.offsetMs), [])] : []),
      ...(shot !== undefined && ((frame.role === 'start' && frame.offsetMs !== 0) || (frame.role === 'end' && frame.offsetMs !== shot.endMs - shot.startMs) || (frame.role === 'key' && (frame.offsetMs <= 0 || frame.offsetMs >= shot.endMs - shot.startMs))) ? [issue('FRAME_ROLE_TIME', 'error', frame.id, 'role', '시작·종료·중간 프레임의 위치가 역할과 다릅니다.', null, frame.role, [])] : []),
      ...(frame.visualReview === 'accepted' && frame.imageAssetId === null ? [issue('MISSING_REVIEWED_IMAGE', 'error', frame.id, 'visualReview', '실제 그림이 없는 프레임은 시각 검토 완료로 표시할 수 없습니다.', null, null, [])] : []),
      ...(frame.imageAssetId === null ? [] : referenceIssue(project.assets.some((asset): boolean => asset.id === frame.imageAssetId && asset.kind === 'image'), frame.id, 'imageAssetId', frame.imageAssetId, [])),
    ];
  });
  const frameGroupIssues: Issue[] = project.shots.flatMap((shot): Issue[] => {
    const frames = project.frames.filter((frame): boolean => frame.shotId === shot.id);
    const starts: number = frames.filter((frame): boolean => frame.role === 'start').length;
    const ends: number = frames.filter((frame): boolean => frame.role === 'end').length;
    return [
      ...(starts === 1 ? [] : [issue('FRAME_START_COUNT', 'error', shot.id, 'frames', '컷마다 시작 프레임이 정확히 하나 필요합니다.', '1', String(starts), [])]),
      ...(ends <= 1 ? [] : [issue('FRAME_END_COUNT', 'error', shot.id, 'frames', '컷마다 종료 프레임은 하나만 둘 수 있습니다.', '0..1', String(ends), [])]),
      ...duplicateIssues(frames.map((frame): string => String(frame.offsetMs)), `${shot.id}.frameOffsets`),
    ];
  });
  const audioKinds: { unit: SourceUnit['kind']; cue: Project['audioCues'][number]['kind'] }[] = [
    { unit: 'DIALOGUE', cue: 'dialogue' }, { unit: 'NARRATION', cue: 'voiceover' }, { unit: 'PANEL', cue: 'panel' }, { unit: 'SOUND', cue: 'sfx' }, { unit: 'MUSIC', cue: 'music' },
  ];
  const audioIssues: Issue[] = project.audioCues.flatMap((cue): Issue[] => {
    const asset = cue.assetId === null ? undefined : project.assets.find((candidate): boolean => candidate.id === cue.assetId && candidate.kind === 'audio');
    return [
      ...referenceIssue(dataset.units.some((unit): boolean => unit.id === cue.unitId), cue.id, 'unitId', cue.unitId, []),
      ...intervalIssues(cue.id, cue.startMs, cue.endMs, 0, totalEnd),
      ...(cue.assetId === null ? [] : referenceIssue(asset !== undefined, cue.id, 'assetId', cue.assetId, [])),
      ...(audioKinds.some((mapping): boolean => mapping.cue === cue.kind && dataset.units.some((unit): boolean => unit.id === cue.unitId && unit.kind === mapping.unit)) ? [] : [issue('AUDIO_KIND_MISMATCH', 'error', cue.id, 'kind', '원문 유형과 음성 트랙의 유형이 다릅니다.', null, cue.kind, [])]),
      ...(cue.timingStatus === 'measured' && cue.assetId === null ? [issue('MISSING_MEASURED_AUDIO', 'error', cue.id, 'timingStatus', '실제 음성 자산 없이 측정 완료로 표시할 수 없습니다.', null, null, [])] : []),
      ...(cue.timingStatus === 'measured' && asset?.durationMs !== cue.endMs - cue.startMs ? [issue('AUDIO_DURATION_MISMATCH', 'error', cue.id, 'timing', '측정된 큐 길이와 오디오 자산 길이가 다릅니다.', String(asset?.durationMs ?? 'null'), String(cue.endMs - cue.startMs), [])] : []),
    ];
  });
  const textIssues: Issue[] = project.textCues.flatMap((cue): Issue[] => {
    const unit = cue.unitId === null ? null : dataset.units.find((value): boolean => value.id === cue.unitId);
    const placement = cue.placementId === null ? null : dataset.textPlacements.find((value): boolean => value.id === cue.placementId);
    return [
      ...referenceIssue(dataset.segments.some((value): boolean => value.id === cue.segmentId), cue.id, 'segmentId', cue.segmentId, []),
      ...intervalIssues(cue.id, cue.startMs, cue.endMs, dataset.segments.find((segment): boolean => segment.id === cue.segmentId)?.startMs ?? 0, dataset.segments.find((segment): boolean => segment.id === cue.segmentId)?.endMs ?? totalEnd),
      ...(cue.unitId === null ? [] : referenceIssue(unit !== undefined && unit !== null && unit.segmentId === cue.segmentId, cue.id, 'unitId', cue.unitId, [])),
      ...(cue.placementId === null ? [] : referenceIssue(placement !== undefined && placement !== null && placement.segmentId === cue.segmentId, cue.id, 'placementId', cue.placementId, [])),
      ...(unit !== undefined && unit !== null && cue.text !== unit.text ? [issue('SOURCE_TEXT_MODIFIED', 'error', cue.id, 'text', '원문 문구를 변경할 수 없습니다.', unit.text, cue.text, unit.sourceRefs)] : []),
      ...(placement !== undefined && placement !== null && (cue.startMs !== placement.startMs || cue.text !== placement.text) ? [issue('PLACEMENT_MODIFIED', 'error', cue.id, 'placementId', '확정 자막 시작점 또는 문구가 변경되었습니다.', `${placement.startMs}: ${placement.text}`, `${cue.startMs}: ${cue.text}`, placement.sourceRefs)] : []),
      ...(placement !== undefined && placement !== null && placement.endMs !== null && cue.endMs !== placement.endMs ? [issue('PLACEMENT_END_MODIFIED', 'error', cue.id, 'endMs', '확정 자막 종료점이 변경되었습니다.', String(placement.endMs), String(cue.endMs), placement.sourceRefs)] : []),
    ];
  });
  const placementCoverage: Issue[] = dataset.textPlacements.flatMap((placement): Issue[] => {
    const count: number = project.textCues.filter((cue): boolean => cue.placementId === placement.id).length;
    return count === 1 ? [] : [issue('PLACEMENT_COVERAGE', 'error', placement.id, 'textCues', '원본 자막 큐는 글자 트랙 하나에 연결돼야 합니다.', '1', String(count), placement.sourceRefs)];
  });
  const orderIssues: Issue[] = project.shots.flatMap((shot, index): Issue[] => {
    const previous = project.shots[index - 1];
    return previous === undefined || previous.endMs === shot.startMs ? [] : [issue('PROJECT_SHOT_ORDER', 'error', shot.id, 'startMs', '프로젝트 컷 목록은 전체 방송 순서를 따라야 합니다.', String(previous.endMs), String(shot.startMs), [])];
  });
  const continuityIssues: Issue[] = project.shots.flatMap((shot, index): Issue[] => {
    const next = project.shots[index + 1];
    if (next === undefined || shot.endMs !== next.startMs) return [];
    const ids: string[] = [...new Set([...shot.continuityAfter.map((state): string => state.assetId), ...next.continuityBefore.map((state): string => state.assetId)])];
    return ids.flatMap((id: string): Issue[] => {
      const outgoing: string | undefined = shot.continuityAfter.find((state): boolean => state.assetId === id)?.state;
      const incoming: string | undefined = next.continuityBefore.find((state): boolean => state.assetId === id)?.state;
      if (outgoing === incoming) return [];
      const severity: Issue['severity'] = outgoing === undefined || incoming === undefined ? 'warning' : 'error';
      return [issue('CONTINUITY_STATE_MISMATCH', severity, next.id, 'continuityBefore', '인접 컷의 자산 전후 상태가 이어지지 않습니다.', outgoing ?? '미기록', incoming ?? '미기록', [])];
    });
  });
  const generationIssues: Issue[] = project.generationRecords.flatMap((record): Issue[] => record.resultAssetIds.flatMap((id: string): Issue[] => referenceIssue(project.assets.some((asset): boolean => asset.id === id), record.id, 'resultAssetIds', id, [])));
  const assetSubjectIssues: Issue[] = project.assets.flatMap((asset): Issue[] => {
    if (asset.subjectId === null) return ['character', 'location'].includes(asset.kind) ? [issue('MISSING_ASSET_SUBJECT', 'error', asset.id, 'subjectId', '인물·장소 기준 자산은 연결 대상을 지정해야 합니다.', null, null, [])] : [];
    const exists: boolean = asset.kind === 'character' ? dataset.people.some((person): boolean => person.id === asset.subjectId)
      : asset.kind === 'location' ? dataset.locations.some((location): boolean => location.id === asset.subjectId) : true;
    return referenceIssue(exists, asset.id, 'subjectId', asset.subjectId, []);
  });
  return [...sourceIssues, ...projectIssues, ...groups.flatMap((group): Issue[] => duplicateIssues(group.ids, group.name)), ...shotIssues, ...coverageIssues, ...unitCoverage, ...frameIssues, ...frameGroupIssues, ...audioIssues, ...textIssues, ...placementCoverage, ...orderIssues, ...continuityIssues, ...generationIssues, ...assetSubjectIssues];
}
