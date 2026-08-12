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
export function errorText(err: unknown): string {
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
