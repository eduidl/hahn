import { useEffect, useRef } from "react";
import { initialWorkspace } from "./widgets";
import { browserStorage, clearSession, saveSession, type Session } from "./persistence";

/**
 * Saves the session shortly after changes settle, and on leaving in case they have not.
 * Nothing is saved while `restoring`, so a half-restored state cannot overwrite the session.
 */
export function useSession(current: Session, restoring: boolean) {
  const { workspace, runId, sources, zoneSource, timeDisplay, tab, sidebarWidth, sidebarOpen } =
    current;
  const session = useRef<Session | null>(null);
  const discarded = useRef(false);
  const saveCurrent = () => {
    if (session.current && !discarded.current) saveSession(browserStorage(), session.current);
  };
  useEffect(() => {
    session.current = restoring ? null : current;
    const timer = setTimeout(saveCurrent, 300);
    return () => clearTimeout(timer);
  }, [
    restoring,
    workspace,
    runId,
    sources,
    zoneSource,
    timeDisplay,
    tab,
    sidebarWidth,
    sidebarOpen,
  ]);
  useEffect(() => {
    window.addEventListener("pagehide", saveCurrent);
    return () => window.removeEventListener("pagehide", saveCurrent);
  }, []);
  /** Replaces the saved layout with the initial one and reloads into it. */
  const resetWorkspace = () => {
    discarded.current = true;
    // Clear first so a failed save still resets instead of keeping the old layout.
    clearSession(browserStorage());
    saveSession(browserStorage(), { ...current, workspace: initialWorkspace() });
    location.reload();
  };
  return resetWorkspace;
}
