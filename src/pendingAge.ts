// How long a file has been sitting in the Pending panel.
//
// Off by default, and opt-in per threshold. The point is triage, not telemetry:
// a label on EVERY row is a label on nothing, and most of the time the panel
// should just show files. When a backlog does stop draining, setting a threshold
// makes the old entries — and only those — announce themselves.
//
// The exact capture time is always in the hover tooltip regardless, so turning
// the row label off never loses the information.

/** Whole days between `capturedAt` (ISO 8601) and `now`. Returns null when the
 *  timestamp is missing or unparseable — an entry written by an older hook, or a
 *  hand-edited session file, must degrade to "no age" rather than "NaNd". */
export function ageInDays(capturedAt: string | undefined | null, now: Date): number | null {
  if (!capturedAt) return null;
  const then = Date.parse(capturedAt);
  if (Number.isNaN(then)) return null;
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  // A clock skew (or a session file copied from a machine ahead of this one) can
  // make an entry look like it was captured in the future. Clamp to 0 instead of
  // rendering "-3d", which reads as a bug rather than as skew.
  return days < 0 ? 0 : days;
}

/** The short label for a row, e.g. `5d`, or undefined when it should stay clean.
 *
 *  `minDays` is the threshold, and **0 or less means off** — no row gets a label.
 *  Off is the default: the age is a diagnostic for a backlog that has stopped
 *  draining, not something every row needs to carry. A value of 1 labels anything
 *  at least a day old; 14 labels only the genuinely stale.
 *
 *  There is deliberately no "label every row including today's": a `0d` on
 *  everything freshly captured is the noisiest possible setting and the least
 *  informative, so that value does the useful thing instead. */
export function ageLabel(
  capturedAt: string | undefined | null,
  now: Date,
  minDays: number
): string | undefined {
  if (!Number.isFinite(minDays) || minDays <= 0) return undefined;
  const days = ageInDays(capturedAt, now);
  if (days === null || days < minDays) return undefined;
  return `${days}d`;
}

/** Combine the folder path a row may already show with its age label.
 *
 *  In tree mode the description slot is empty (rows are built with
 *  showPath=false), so the age has it to itself. In list mode the relative
 *  directory is already there and the two are joined — the age goes last so the
 *  paths stay left-aligned and scannable. */
export function rowDescription(
  dir: string | undefined,
  age: string | undefined
): string | undefined {
  if (dir && age) return `${dir} · ${age}`;
  return dir || age || undefined;
}

/** Human line for the hover tooltip. Always present when the timestamp parses,
 *  regardless of the threshold — the row stays quiet, the hover stays complete. */
export function ageTooltipLine(
  capturedAt: string | undefined | null,
  now: Date
): string | undefined {
  const days = ageInDays(capturedAt, now);
  if (days === null) return undefined;
  const when = new Date(Date.parse(capturedAt!)).toLocaleString();
  const rel = days === 0 ? "today" : days === 1 ? "1 day ago" : `${days} days ago`;
  return `Captured: ${when} — ${rel}`;
}
