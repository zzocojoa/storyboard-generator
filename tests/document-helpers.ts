import { documentFingerprint } from '../src/documents/compile.js';
import type { DocumentBindings, DocumentSettings, DocumentSources } from '../src/documents/schema.js';

// 테스트에서 명시적으로 제공한 대응이며 제품은 이 값이나 배열 순서를 추론에 사용하지 않는다.
export const PRODUCTION_DOCUMENT_BINDINGS: DocumentBindings = {
  people: [{ key: '강태균', targetId: 'CHAR-01' }, { key: '윤서진', targetId: 'CHAR-02' }, { key: '백기철', targetId: 'CHAR-03' }, { key: '오민주', targetId: 'CHAR-04' }, { key: '박도현', targetId: 'CHAR-05' }],
  scenes: [], units: [],
};
export const SYNTHETIC_DOCUMENT_BINDINGS: DocumentBindings = {
  people: [{ key: '민아', targetId: 'host' }, { key: '준', targetId: 'helper' }],
  scenes: [{ key: '물을 주는 아침', targetId: 'garden' }, { key: '받침 정리', targetId: 'sink' }], units: [],
};

export function documentTestSettings(sources: DocumentSources, bindings: DocumentBindings): DocumentSettings {
  return { formatVersion: '1.0.0', sourceFingerprint: documentFingerprint(sources), packageVersion: 'explicit-test-1',
    timebase: { fpsNumerator: 25, fpsDenominator: 1, dropFrame: false, sampleRate: 44100, startTimecode: '01:00:00:00' },
    profile: { medium: 'ai', aspectWidth: 9, aspectHeight: 16, visualStyle: '테스트 전용' }, bindings };
}
