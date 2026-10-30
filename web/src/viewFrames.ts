import { sourceUrl } from "./sources";
import type { Schemas, Selected } from "./types";

async function fetchBuffer(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? "Request failed");
  }
  return response.arrayBuffer();
}

