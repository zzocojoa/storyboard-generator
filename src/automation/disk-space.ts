import { stat, statfs, realpath } from 'node:fs/promises';
import { contractError } from '../domain/errors.js';
import type { AutomationDiskReport } from './disk-space-schema.js';

export type DiskProbe = { path: string; device: string; availableBytes: bigint };
export type DiskReader = (path: string) => Promise<DiskProbe>;
export type AutomationDiskRoots = { project: string; automation: string; temporary: string };
type DiskDemand = { path: string; bytes: bigint };
const MIB: bigint = 1024n * 1024n;

/** 일반 사용자에게 실제 할당 가능한 블록을 읽는다. 읽기 실패나 잘못된 통계는 여유 공간으로 간주하지 않는다. */
export async function readDiskSpace(path: string): Promise<DiskProbe> {
  try {
    const canonical: string = await realpath(path);
    const before = await stat(canonical, { bigint: true });
    const filesystem = await statfs(canonical, { bigint: true });
    const after = await stat(canonical, { bigint: true });
    if (!before.isDirectory() || before.dev !== after.dev || before.ino !== after.ino || filesystem.bsize <= 0n
      || filesystem.bavail < 0n || filesystem.bavail > filesystem.blocks) throw new Error('폴더 identity 또는 파일시스템 통계가 유효하지 않습니다.');
    return { path: canonical, device: before.dev.toString(), availableBytes: filesystem.bavail * filesystem.bsize };
  } catch (error: unknown) {
    throw contractError('AUTOMATION_DISK_CHECK_FAILED', `저장 공간을 확인하지 못했습니다. 경로와 디스크 연결을 확인한 뒤 이어 만드세요. path=${path}, cause=${error instanceof Error ? error.message : String(error)}`, []);
  }
}

function bytes(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0) throw contractError('AUTOMATION_DISK_POLICY_INVALID', '디스크 검사 바이트 수는 0 이상의 안전한 정수여야 합니다.', []);
  return BigInt(value);
}

/** 같은 장치의 쓰기 예상량은 합산하고 예비 공간은 한 번만 더한다. 실제 공간 예약은 아니다. */
export async function inspectDiskDemands(demands: readonly DiskDemand[], reserve: bigint, reader: DiskReader): Promise<AutomationDiskReport> {
  if (reserve < 0n || demands.length === 0 || demands.some((demand): boolean => demand.bytes < 0n)) throw contractError('AUTOMATION_DISK_POLICY_INVALID', '디스크 검사 대상과 예상량이 유효하지 않습니다.', []);
  const groups: Map<string, { paths: string[]; available: bigint; required: bigint }> = new Map();
  for (const demand of demands) {
    const probe = await reader(demand.path);
    if (probe.availableBytes < 0n || probe.device.length === 0) throw contractError('AUTOMATION_DISK_CHECK_FAILED', `잘못된 디스크 검사 결과입니다: ${demand.path}`, []);
    const prior = groups.get(probe.device);
    groups.set(probe.device, { paths: [...new Set([...(prior?.paths ?? []), probe.path])],
      available: prior === undefined || probe.availableBytes < prior.available ? probe.availableBytes : prior.available,
      required: (prior?.required ?? reserve) + demand.bytes });
  }
  const volumes = [...groups.values()].map((group) => ({ paths: group.paths, availableBytes: group.available.toString(), requiredBytes: group.required.toString(), sufficient: group.available >= group.required }));
  return { checkedAt: new Date().toISOString(), minimumFreeBytes: reserve.toString(), sufficient: volumes.every((volume): boolean => volume.sufficient), volumes };
}

function requireSpace(report: AutomationDiskReport): void {
  if (report.sufficient) return;
  const details = report.volumes.filter((volume): boolean => !volume.sufficient).map((volume): string =>
    `${volume.paths.join(', ')}: 사용 가능 ${(Number(volume.availableBytes) / 1e9).toFixed(2)}GB, 필요 ${(Number(volume.requiredBytes) / 1e9).toFixed(2)}GB (availableBytes=${volume.availableBytes}, requiredBytes=${volume.requiredBytes})`).join('; ');
  throw contractError('AUTOMATION_DISK_SPACE_LOW', `디스크 여유 공간이 부족해 자동 제작을 중단했습니다. 기존 결과는 보존합니다. 공간을 확보한 뒤 ‘이어 만들기’를 누르세요. ${details}`, []);
}

/** 생성 여유와 이미 받은 결과 보존을 구별하는 파일시스템 연결이다. 이전 자산·감사 기록을 삭제하지 않는다. */
export class AutomationDiskSpace {
  readonly #roots: AutomationDiskRoots;
  readonly #reserve: bigint;
  readonly #reader: DiskReader;
  constructor(roots: AutomationDiskRoots, minimumFreeBytes: number, reader: DiskReader) {
    this.#roots = { ...roots }; this.#reserve = bytes(minimumFreeBytes); this.#reader = reader;
  }
  async inspectGeneration(remainingBytes: number): Promise<AutomationDiskReport> {
    const remaining = bytes(remainingBytes);
    return inspectDiskDemands([
      { path: this.#roots.automation, bytes: remaining * 2n + 128n * MIB },
      { path: this.#roots.project, bytes: remaining + 256n * MIB },
      { path: this.#roots.temporary, bytes: 256n * MIB },
    ], this.#reserve, this.#reader);
  }
  async assertGeneration(remainingBytes: number): Promise<void> { requireSpace(await this.inspectGeneration(remainingBytes)); }
  async assertPreservation(incomingBytes: number): Promise<void> {
    // 수신한 결과는 예비 공간 기준보다 우선 보존한다. 실제 쓰기량과 기록용 16MiB는 확보해야 한다.
    requireSpace(await inspectDiskDemands([{ path: this.#roots.automation, bytes: bytes(incomingBytes) + 16n * MIB }], 0n, this.#reader));
  }
  async assertApplication(incomingBytes: number): Promise<void> {
    requireSpace(await inspectDiskDemands([
      { path: this.#roots.project, bytes: bytes(incomingBytes) + 256n * MIB },
      { path: this.#roots.automation, bytes: 16n * MIB },
    ], this.#reserve, this.#reader));
  }
}

export function isDiskInterruption(code: string): boolean {
  return ['AUTOMATION_DISK_SPACE_LOW', 'AUTOMATION_DISK_CHECK_FAILED', 'ENOSPC', 'EDQUOT'].includes(code);
}
