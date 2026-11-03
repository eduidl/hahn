import type { Schemas } from "../types";

/**
 * A failure the server reported, identified by its code. The code is a plain string
 * here: a newer server may send one this client does not know, which is still a failure.
 */
export class ServerError extends Error {
  constructor(
    message: string,
    readonly code: Schemas["ErrorCode"] | (string & {}),
  ) {
    super(message);
  }
}

/** The server answered with an error status, as opposed to not being reachable. */
export class HttpError extends ServerError {
  constructor(
    message: string,
    code: string,
    readonly status: number,
  ) {
    super(message, code);
  }
}

/** The error of a failed response, from its `{code, error}` body when it has one. */
export async function responseError(response: Response): Promise<HttpError> {
  const body = await response.json().catch(() => null);
  return new HttpError(
    body?.error ?? `HTTP ${response.status}`,
    body?.code ?? "internal_error",
    response.status,
  );
}
