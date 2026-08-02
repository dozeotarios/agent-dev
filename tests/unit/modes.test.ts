import { describe, expect, it } from "vitest";
import {
  PROJECT_MODES,
  DEFAULT_PROJECT_MODE,
  validateMode,
  requiresConfirm,
  allowsPush,
} from "../../pi/extensions/agentdev/modes";

// AC-GIT-1/2/8: commits gated on operator confirm EXCEPT +yolo (auto-commits).
describe("project modes (AC-GIT-5..8)", () => {
  it("has exactly the four modes", () => {
    expect(PROJECT_MODES).toEqual(["no-mistakes", "direct-PR", "local-only", "+yolo"]);
  });

  it("defaults to direct-PR", () => {
    expect(DEFAULT_PROJECT_MODE).toBe("direct-PR");
  });

  it("validates known modes and rejects unknown ones", () => {
    expect(validateMode("direct-PR")).toBe("direct-PR");
    expect(() => validateMode("yolo")).toThrow(/unknown project mode/);
  });

  it("every mode except +yolo requires operator confirmation (AC-GIT-1/2/8)", () => {
    for (const mode of PROJECT_MODES) {
      expect(requiresConfirm(mode)).toBe(mode !== "+yolo");
    }
  });

  it("only direct-PR and +yolo allow pushing", () => {
    expect(allowsPush("direct-PR")).toBe(true);
    expect(allowsPush("+yolo")).toBe(true);
    expect(allowsPush("local-only")).toBe(false);
    expect(allowsPush("no-mistakes")).toBe(false);
  });
});
