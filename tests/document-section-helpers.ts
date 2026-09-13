import { readDocumentSources } from '../src/documents/io.js';
import type { DocumentKey, DocumentSources } from '../src/documents/schema.js';
import type { DocumentManifest } from '../src/documents/supporting.js';
import { sha256Text } from '../src/importers/integrity.js';

export function withSectionChanges(sources: DocumentSources, changes: Partial<Record<DocumentKey, string>>): DocumentSources {
  const changed: DocumentSources = { ...sources };
  for (const key of Object.keys(changes) as DocumentKey[]) {
    const content: string = changes[key] as string;
    changed[key] = { ...sources[key], content, sha256: sha256Text(content) };
  }
  const manifest = JSON.parse(changed.manifest.content) as DocumentManifest;
  const content = JSON.stringify({ ...manifest, deliverables: manifest.deliverables.map((entry) => ({ ...entry, sha256: Object.values(changed).find((snapshot): boolean => snapshot.path === entry.path)?.sha256 })) });
  return { ...changed, manifest: { ...changed.manifest, content, sha256: sha256Text(content) } };
}

/** 별도 합성 이야기로 ID 접두사·분량·선택 녹음 구간 부재를 검증한다. */
export async function syntheticSectionSources(): Promise<DocumentSources> {
  const sources = await readDocumentSources('tests/fixtures/documents');
  const hash = '<!-- SOURCE_FINAL_SHA256:' + '0'.repeat(64) + ' -->';
  return withSectionChanges(sources, {
    edit: '# 창가의 화분 — 편집 대본\n\nplant-doc-demo · 20초 계획\n\n## opening 00:00–00:08 · DEMO · garden\n\n손과 흙을 근접 촬영한다.\n\n## finish 00:08–00:20 · DEMO · sink\n\n받침을 보여 준다.\n',
    narration: '# 창가의 화분 · 내레이션 녹음본\n\n제작 메타데이터: plant-doc-demo · 내레이션 없음\n' + hash + '\n',
    panel: '# 창가의 화분 · 패널 진행·녹화본\n\n제작 메타데이터: plant-doc-demo · 패널 없음\n' + hash + '\n',
    shooting: `# 창가의 화분 — 촬영 대본

plant-doc-demo · 합성 검증 자료

<!-- PRODUCTION_SCENE:garden LOCATION:window CAST:host CHILD:NONE VEHICLE:NONE SFX:NONE VIOLENCE:NONE COMPLEXITY:LOW -->
## garden · window · 00:00–00:08
손과 흙을 촬영한다.
<!-- SEGMENT:opening TYPE:DEMO SCENE:garden DURATION:8 -->
<!-- UNIT:soil-touch -->
[지문] 민아가 화분의 흙을 만진다.
<!-- UNIT:water-advice -->
host: 흙이 말랐으면 물을 주세요.
<!-- END_SEGMENT:opening -->

<!-- PRODUCTION_SCENE:sink LOCATION:washroom CAST:helper CHILD:NONE VEHICLE:NONE SFX:NONE VIOLENCE:NONE COMPLEXITY:LOW -->
## sink · washroom · 00:08–00:20
받침을 촬영한다.
<!-- SEGMENT:finish TYPE:DEMO SCENE:sink DURATION:12 -->
<!-- UNIT:drain-action -->
[지문] 준이 받침의 물을 비운다.
<!-- UNIT:drain-advice -->
helper: 받침에 고인 물은 비워 주세요.
<!-- END_SEGMENT:finish -->
`,
    subtitles: `# 창가의 화분 · 자막 원문·구간 계획

제작 메타데이터: plant-doc-demo · 2구간
${hash}

## opening · 00:00:00–00:00:08
제작 정보: garden · 8초 계획.
<!-- SEGMENT:opening TYPE:DEMO SCENE:garden DURATION:8 -->
**자막 001 · 민아 · 대사**
<!-- SUBTITLE_SOURCE:water-advice -->
> 흙이 말랐으면 물을 주세요.
<!-- END_SEGMENT:opening -->

## finish · 00:00:08–00:00:20
제작 정보: sink · 12초 계획.
<!-- SEGMENT:finish TYPE:DEMO SCENE:sink DURATION:12 -->
**자막 002 · 준 · 대사**
<!-- SUBTITLE_SOURCE:drain-advice -->
> 받침에 고인 물은 비워 주세요.
<!-- END_SEGMENT:finish -->
`,
  });
}
