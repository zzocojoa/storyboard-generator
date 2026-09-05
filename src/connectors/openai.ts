import OpenAI, { toFile } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { contractError } from '../domain/errors.js';
import type { ImageContext, SegmentContext } from '../proposal/context.js';
import { SegmentProposalSchema } from '../proposal/model.js';
import type { AppConfig } from '../server/config.js';
import type { GeneratedImage, GeneratedSpeech, GenerationConnector, ImageReference, ProposedSegment } from './generation.js';
import { withRetry } from './retry.js';

function apiKey(): string {
  const value: string | undefined = process.env.OPENAI_API_KEY;
  if (value === undefined || value.trim() === '') throw contractError('OPENAI_API_KEY_REQUIRED', 'OpenAI 생성 기능을 사용하려면 서버 실행 환경에 OPENAI_API_KEY를 설정하세요.', []);
  return value;
}

export type OpenAIImageSize = '1024x1024' | '1536x1024' | '1024x1536';

export function imageSize(width: number, height: number): OpenAIImageSize {
  const ratio: number = width / height;
  if (ratio > 1.1) return '1536x1024';
  if (ratio < 0.9) return '1024x1536';
  return '1024x1024';
}

function logWarning(fields: Readonly<Record<string, string | number>>): void {
  process.stderr.write(`${JSON.stringify(fields)}\n`);
}

export class OpenAIConnector implements GenerationConnector {
  readonly #client: OpenAI;
  readonly #config: AppConfig['generation'];

  constructor(config: AppConfig['generation']) {
    this.#config = config;
    this.#client = new OpenAI({ apiKey: apiKey(), timeout: config.requestTimeoutMs, maxRetries: 0 });
  }

  async propose(context: SegmentContext): Promise<ProposedSegment> {
    const prompt: string = JSON.stringify(context);
    const response = await withRetry('openai.proposal', this.#config.retryCount + 1, this.#config.retryBackoffMs, logWarning, async () => this.#client.responses.parse({
      model: this.#config.proposalModel, store: false,
      instructions: '당신은 영상 콘티 제안자입니다. 입력 구간의 원문 ID를 빠짐없이 컷에 연결하세요. 원문 문구·시간·사실을 바꾸지 마세요. 정보 ID는 allowedInformationIds에 있는 값만 사용하세요. 화면 글자는 그림에 그리지 말고 별도 합성을 전제로 하세요.',
      input: prompt, text: { format: zodTextFormat(SegmentProposalSchema, 'storyboard_segment_proposal') },
    }));
    if (response.output_parsed === null) throw contractError('OPENAI_PROPOSAL_EMPTY', `OpenAI 응답 ${response.id}에 구조화된 컷 제안이 없습니다.`, []);
    return { proposal: response.output_parsed, prompt, model: response.model, requestId: response.id };
  }

  async image(context: ImageContext, references: readonly ImageReference[]): Promise<GeneratedImage> {
    const prompt: string = `영상 콘티용 러프 프레임을 생성하세요. 글자, 캡션, 워터마크를 이미지에 넣지 마세요. 프로젝트 입력:\n${JSON.stringify(context)}`;
    if (references.length > 16) throw contractError('TOO_MANY_IMAGE_REFERENCES', `이미지 기준 자산은 최대 16개까지 사용할 수 있습니다. actual=${references.length}`, []);
    const response = await withRetry('openai.image', this.#config.retryCount + 1, this.#config.retryBackoffMs, logWarning, async () => references.length === 0
      ? this.#client.images.generate({ model: this.#config.imageModel, prompt, n: 1, quality: this.#config.imageQuality, size: imageSize(context.profile.aspectWidth, context.profile.aspectHeight), output_format: 'png', background: 'opaque' })
      : this.#client.images.edit({ model: this.#config.imageModel, prompt,
        image: await Promise.all(references.map(async (reference: ImageReference) => toFile(reference.bytes, `${reference.id}.${reference.mimeType.split('/')[1] ?? 'png'}`, { type: reference.mimeType }))),
        n: 1, quality: this.#config.imageQuality, size: imageSize(context.profile.aspectWidth, context.profile.aspectHeight), output_format: 'png', background: 'opaque' }));
    const encoded: string | undefined = response.data?.[0]?.b64_json;
    if (encoded === undefined) throw contractError('OPENAI_IMAGE_EMPTY', 'OpenAI Image API가 이미지 바이트를 반환하지 않았습니다.', []);
    return { bytes: Buffer.from(encoded, 'base64'), prompt, model: this.#config.imageModel, requestId: null, mimeType: 'image/png', referenceHashes: references.map((reference: ImageReference): string => reference.sha256) };
  }

  async speech(text: string): Promise<GeneratedSpeech> {
    if ([...text].length > 4096) throw contractError('OPENAI_SPEECH_INPUT_TOO_LONG', `가이드 음성 입력은 4096자 이하여야 합니다. actual=${[...text].length}`, []);
    const response = await withRetry('openai.speech', this.#config.retryCount + 1, this.#config.retryBackoffMs, logWarning, async () => this.#client.audio.speech.create({
      model: this.#config.speechModel, voice: this.#config.speechVoice, input: text, instructions: this.#config.speechInstructions, response_format: 'wav', stream_format: 'audio',
    }));
    return { bytes: Buffer.from(await response.arrayBuffer()), prompt: text, model: this.#config.speechModel, requestId: response.headers.get('x-request-id'), mimeType: 'audio/wav' };
  }
}
