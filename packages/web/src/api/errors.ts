/**
 * Lives apart from `client.ts` so the mock server can throw the same errors
 * the real transport does without importing the client (which imports it).
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The server puts its error *code* in the `error` field, which the transport
 * lifts into `ApiError.message` — so this is the code to branch on when an
 * edit touches an already-public comment.
 */
export const CONFIRM_REQUIRED_PUBLIC_EDIT = "confirm_required_public_edit";

export const isConfirmRequired = (err: unknown): boolean =>
  err instanceof ApiError && err.status === 400 && err.message === CONFIRM_REQUIRED_PUBLIC_EDIT;

/** Human text for an ApiError, preferring the server's `detail` prose. */
/**
 * The request got no answer at all: the browser's own TypeError ("Failed to
 * fetch" in Chrome, "NetworkError…" in Firefox, "Load failed" in Safari),
 * not anything Purview's server said. The server stopped, restarted (a
 * rebuild) or the connection dropped, possibly after the work was done.
 */
export function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError && /failed to fetch|networkerror|load failed|network connection/i.test(err.message);
}

export const NETWORK_ERROR_TEXT = "Purview's server did not answer. It may have restarted or stopped.";

export function errorText(err: unknown): string {
  if (isNetworkError(err)) return NETWORK_ERROR_TEXT;
  if (err instanceof ApiError) {
    const detail =
      err.detail && typeof err.detail === "object" && "detail" in err.detail
        ? (err.detail as { detail?: unknown }).detail
        : undefined;
    if (typeof detail === "string" && detail) return detail;
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}
