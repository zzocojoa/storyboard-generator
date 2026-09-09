import { createHash } from 'node:crypto';
import { z } from 'zod';
import { contractError } from './domain/errors.js';
import type { GeneratorBuildProvenance } from './domain/schema.js';
import { stableJsonStringify } from './io/stable-json.js';

export type BuildInput = { path: string; bytes: Uint8Array };
export type GeneratorBuildFingerprint = { sourceTreeSha256: string; generationContractSha256: string; runtimeGenerationConfigSha256: string; projectSchemaVersion: string };
export type RuntimeGenerationConfiguration = {
  speechVoice: string;
  providers: { proposal: 'codex-app-current-model'; image: 'codex-app-image-gen'; speech: 'macos-say' };
  audio: { container: 'wav'; codec: 'pcm_s16le'; channels: 'mono-or-stereo'; sampleRate: 'project-handoff' };
};

function relativeBuildPath(path: string): string {
  const normalized: string = path.replace(/\\/gu, '/');
  if (normalized.startsWith('/') || /^[a-z]:/iu.test(normalized) || normalized.includes('\0') || normalized.split('/').some((part: string): boolean => part === '..' || part === '.' || part === '')) {
    throw contractError('INVALID_BUILD_INPUT_PATH', 'Build 입력에는 정규 상대경로가 필요합니다.', []);
  }
  return normalized;
}

/** 정렬한 상대경로와 원본 바이트 사이의 NUL 경계로 생성 입력을 식별한다. */
export function hashBuildInputs(inputs: readonly BuildInput[]): string {
  const canonical: BuildInput[] = inputs.map((input: BuildInput): BuildInput => ({ ...input, path: relativeBuildPath(input.path) }))
    .sort((left: BuildInput, right: BuildInput): number => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(canonical.map((input: BuildInput): string => input.path)).size !== canonical.length) throw contractError('DUPLICATE_BUILD_INPUT_PATH', '정규화된 Build 입력 경로가 중복됩니다.', []);
  const digest = createHash('sha256');
  for (const input of canonical) digest.update(input.path).update('\0').update(input.bytes).update('\0');
  return digest.digest('hex');
}

/** 비밀·경로·운영 자원 설정을 전달하지 않고 실제 생성 출력 설정만 명시적으로 구성한다. */
export function runtimeGenerationConfiguration(speechVoice: string): RuntimeGenerationConfiguration {
  return { speechVoice: z.string().min(1).parse(speechVoice),
    providers: { proposal: 'codex-app-current-model', image: 'codex-app-image-gen', speech: 'macos-say' },
    audio: { container: 'wav', codec: 'pcm_s16le', channels: 'mono-or-stereo', sampleRate: 'project-handoff' } };
}

export function runtimeGenerationConfigHash(speechVoice: string): string {
  return createHash('sha256').update(stableJsonStringify(runtimeGenerationConfiguration(speechVoice))).digest('hex');
}

/** 과거에 기록되지 않은 계약 Hash를 현재 Build의 값으로 추정하지 않는다. */
export function generatorBuildFingerprint(build: GeneratorBuildProvenance | null | undefined): GeneratorBuildFingerprint | null {
  if (build === null || build === undefined || build.sourceTreeSha256 === null || build.generationContractSha256 === null || build.runtimeGenerationConfigSha256 === null) return null;
  return { sourceTreeSha256: build.sourceTreeSha256, generationContractSha256: build.generationContractSha256,
    runtimeGenerationConfigSha256: build.runtimeGenerationConfigSha256, projectSchemaVersion: build.projectSchemaVersion };
}

export function sameGenerationBuild(left: GeneratorBuildProvenance | null | undefined, right: GeneratorBuildProvenance | null | undefined): boolean {
  const first: GeneratorBuildFingerprint | null = generatorBuildFingerprint(left);
  const second: GeneratorBuildFingerprint | null = generatorBuildFingerprint(right);
  return first !== null && second !== null && stableJsonStringify(first) === stableJsonStringify(second);
}
