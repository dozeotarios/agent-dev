import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { herdrInfo } from "../helpers/herdr-is-present";

// AC-REAL-1: integration tests run against the REAL installed herdr — no simulation.
const herdr = herdrInfo();
const skip = !herdr.present;

describe.skipIf(skip)("herdr — real-environment smoke (AC-REAL-1)", () => {
  it("is installed and reports a semantic version", () => {
    expect(herdr.present).toBe(true);
    expect(herdr.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("`herdr status client` exits 0 (control surface reachable, read-only)", () => {
    const out = execFileSync("herdr", ["status", "client"], {
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(out).toBeDefined();
  });
});
