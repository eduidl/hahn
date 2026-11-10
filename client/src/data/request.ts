import { responseError } from "./errors";

/** Sends a request to the server, failing with the server's error when it answers with one. */
export async function request(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw await responseError(response);
  return response;
}

/** Reads a JSON resource. */
export async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  return (await request(url, { signal })).json();
}
