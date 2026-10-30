/**
 * The lines beside a row of a tree: one guide per ancestor that continues
 * below this row, and at the parent's level an elbow into this row, which
 * closes (└) on the last child and carries on (├) otherwise. A row with
 * children can start the stem down to them with `stemFrom`.
 */
export function TreeLines({
  depth,
  guides,
  last,
  indent,
  lineAt,
  elbowY,
  elbowWidth = indent - lineAt,
  stemFrom,
  testId,
}: {
  depth: number;
  /** by level, above the parent's: does that ancestor's line carry on below this row? */
  guides: boolean[];
  last: boolean;
  /** how far each level steps in, in px */
  indent: number;
  /** where a level's line sits inside its indent */
  lineAt: number;
  /** how far down the row the elbow turns */
  elbowY: number;
  elbowWidth?: number;
  stemFrom?: number;
  testId?: string;
}) {
  const x = (level: number) => level * indent + lineAt;
  const line = "1px solid var(--fg-faint)";
  return (
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0" data-testid={testId}>
      {guides.map((continues, level) =>
        continues ? <span key={level} className="absolute inset-y-0" style={{ left: x(level), borderLeft: line }} /> : null,
      )}
      {depth > 0 ? (
        <span
          className="absolute top-0"
          style={{
            left: x(depth - 1),
            width: elbowWidth,
            height: elbowY,
            borderLeft: line,
            borderBottom: line,
            borderBottomLeftRadius: 5,
          }}
        />
      ) : null}
      {depth > 0 && !last ? <span className="absolute inset-y-0" style={{ left: x(depth - 1), borderLeft: line }} /> : null}
      {stemFrom !== undefined ? (
        <span className="absolute bottom-0" style={{ left: x(depth), top: stemFrom, borderLeft: line }} />
      ) : null}
    </span>
  );
}
