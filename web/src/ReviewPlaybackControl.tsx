import type { ReactElement } from 'react';
import { REVIEW_PLAYBACK_RATES, ReviewPlaybackRateSchema } from './review-playback.js';
import type { ReviewPlaybackPreference } from './useReviewPlayback.js';

export function ReviewPlaybackControl(props: { preference: ReviewPlaybackPreference }): ReactElement {
  return <div className="review-playback-control"><label>검토 속도<select aria-label="검토 속도" value={props.preference.rate ?? ''}
    onChange={(event): void => { props.preference.setRate(ReviewPlaybackRateSchema.parse(Number(event.target.value))); }}>
    <option value="" disabled>속도 선택</option>{REVIEW_PLAYBACK_RATES.map((rate): ReactElement => <option key={rate} value={rate}>{rate}배</option>)}
  </select></label>{props.preference.error !== null && <p role="alert">{props.preference.error}</p>}</div>;
}
