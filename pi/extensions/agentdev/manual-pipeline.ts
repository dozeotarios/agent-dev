/**
 * manual-pipeline — the deterministic manual-phase sequence (AC-MANUAL-8).
 *
 * Canonical order (choose-stack only for greenfield; stack LOCKED for existing
 * repos); define-constraints is a SOFT-GATE that is never skipped; the final
 * step is the handoff: nextStep returns null → enter ralplan (autopilot).
 */

export type ManualStepId =
  | "map-codebase"
  | "choose-stack"
  | "define-language"
  | "define-constraints"
  | "pick-mode"
  | "enter-ralplan";

export const MANUAL_ORDER: ManualStepId[] = [
  "map-codebase",
  "choose-stack",
  "define-language",
  "define-constraints",
  "pick-mode",
  "enter-ralplan",
];

export interface ManualContext {
  existingRepo: boolean;
  stack: string | null;
  languageDone: boolean;
  constraintsComplete: boolean;
  modePicked: string | null;
}

/** Next unsatisfied step; null = all manual steps satisfied → handoff to ralplan. */
export function nextStep(ctx: ManualContext): ManualStepId | null {
  for (const step of MANUAL_ORDER) {
    if (step === "enter-ralplan") continue; // boundary marker; handoff = null
    switch (step) {
      case "map-codebase":
        continue; // completed by construction (existingRepo is known)
      case "choose-stack":
        if (!ctx.existingRepo && !ctx.stack) return "choose-stack";
        continue; // existing repo → skipped (stack locked from map-codebase)
      case "define-language":
        if (!ctx.languageDone) return "define-language";
        continue;
      case "define-constraints":
        if (!ctx.constraintsComplete) return "define-constraints"; // soft-gate
        continue;
      case "pick-mode":
        if (!ctx.modePicked) return "pick-mode";
        continue;
    }
  }
  return null;
}
