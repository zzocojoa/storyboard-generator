import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { BuildManifestSchema } from '../src/build-schema.js';
import type { BuildManifest } from '../src/build-schema.js';
import { ProjectSchema } from '../src/domain/schema.js';

async function buildInputs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[][] = await Promise.all(entries.map(async (entry): Promise<string[]> => entry.isDirectory()
    ? buildInputs(join(directory, entry.name)) : [join(directory, entry.name)]));
  return paths.flat().sort();
}

function buildCommit(): string | null {
  const ciSha: string | undefined = process.env.GITHUB_SHA;
  if (ciSha !== undefined) return z.string().regex(/^[a-f0-9]{40}$/u).parse(ciSha);
  try {
    const dirty: string = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return dirty.length > 0 ? null : execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error: unknown) {
    process.stderr.write(`${JSON.stringify({ level: 'warn', code: 'BUILD_COMMIT_UNKNOWN', message: error instanceof Error ? error.message : String(error) })}\n`);
    return null;
  }
}

const packageInfo = z.object({ version: z.string() }).parse(JSON.parse(await readFile('package.json', 'utf8')) as unknown);
const paths: string[] = [...await buildInputs('src'), ...await buildInputs('web'), 'package.json', 'package-lock.json'].sort();
const digest = createHash('sha256');
for (const path of paths) { digest.update(path); digest.update('\0'); digest.update(await readFile(path)); digest.update('\0'); }
const manifest: BuildManifest = BuildManifestSchema.parse({ commitSha: buildCommit(), appVersion: packageInfo.version,
  projectSchemaVersion: ProjectSchema.shape.schemaVersion.value, builtAt: new Date().toISOString(), sourceTreeSha256: digest.digest('hex'),
  journalVersion: 3, lockVersion: 3, registryVersion: 1 });
await mkdir('.build', { recursive: true });
await writeFile('.build/build-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(manifest)}\n`);
