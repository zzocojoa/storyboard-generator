import { writeNodeFixture } from './node-process-fixture.js';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { documentFingerprint, inspectDocuments } from '../src/documents/compile.js';
import type { DocumentReviewInput } from '../src/documents/review-input.js';
import type { DocumentReviewResult, ProductionFields, ReviewState, ReviewSuggestion } from '../src/documents/review-model.js';
import type { DocumentSources } from '../src/documents/schema.js';
import { SYNTHETIC_DOCUMENT_BINDINGS } from './document-helpers.js';

export const REVIEW_PRODUCTION: ProductionFields = { fps: '30/1', sampleRate: '48000', width: '16', height: '9', startTimecode: '00:00:00:00' };
export const EMPTY_REVIEW_PRODUCTION: ProductionFields = { fps: '', sampleRate: '', width: '', height: '', startTimecode: '00:00:00:00' };

export function reviewTestInput(sources: DocumentSources, directory: string): DocumentReviewInput {
  return { directory, sourceFingerprint: documentFingerprint(sources), bindings: { people: [], scenes: [], units: [] }, production: EMPTY_REVIEW_PRODUCTION, presetId: null };
}

export function syntheticReviewResult(sources: DocumentSources): DocumentReviewResult {
  const initial = inspectDocuments(sources, { people: [], scenes: [], units: [] }).preview;
  const expected = inspectDocuments(sources, SYNTHETIC_DOCUMENT_BINDINGS).preview;
  const suggestions: ReviewSuggestion[] = (['people', 'scenes', 'units'] as const).flatMap((field): ReviewSuggestion[] => initial[field].filter((choice): boolean => choice.selected === null).map((choice): ReviewSuggestion => ({
    field, key: choice.key, value: expected[field].find((item): boolean => item.key === choice.key)!.selected!, origin: 'inference', reason: '검증용으로 명시한 연결 제안입니다.',
    evidence: [{ fileId: 'document-broadcast', locator: 'line:7', quote: '민아' }],
  })));
  return { summary: '합성 문서 검토 결과입니다. 연결·설정 제안을 확인하세요.', suggestions: [...suggestions,
    ...(['fps', 'sampleRate', 'width', 'height'] as const).map((key): ReviewSuggestion => ({ field: 'production', key, value: REVIEW_PRODUCTION[key], origin: 'recommendation', reason: '영상 제작을 위한 선택이며 원문에 명시된 값이 아닙니다.', evidence: [] }))] };
}

export function completedReview(result: DocumentReviewResult, fingerprint: string): ReviewState {
  return { id: '54d14945-439e-4c5b-a068-2f74c73eeef4', basisHash: 'a'.repeat(64), sourceFingerprint: fingerprint, createdAt: '2026-09-10T00:00:00.000Z', updatedAt: '2026-09-10T00:00:01.000Z', status: 'completed', model: 'test-codex-model', result, error: null };
}

/** 모델 응답 대신 실제 자식 프로세스의 app-server 입출력·중단을 검사한다. */
export async function writeReviewEngineFixture(root: string, result: DocumentReviewResult, behavior: 'success' | 'api-key' | 'invalid-json' | 'timeout' | 'tool-request', delayMs: number): Promise<string> {
  const path: string = join(root, `engine-${behavior}-${delayMs}-${randomUUID()}.mjs`);
  await writeNodeFixture(path, `#!${process.execPath}\nimport {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const trace=(event)=>appendFileSync(${JSON.stringify(path + '.rpc.jsonl')},JSON.stringify({event,pid:process.pid,at:Date.now()})+'\\n');
trace('started');
const result=${JSON.stringify(result)}; const behavior=${JSON.stringify(behavior)};
const send=(value)=>{trace('send:'+(value.method ?? value.id));process.stdout.write(JSON.stringify(value)+'\\n');};
createInterface({input:process.stdin}).on('line',(line)=>{const message=JSON.parse(line); const {id,method,params}=message;
trace('received:'+method);
if(method==='initialize') send({id,result:{}});
if(method==='account/read') send({id,result:{account:{type:behavior==='api-key'?'apiKey':'chatgpt'}}});
if(method==='config/read') send({id,result:{config:{mcp_servers:{unrelated:{enabled:true}}}}});
if(method==='thread/start') {if(params.environments.length!==0 || params.sandbox!=='read-only' || params.approvalPolicy!=='never' || params.config['mcp_servers.unrelated.enabled']!==false) process.exit(31); send({id,result:{thread:{id:'fixture-thread'},model:'test-codex-model',approvalPolicy:'never',sandbox:{type:'readOnly',networkAccess:false}}});}
if(method==='turn/start') {send({id,result:{turn:{id:'fixture-turn',status:'inProgress'}}}); if(behavior==='timeout') return;
setTimeout(()=>{if(behavior==='tool-request'){send({id:99,method:'item/permissions/requestApproval',params:{}});return;}send({method:'item/completed',params:{threadId:'fixture-thread',item:{type:'agentMessage',phase:'final_answer',text:behavior==='invalid-json'?'invalid':JSON.stringify(result)}}});send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{status:'completed',error:null}}});},${delayMs});}
});
`);
  return path;
}
