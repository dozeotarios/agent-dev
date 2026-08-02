/**
 * project modes (ARCHITECTURE.md §11, AC-GIT-5..8).
 *
 * no-mistakes · direct-PR (default) · local-only · +yolo.
 * Every mode except +yolo requires operator confirmation before committing
 * (AC-GIT-1/2); +yolo auto-commits/pushes (AC-GIT-8). Only direct-PR and
 * +yolo push to a remote.
 */

export const PROJECT_MODES = ["no-mistakes", "direct-PR", "local-only", "+yolo"] as const;
export type ProjectMode = (typeof PROJECT_MODES)[number];

export const DEFAULT_PROJECT_MODE: ProjectMode = "direct-PR";

export function validateMode(mode: string): ProjectMode {
  if (!(PROJECT_MODES as readonly string[]).includes(mode)) {
    throw new Error(`unknown project mode: ${mode}`);
  }
  return mode as ProjectMode;
}

/** AC-GIT-1/2/8: +yolo is the only mode that bypasses the confirmation gate. */
export function requiresConfirm(mode: ProjectMode): boolean {
  return mode !== "+yolo";
}

/** Whether the mode pushes to a remote at all (local-only / no-mistakes don't). */
export function allowsPush(mode: ProjectMode): boolean {
  return mode === "direct-PR" || mode === "+yolo";
}
