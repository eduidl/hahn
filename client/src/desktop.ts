import { invoke, isTauri } from "@tauri-apps/api/core";

/**
 * Hahn's desktop app shows this client in its own window. There the user picks a
 * recording from their files, and the app serves it as the only run (ADR 0011).
 */
export const inDesktopApp = (): boolean => isTauri();

/**
 * Asks the desktop app to show its file dialog. When a recording is picked, the app
 * serves it and reloads this page on it; otherwise nothing changes.
 */
export function selectRecording(): void {
  invoke("select_recording").catch((error: unknown) => console.error(error));
}

/** What a widget says while no run is open. */
export const noRunHint = (): string =>
  inDesktopApp()
    ? "Open a run from the header, or drop an MCAP file onto the window"
    : "Open a run from the header";
