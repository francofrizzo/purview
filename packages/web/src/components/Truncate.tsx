/**
 * Middle-truncating text. End-truncation is useless for generated filenames
 * that share a long prefix (`payment_receipt_notification_…`), so keep the
 * distinguishing tail — and the extension — visible:
 * `payment_receipt_…_email.tmpl`.
 *
 * Done in CSS rather than by counting characters so it stays correct at any
 * pane width: the head shrinks and ellipsises, the tail is never squeezed.
 */
/**
 * Length of the tail to keep, nudged to the nearest `_ - . /` within a few
 * characters so the visible tail starts at a word boundary
 * (`…_recording_test.go`, not `…rding_test.go`).
 */
function tailStart(text: string, tail: number): number {
  const ideal = text.length - tail;
  for (let i = Math.max(1, ideal - 6); i <= Math.min(text.length - 4, ideal + 6); i++) {
    if ("_-./".includes(text[i])) return text.length - i;
  }
  return tail;
}

export function MiddleTruncate({
  text,
  tail = 12,
  className,
  title,
}: {
  text: string;
  /** how many trailing characters to always keep */
  tail?: number;
  className?: string;
  title?: string;
}) {
  const keep = text.length > tail + 4 ? tailStart(text, tail) : 0;
  const head = keep ? text.slice(0, text.length - keep) : text;
  const rest = keep ? text.slice(text.length - keep) : "";
  return (
    // overflow-hidden so an extremely tight container clips the tail instead of
    // letting it spill over whatever sits next to it
    <span
      className={`flex min-w-0 items-baseline overflow-hidden ${className ?? ""}`}
      title={title ?? text}
    >
      <span className="truncate">{head}</span>
      {rest ? <span className="flex-none whitespace-pre">{rest}</span> : null}
    </span>
  );
}
