import { readdir, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { contractError } from '../src/domain/errors.js';

const REQUIRED_TEST_NAMES: readonly string[] = [
  'proposal_frames_accept_optional_plan',
  'legacy_proposal_without_frames_remains_compatible',
  'project_1_5_migrates_visual_mode_to_sourced',
  'schema_1_6_round_trip_preserves_visual_mode',
  'sourced_shot_requires_start_frame_at_zero',
  'late_source_anchor_creates_key_frame',
  'key_frame_offset_matches_anchor_start',
  'key_frame_context_includes_newly_active_source',
  'early_frame_context_excludes_future_source',
  'key_frame_context_respects_information_gate',
  'sourced_visual_coverage_rejects_start_gap',
  'sourced_visual_coverage_rejects_middle_gap',
  'sourced_visual_coverage_accepts_adjacent_half_open_ranges',
  'black_visual_mode_allows_no_direct_visual_source',
  'black_mode_disables_image_generation',
  'black_mode_renders_deterministic_output',
  'hold_previous_mode_requires_previous_contiguous_shot',
  'hold_previous_uses_previous_output_safe_frame',
  'hold_previous_without_safe_frame_is_blocked',
  'non_sourced_mode_rejects_direct_visual_links',
  'proposal_information_without_source_does_not_report_infinity',
  'periodic_heartbeat_starts_after_initialize',
  'periodic_heartbeat_keeps_long_transaction_live',
  'periodic_heartbeat_is_shared_per_root_and_instance',
  'periodic_heartbeat_timer_is_unrefed',
  'periodic_heartbeat_stops_after_last_store_close',
  'heartbeat_failure_is_exposed_in_status',
  'audit_scans_union_of_all_version_record_ids',
  'audit_reports_record_removed_before_current',
  'audit_detects_intermediate_metadata_mutation',
  'audit_detects_record_reappearance',
  'audit_reports_mixed_current_and_historical_shot_targets',
  'audit_reports_historical_asset_targets',
  'audit_uses_consistent_current_and_version_snapshot',
  'audit_retries_once_when_current_changes',
  'audit_returns_conflict_when_snapshot_keeps_changing',
  'audit_does_not_modify_project_or_versions',
  'malformed_recovery_marker_is_quarantined',
  'invalid_recovery_marker_does_not_block_unrelated_project_list',
  'invalid_recovery_marker_does_not_block_unrelated_update',
  'invalid_recovery_marker_does_not_block_unrelated_create',
  'status_exposes_invalid_recovery_markers',
  'valid_recovery_marker_still_blocks_only_own_project',
  'stored_asset_path_unsafe_returns_asset_scope_423',
  'stored_asset_symlink_error_is_not_validation_400',
  'stored_asset_path_issue_does_not_block_project_mutation',
  'asset_integrity_endpoint_reports_current_output_references',
  'asset_integrity_reconcile_clears_repaired_asset',
  'unreferenced_historical_corrupt_asset_does_not_keep_current_ui_banner',
  'project_refresh_reconciles_asset_integrity_issues',
  'open_ended_placement_uses_explicit_text_cue_end',
  'open_ended_placement_uses_canonical_end_when_no_cue_end',
  'open_ended_placement_without_resolved_end_requires_review',
  'expired_open_ended_placement_is_excluded_from_frame_context',
  'future_text_mapping_does_not_leak_after_effective_end',
  'duration_does_not_add_start_timecode',
  'absolute_timecode_adds_start_timecode_once',
  'drop_frame_2997_skips_labels_at_minute',
  'drop_frame_2997_keeps_tenth_minute',
  'drop_frame_5994_skips_four_labels',
  'drop_frame_wraps_at_24_hours',
  'project_rail_uses_duration_formatter',
  'timeline_and_exports_use_absolute_formatter',
  'status_refreshes_stale_active_create',
  'status_refreshes_stale_active_update',
  'status_does_not_fail_for_unrelated_malformed_lock',
  'status_exposes_heartbeat_health',
  'status_snapshot_is_idempotent',
  'e2e_late_anchor_key_frame_is_visible',
  'e2e_project_recovery_disables_only_selected_project',
  'e2e_asset_integrity_notice_clears_after_reconcile',
  'e2e_24fps_and_duration_timecode_are_distinct',
  'e2e_audio_seek_and_end_cleanup',
  'e2e_409_and_503_do_not_create_persistent_project_block',
  'e2e_black_and_hold_previous_visual_modes',
];

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested: string[][] = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path: string = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return extname(entry.name) === '.ts' ? [path] : [];
  }));
  return nested.flat();
}

function declaredTestNames(source: string): string[] {
  return [...source.matchAll(/\b(?:it|test)\s*\(\s*(['"`])([^'"`]+)\1/gu)].map((match: RegExpMatchArray): string => match[2] as string);
}

const files: string[] = await sourceFiles('tests');
const sources: string[] = await Promise.all(files.map((file: string): Promise<string> => readFile(file, 'utf8')));
const names: string[] = sources.flatMap(declaredTestNames);
const counts: Map<string, number> = new Map<string, number>();
for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
const missing: string[] = REQUIRED_TEST_NAMES.filter((name: string): boolean => !counts.has(name));
const duplicates: string[] = REQUIRED_TEST_NAMES.filter((name: string): boolean => (counts.get(name) ?? 0) > 1);
const skipCount: number = sources.reduce((total: number, source: string): number => total + [...source.matchAll(/\b(?:describe|it|test)\.skip\s*\(/gu)].length, 0);
const onlyCount: number = sources.reduce((total: number, source: string): number => total + [...source.matchAll(/\b(?:describe|it|test)\.only\s*\(/gu)].length, 0);
const result = { required: REQUIRED_TEST_NAMES.length, missing: missing.length, duplicates: duplicates.length, skip: skipCount, only: onlyCount };
process.stdout.write(`${JSON.stringify(result)}\n`);
if (missing.length > 0 || duplicates.length > 0 || skipCount > 0 || onlyCount > 0) {
  throw contractError('REQUIRED_TEST_CONTRACT_FAILED', `필수 테스트 계약이 맞지 않습니다. missing=${missing.join(',') || '0'}, duplicates=${duplicates.join(',') || '0'}, skip=${skipCount}, only=${onlyCount}`, []);
}
