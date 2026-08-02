/**
 * Type declarations for bin/agentdev-install.mjs (the launcher/installer CLI).
 * Tests import the exported helpers; the CLI itself runs under plain node.
 */

export interface EnsureResult {
  present?: boolean;
  running?: boolean;
  registered?: boolean;
  global?: boolean;
  version?: string | null;
}

export function ensureHerdr(checkOnly?: boolean): EnsureResult;
export function ensureHerdrServer(checkOnly?: boolean): EnsureResult;
export function ensurePi(checkOnly?: boolean): EnsureResult;
export function ensureBrain(checkOnly?: boolean): EnsureResult;
export function ensureGlobalBin(checkOnly?: boolean): EnsureResult;
export function toggleFile(cwd: string): string;
export function readToggleState(cwd: string): boolean;
export function main(argv?: string[]): number;
