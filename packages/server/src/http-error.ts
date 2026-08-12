/** Thrown by route handlers to produce a specific JSON error response. */
export class HttpError extends Error {
  status: number;
  detail?: unknown;

  constructor(status: number, message: string, detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.detail = detail;
  }
}

/** Best-effort classification of errors thrown by @reviewer/core. */
export function classifyError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const message = err instanceof Error ? err.message : String(err);

  if (/^No PR state at /.test(message) || /^No files\.json for revision/.test(message)) {
    return new HttpError(404, "not_found", message);
  }
  if (/^gh .* failed:/.test(message)) {
    return new HttpError(502, "gh_failed", message);
  }
  if (/^Invalid PR key/.test(message) || /^Not a pull request URL/.test(message)) {
    return new HttpError(400, "invalid_key", message);
  }
  if (/does not cover \d+ hunk|references \d+ hunk id/.test(message)) {
    return new HttpError(400, "validation_error", message);
  }
  if ((err as { name?: string } | null)?.name === "ZodError") {
    return new HttpError(400, "validation_error", (err as { issues?: unknown }).issues ?? message);
  }
  return new HttpError(500, "internal_error", message);
}
