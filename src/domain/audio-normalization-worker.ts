import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';

const WorkerInputSchema = z.strictObject({
  sourceData: z.instanceof(Uint8Array),
  sourceSampleRate: z.number(),
  sourceChannels: z.union([z.literal(1), z.literal(2)]),
  sourceBitsPerSample: z.union([z.literal(16), z.literal(24)]),
  sourceFrames: z.number(),
  targetSampleRate: z.number(),
  targetFrames: z.number(),
  outputBytes: z.number(),
  sampleOperations: z.number(),
});
type WorkerInput = z.infer<typeof WorkerInputSchema>;

type WorkerSuccess = { ok: true; bytes: Uint8Array };
type WorkerFailure = { ok: false; code: string; message: string };

function requireInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} 값이 양의 안전 정수가 아닙니다. actual=${value}`);
}

function validateInput(input: WorkerInput): void {
  requireInteger(input.sourceSampleRate, 'sourceSampleRate');
  requireInteger(input.sourceChannels, 'sourceChannels');
  requireInteger(input.sourceBitsPerSample, 'sourceBitsPerSample');
  requireInteger(input.sourceFrames, 'sourceFrames');
  requireInteger(input.targetSampleRate, 'targetSampleRate');
  requireInteger(input.targetFrames, 'targetFrames');
  requireInteger(input.outputBytes, 'outputBytes');
  requireInteger(input.sampleOperations, 'sampleOperations');
  if (input.sourceChannels !== 1 && input.sourceChannels !== 2) throw new Error(`지원하지 않는 channel 수입니다. channels=${input.sourceChannels}`);
  if (input.sourceBitsPerSample !== 16 && input.sourceBitsPerSample !== 24) throw new Error(`지원하지 않는 PCM bit depth입니다. bits=${input.sourceBitsPerSample}`);
  const expectedSourceBytes: number = input.sourceFrames * input.sourceChannels * input.sourceBitsPerSample / 8;
  const expectedOutputBytes: number = 44 + input.targetFrames * input.sourceChannels * 2;
  const expectedOperations: number = input.targetFrames * input.sourceChannels;
  if (input.sourceData.byteLength !== expectedSourceBytes || input.outputBytes !== expectedOutputBytes
    || input.sampleOperations !== expectedOperations) {
    throw new Error(`사전 계산값과 Worker 입력이 다릅니다. sourceBytes=${input.sourceData.byteLength}/${expectedSourceBytes}, outputBytes=${input.outputBytes}/${expectedOutputBytes}, operations=${input.sampleOperations}/${expectedOperations}`);
  }
}

function readSample(data: Buffer, byteOffset: number, bitsPerSample: 16 | 24): number {
  if (bitsPerSample === 16) return data.readInt16LE(byteOffset) / 32768;
  return data.readIntLE(byteOffset, 3) / 8388608;
}

function sampleAt(input: WorkerInput, data: Buffer, frame: number, channel: number): number {
  const bytesPerSample: number = input.sourceBitsPerSample / 8;
  return readSample(data, (frame * input.sourceChannels + channel) * bytesPerSample, input.sourceBitsPerSample);
}

function normalize(input: WorkerInput): Buffer {
  validateInput(input);
  const source: Buffer = Buffer.from(input.sourceData.buffer, input.sourceData.byteOffset, input.sourceData.byteLength);
  const result: Buffer = Buffer.alloc(input.outputBytes);
  const dataLength: number = input.outputBytes - 44;
  result.write('RIFF', 0);
  result.writeUInt32LE(36 + dataLength, 4);
  result.write('WAVE', 8);
  result.write('fmt ', 12);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(input.sourceChannels, 22);
  result.writeUInt32LE(input.targetSampleRate, 24);
  result.writeUInt32LE(input.targetSampleRate * input.sourceChannels * 2, 28);
  result.writeUInt16LE(input.sourceChannels * 2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(dataLength, 40);
  for (let frame: number = 0; frame < input.targetFrames; frame += 1) {
    const sourcePosition: number = frame * input.sourceSampleRate / input.targetSampleRate;
    const left: number = Math.min(Math.floor(sourcePosition), input.sourceFrames - 1);
    const right: number = Math.min(left + 1, input.sourceFrames - 1);
    const ratio: number = sourcePosition - left;
    for (let channel: number = 0; channel < input.sourceChannels; channel += 1) {
      const value: number = sampleAt(input, source, left, channel) * (1 - ratio) + sampleAt(input, source, right, channel) * ratio;
      const clamped: number = Math.max(-1, Math.min(1, value));
      result.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(clamped * 32767))), 44 + (frame * input.sourceChannels + channel) * 2);
    }
  }
  return result;
}

if (parentPort === null) throw new Error('Audio normalization Worker에는 parentPort가 필요합니다.');

try {
  const input: WorkerInput = WorkerInputSchema.parse(workerData);
  const output: Buffer = normalize(input);
  const transferable: Uint8Array<ArrayBuffer> = Uint8Array.from(output);
  const response: WorkerSuccess = { ok: true, bytes: transferable };
  parentPort.postMessage(response, [transferable.buffer]);
} catch (error: unknown) {
  const response: WorkerFailure = { ok: false, code: 'AUDIO_NORMALIZATION_WORKER_FAILED',
    message: error instanceof Error ? error.message : String(error) };
  parentPort.postMessage(response);
}
parentPort.close();
