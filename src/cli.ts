import { parseArgs } from 'node:util';
import { ZodError } from 'zod';
import { contractError } from './domain/errors.js';
import type { Project } from './domain/schema.js';
import { exportShotCsv } from './exporters/csv.js';
import { exportProjectJson } from './exporters/json.js';
import { importPackage } from './importers/import-package.js';
import { readPackage } from './io/package.js';
import { readProject, writeNewText } from './io/project.js';
import { createSourceOutline } from './proposal/outline.js';
import { inspectDocuments } from './documents/compile.js';
import { readDocumentSources, writeDocumentPackage } from './documents/io.js';
import { readUtf8 } from './io/package.js';
import { parseJson } from './importers/integrity.js';
import { DocumentBindingsSchema } from './documents/schema.js';

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === '') throw contractError('MISSING_ARGUMENT', `${name} 인수를 지정하세요.`, []);
  return value;
}

function printProject(project: Project): void {
  process.stdout.write(`${JSON.stringify({ projectId: project.projectId, title: project.title, scenes: project.dataset.scenes.length,
    segments: project.dataset.segments.length, sourceUnits: project.dataset.units.length, shots: project.shots.length, frames: project.frames.length,
    audioCues: project.audioCues.length, textCues: project.textCues.length, durationMs: project.dataset.segments.at(-1)?.endMs,
    importIssues: project.importIssues, proposedAudio: project.audioCues.filter((cue): boolean => cue.timingStatus === 'proposed').length,
    framesWithoutImages: project.frames.filter((frame): boolean => frame.imageAssetId === null).length,
  }, null, 2)}\n`);
}

async function outline(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { handoff: { type: 'string' }, output: { type: 'string' }, 'text-hold-ms': { type: 'string' } }, strict: true, allowPositionals: false });
  const project: Project = createSourceOutline(importPackage(await readPackage(required(values.handoff, '--handoff'))), { proposedTextHoldMs: Number(required(values['text-hold-ms'], '--text-hold-ms')) });
  await writeNewText(required(values.output, '--output'), exportProjectJson(project));
  printProject(project);
}

async function validate(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { project: { type: 'string' } }, strict: true, allowPositionals: false });
  printProject(await readProject(required(values.project, '--project')));
}

async function exportJson(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { project: { type: 'string' }, output: { type: 'string' } }, strict: true, allowPositionals: false });
  const project: Project = await readProject(required(values.project, '--project'));
  await writeNewText(required(values.output, '--output'), exportProjectJson(project));
  printProject(project);
}

async function exportCsv(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { project: { type: 'string' }, output: { type: 'string' } }, strict: true, allowPositionals: false });
  const project: Project = await readProject(required(values.project, '--project'));
  await writeNewText(required(values.output, '--output'), exportShotCsv(project));
  printProject(project);
}

const help: string = `콘티 제작 도구\n\ndocuments-preview --input <제작 문서 디렉터리> [--bindings <연결 JSON>]\ndocuments-package --input <제작 문서 디렉터리> --settings <설정 JSON> --output <새 패키지 디렉터리>\noutline --handoff <storyboard_handoff.json> --output <project.json> --text-hold-ms <정수>\nvalidate --project <project.json>\nexport-json --project <project.json> --output <새 JSON 경로>\nexport-csv --project <project.json> --output <새 CSV 경로>\n\noutline은 수동 편집용 초안을 생성합니다. 구도·그림과 실제 음성 길이는 아직 확정되지 않습니다.\n`;

async function documentsPreview(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { input: { type: 'string' }, bindings: { type: 'string' } }, strict: true, allowPositionals: false });
  const bindings = values.bindings === undefined ? { people: [], scenes: [], units: [] } : DocumentBindingsSchema.parse(parseJson(await readUtf8(values.bindings), values.bindings));
  const preview = inspectDocuments(await readDocumentSources(required(values.input, '--input')), bindings).preview;
  process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
}

async function documentsPackage(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { input: { type: 'string' }, settings: { type: 'string' }, output: { type: 'string' } }, strict: true, allowPositionals: false });
  const settingsPath: string = required(values.settings, '--settings');
  const result = await writeDocumentPackage(required(values.input, '--input'), parseJson(await readUtf8(settingsPath), settingsPath), required(values.output, '--output'));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case 'outline': await outline(rest); return;
    case 'validate': await validate(rest); return;
    case 'export-json': await exportJson(rest); return;
    case 'export-csv': await exportCsv(rest); return;
    case 'documents-preview': await documentsPreview(rest); return;
    case 'documents-package': await documentsPackage(rest); return;
    case '--help': process.stdout.write(help); return;
    default: throw contractError('UNKNOWN_COMMAND', help, []);
  }
}

try {
  await main(process.argv.slice(2));
} catch (error: unknown) {
  if (!(error instanceof Error)) throw error;
  process.stderr.write(`${JSON.stringify({ level: 'error', code: 'code' in error ? error.code : error.name, message: error.message,
    issues: error instanceof ZodError ? error.issues : 'issues' in error ? error.issues : [], stack: error.stack,
  })}\n`);
  process.exitCode = 1;
}
