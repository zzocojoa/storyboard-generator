import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { contractError } from '../domain/errors.js';
import { sha256Text } from '../importers/integrity.js';
import { SafeStoreFilesystem, sameFileIdentity } from '../server/safe-filesystem.js';
import type { FileIdentity } from '../server/safe-filesystem.js';
import type { ReviewFile } from './review-bundle.js';

export const ReviewOutputClaimSchema = z.strictObject({
  version: z.literal(1), outputHash: z.string().regex(/^[a-f0-9]{64}$/), host: z.string().min(1), pid: z.number().int().positive(), transactionId: z.uuid(), createdAt: z.iso.datetime(),
});
type ReviewOutputClaim = z.infer<typeof ReviewOutputClaimSchema>;
type OwnedClaim = { metadata: ReviewOutputClaim; identity: FileIdentity; bytes: string };
function codeOf(error: unknown): string { return error instanceof Error && 'code' in error ? String(error.code) : 'UNKNOWN'; }
function recoveryRequired(message: string): never { throw contractError('REVIEW_BUNDLE_CLAIM_RECOVERY_REQUIRED', message, []); }
function outputExists(outputHash: string): never { throw contractError('REVIEW_BUNDLE_EXISTS', `다른 Writer가 출력 경로를 사용하거나 Bundle이 이미 존재합니다. outputHash=${outputHash}`, []); }

