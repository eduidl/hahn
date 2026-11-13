/**
 * The run the address asks to open, such as `?run=<id>`. Unless `keep` is set, it is
 * removed from the address so that a later reload restores the saved session instead.
 */
export function takeRequestedRun(keep = false): string | null {
  const url = new URL(window.location.href);
  const run = url.searchParams.get("run");
  if (run === null || keep) return run || null;
  url.searchParams.delete("run");
  window.history.replaceState(window.history.state, "", url);
  return run || null;
}
