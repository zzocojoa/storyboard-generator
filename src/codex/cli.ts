import { parseArgs } from 'node:util';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { ZodError } from 'zod';
import { WorkerAudioNormalizer } from '../domain/audio-normalizer.js';
import { contractError } from '../domain/errors.js';
import type { Project } from '../domain/schema.js';
import { writeNewText } from '../io/project.js';
import { loadConfig } from '../server/config.js';
import type { AppConfig } from '../server/config.js';
import { ProjectStore } from '../server/store.js';
import { applyCodexImage, applyCodexProposal, applyCodexSpeech } from './apply.js';
import { CodexRequestStore } from './requests.js';
import type { CodexRequest } from './schema.js';
import type { CodexWork, SpeechWork } from './work.js';
import { buildCodexWork } from './work.js';

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw contractError('MISSING_ARGUMENT', `${name} 인수를 지정하세요.`, []);
  return value;
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function projectResult(project: Project): object {
  return { projectId: project.projectId, revision: project.revision, shots: project.shots.length,
    framesReady: project.frames.filter((frame): boolean => frame.imageAssetId !== null).length,
    audioReady: project.audioCues.filter((cue): boolean => cue.assetId !== null).length };
}

function requestArgument(args: string[]): string {
  const { values } = parseArgs({ args, options: { request: { type: 'string' } }, strict: true, allowPositionals: false });
  return required(values.request, '--request');
}

async function pending(requests: CodexRequestStore): Promise<void> {
  output({ requests: await requests.list('pending') });
}

async function context(args: string[], store: ProjectStore, requests: CodexRequestStore): Promise<void> {
  const request: CodexRequest = await requests.read(requestArgument(args));
  if (request.status !== 'pending') throw contractError('CODEX_REQUEST_SETTLED', `${request.id}: 이미 ${request.status} 상태인 요청입니다.`, []);
  output(await buildCodexWork(request, await store.read(request.projectId), store));
}

async function prepareSpeech(args: string[], store: ProjectStore, requests: CodexRequestStore): Promise<void> {
  const { values } = parseArgs({ args, options: { request: { type: 'string' }, output: { type: 'string' } }, strict: true, allowPositionals: false });
  const request: CodexRequest = await requests.read(required(values.request, '--request'));
  const work: CodexWork = await buildCodexWork(request, await store.read(request.projectId), store);
  if (work.kind !== 'speech') throw contractError('CODEX_REQUEST_KIND_MISMATCH', `${request.id}: 음성 작업이 아닙니다.`, []);
  const speechWork: SpeechWork = work;
  const path: string = required(values.output, '--output');
  await mkdir(dirname(path), { recursive: true });
  await writeNewText(path, speechWork.context.unit.text);
  output({ request, inputPath: path, text: speechWork.context.unit.text });
}

async function applyProposal(args: string[], store: ProjectStore, requests: CodexRequestStore): Promise<void> {
  const { values } = parseArgs({ args, options: { request: { type: 'string' }, input: { type: 'string' } }, strict: true, allowPositionals: false });
  output({ project: projectResult(await applyCodexProposal(required(values.request, '--request'), required(values.input, '--input'), store, requests, new Date().toISOString())) });
}

async function applyImage(args: string[], store: ProjectStore, requests: CodexRequestStore): Promise<void> {
  const { values } = parseArgs({ args, options: { request: { type: 'string' }, input: { type: 'string' } }, strict: true, allowPositionals: false });
  output({ project: projectResult(await applyCodexImage(required(values.request, '--request'), required(values.input, '--input'), store, requests, new Date().toISOString())) });
}

async function applySpeech(args: string[], config: AppConfig, store: ProjectStore, requests: CodexRequestStore): Promise<void> {
  const { values } = parseArgs({ args, options: { request: { type: 'string' }, input: { type: 'string' } }, strict: true, allowPositionals: false });
  const normalizer: WorkerAudioNormalizer = new WorkerAudioNormalizer(config.audioNormalization);
  try {
    output({ project: projectResult(await applyCodexSpeech(required(values.request, '--request'), required(values.input, '--input'), config.codex.speechVoice, store, requests, new Date().toISOString(), normalizer)) });
  } finally {
    await normalizer.close();
  }
}

async function fail(args: string[], requests: CodexRequestStore): Promise<void> {
  const { values } = parseArgs({ args, options: { request: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } }, strict: true, allowPositionals: false });
  output({ request: await requests.fail(required(values.request, '--request'), required(values.code, '--code'), required(values.message, '--message'), new Date().toISOString()) });
}

const help: string = `Codex App 콘티 생성 브리지\n\npending\ncontext --request <UUID>\nprepare-speech --request <UUID> --output <새 TXT 경로>\napply-proposal --request <UUID> --input <JSON 경로>\napply-image --request <UUID> --input <PNG 경로>\napply-speech --request <UUID> --input <WAV 경로>\nfail --request <UUID> --code <오류 코드> --message <설명>\n`;

async function main(configPath: string, args: string[]): Promise<void> {
  const config: AppConfig = await loadConfig(configPath);
  const store: ProjectStore = new ProjectStore(config.dataRoot);
  const requests: CodexRequestStore = new CodexRequestStore(config.codex.requestRoot);
  const [command, ...rest] = args;
  if (command === 'pending') return pending(requests);
  if (command === 'context') return context(rest, store, requests);
  if (command === 'prepare-speech') return prepareSpeech(rest, store, requests);
  if (command === 'apply-proposal') return applyProposal(rest, store, requests);
  if (command === 'apply-image') return applyImage(rest, store, requests);
  if (command === 'apply-speech') return applySpeech(rest, config, store, requests);
  if (command === 'fail') return fail(rest, requests);
  if (command === '--help') { process.stdout.write(help); return; }
  throw contractError('UNKNOWN_COMMAND', help, []);
}

try {
  await main(process.argv[2] ?? 'storyboard.config.json', process.argv.slice(3));
} catch (error: unknown) {
  if (!(error instanceof Error)) throw error;
  process.stderr.write(`${JSON.stringify({ level: 'error', code: 'code' in error ? error.code : error.name, message: error.message,
    issues: error instanceof ZodError ? error.issues : 'issues' in error ? error.issues : [], stack: error.stack })}\n`);
  process.exitCode = 1;
}