/** 원본 밖의 출력 Claim으로 Writer를 직렬화하며 자신이 만든 staging만 정리한다. */
export class ReviewBundlePublisher {
  readonly #fs: SafeStoreFilesystem;
  readonly #output: string;
  readonly #hash: string;
  readonly #claimPath: string;
  constructor(fs: SafeStoreFilesystem, output: string) {
    this.#fs = fs; this.#output = output; this.#hash = sha256Text(output); this.#claimPath = fs.path(`.review-${this.#hash}.claim`);
  }
  async #acquire(): Promise<OwnedClaim> {
    for (const entry of await this.#fs.entries(this.#fs.root())) {
      if (!entry.name.startsWith(`.publish-.review-${this.#hash}.claim-`)) continue;
      const path: string = this.#fs.path(entry.name);
      if (!await this.#fs.exists(path)) continue;
      const temporaryOwner: RegExpMatchArray | null = entry.name.match(/-([a-f0-9]{16})\.([0-9]+)\.([a-f0-9-]{36})\.tmp$/);
      if (temporaryOwner !== null && temporaryOwner[1] === sha256Text(hostname()).slice(0, 16)) {
        const pid: number = Number(temporaryOwner[2]);
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); continue; }
          catch (error: unknown) { if (codeOf(error) !== 'ESRCH') recoveryRequired(`Claim 게시 Process를 증명할 수 없습니다. outputHash=${this.#hash}, pid=${pid}, cause=${codeOf(error)}`); }
        }
      }
      let previous: ReviewOutputClaim;
      try { previous = ReviewOutputClaimSchema.parse(JSON.parse(await this.#fs.readText(path)) as unknown); }
      catch (error: unknown) { if (!await this.#fs.exists(path)) continue; recoveryRequired(`출력 Claim 게시 임시 파일을 보존합니다. outputHash=${this.#hash}, cause=${error instanceof Error ? error.message : String(error)}`); }
      this.#requireLiveClaim(previous);
    }
    const metadata: ReviewOutputClaim = { version: 1, outputHash: this.#hash, host: hostname(), pid: process.pid, transactionId: randomUUID(), createdAt: new Date().toISOString() };
    const bytes: string = JSON.stringify(metadata);
    try {
      const identity: FileIdentity = await this.#fs.publishExclusiveFileWithIdentity(this.#claimPath, bytes, `${sha256Text(hostname()).slice(0, 16)}.${process.pid}.${metadata.transactionId}`);
      return { metadata, bytes, identity };
    } catch (error: unknown) {
      if (codeOf(error) !== 'EXCLUSIVE_FILE_EXISTS') recoveryRequired(`출력 Claim을 원자 게시할 수 없습니다. outputHash=${this.#hash}, cause=${error instanceof Error ? error.message : String(error)}`);
      let prior: ReviewOutputClaim;
      try { prior = ReviewOutputClaimSchema.parse(JSON.parse(await this.#fs.readText(this.#claimPath)) as unknown); }
      catch (failure: unknown) {
        if (!await this.#fs.exists(this.#claimPath)) outputExists(this.#hash);
        recoveryRequired(`기존 출력 Claim을 검증할 수 없습니다. outputHash=${this.#hash}, cause=${failure instanceof Error ? failure.message : String(failure)}`);
      }
      this.#requireLiveClaim(prior); outputExists(this.#hash);
    }
  }
  #requireLiveClaim(metadata: ReviewOutputClaim): void {
    if (metadata.outputHash !== this.#hash || metadata.host !== hostname()) recoveryRequired(`출력 Claim의 경로 또는 Host를 확인해야 합니다. outputHash=${this.#hash}, host=${metadata.host}`);
    try { process.kill(metadata.pid, 0); }
    catch (error: unknown) { recoveryRequired(`중단되었거나 소유권이 불명확한 출력 Claim을 보존합니다. outputHash=${this.#hash}, pid=${metadata.pid}, cause=${codeOf(error)}`); }
  }
  async #verifyClaim(claim: OwnedClaim): Promise<void> {
    if (!sameFileIdentity(claim.identity, await this.#fs.identity(this.#claimPath)) || await this.#fs.readText(this.#claimPath) !== claim.bytes) {
      recoveryRequired(`출력 Claim의 소유권이 변경됐습니다. outputHash=${this.#hash}, transactionId=${claim.metadata.transactionId}`);
    }
  }
  async #release(claim: OwnedClaim): Promise<void> {
    await this.#verifyClaim(claim); await this.#fs.unlinkFile(this.#claimPath, claim.identity); await this.#fs.syncDirectory(this.#fs.root());
  }
  async #directoryIdentity(path: string): Promise<FileIdentity> {
    await this.#fs.requireDirectory(path); const metadata = await lstat(path);
    return { dev: metadata.dev, ino: metadata.ino };
  }
  async #writeFiles(staging: string, files: readonly ReviewFile[]): Promise<void> {
    const directories: Set<string> = new Set<string>([staging]);
    for (const file of files) {
      const components: string[] = file.path.split('/'); components.pop(); let parent: string = staging;
      for (const component of components) { parent = join(parent, component); await this.#fs.ensureDirectory(parent); directories.add(parent); }
      await this.#fs.writeExclusive(join(staging, file.path), file.content);
    }
    for (const directory of [...directories].sort((left: string, right: string): number => right.length - left.length)) await this.#fs.syncDirectory(directory);
  }
  async publish(files: readonly ReviewFile[], assertSourceUnchanged: () => Promise<void>): Promise<void> {
    const claim: OwnedClaim = await this.#acquire();
    const staging: string = this.#fs.path(`.review-${this.#hash}-${claim.metadata.transactionId}`);
    let stagingIdentity: FileIdentity | null = null; let published: boolean = false;
    try {
      if (await this.#fs.exists(this.#output)) outputExists(this.#hash);
      await mkdir(staging); stagingIdentity = await this.#directoryIdentity(staging);
      await this.#fs.syncDirectory(dirname(staging));
      await this.#writeFiles(staging, files); await assertSourceUnchanged();
      await this.#verifyClaim(claim);
      if (!sameFileIdentity(stagingIdentity, await this.#directoryIdentity(staging))) recoveryRequired(`출력 staging identity가 변경됐습니다. outputHash=${this.#hash}`);
      if (await this.#fs.exists(this.#output)) outputExists(this.#hash);
      await this.#fs.renameNewDirectory(staging, this.#output); published = true;
      await this.#fs.syncDirectory(this.#fs.root());
    } catch (error: unknown) {
      if (published) recoveryRequired(`Bundle은 게시됐지만 Directory 내구성 확인이 실패했습니다. outputHash=${this.#hash}, cause=${error instanceof Error ? error.message : String(error)}`);
      try {
        await this.#verifyClaim(claim);
        if (stagingIdentity !== null) {
          if (!sameFileIdentity(stagingIdentity, await this.#directoryIdentity(staging))) recoveryRequired(`정리 대상 staging 소유권이 다릅니다. outputHash=${this.#hash}`);
          await this.#fs.removeTree(staging); await this.#fs.syncDirectory(this.#fs.root());
        }
        await this.#release(claim);
      } catch (cleanupError: unknown) { recoveryRequired(`출력 실패 후 자기 Claim·staging을 정리할 수 없습니다. outputHash=${this.#hash}, cause=${error instanceof Error ? error.message : String(error)}, cleanup=${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`); }
      if (['EEXIST', 'ENOTEMPTY'].includes(codeOf(error))) outputExists(this.#hash);
      if (codeOf(error) === 'ENOENT') throw contractError('REVIEW_BUNDLE_WRITE_FAILED', `출력 중 파일 또는 Directory가 사라졌습니다. outputHash=${this.#hash}`, []);
      throw error;
    }
    try { await this.#release(claim); }
    catch (error: unknown) { recoveryRequired(`Bundle 게시 후 Claim 정리를 확인할 수 없습니다. outputHash=${this.#hash}, cause=${error instanceof Error ? error.message : String(error)}`); }
  }
}
