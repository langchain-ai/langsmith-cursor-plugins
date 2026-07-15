import { describe, expect, it } from "vitest";
import { MIN_NODE, nodeTooOld } from "../../src/utils/node-version.js";

describe("nodeTooOld", () => {
  it("flags versions below the minimum", () => {
    expect(nodeTooOld("20.11.0")).toBe(true);
    expect(nodeTooOld("22.12.0")).toBe(true);
    expect(nodeTooOld("22.12.99")).toBe(true);
    expect(nodeTooOld("18.0.0")).toBe(true);
  });

  it("accepts the minimum and above", () => {
    expect(nodeTooOld(`${MIN_NODE[0]}.${MIN_NODE[1]}.0`)).toBe(false);
    expect(nodeTooOld("22.13.1")).toBe(false);
    expect(nodeTooOld("22.22.3")).toBe(false);
    expect(nodeTooOld("24.0.0")).toBe(false);
  });

  it("tolerates pre-release / partial strings", () => {
    expect(nodeTooOld("23.0.0-nightly")).toBe(false);
    expect(nodeTooOld("22")).toBe(true); // 22.0 < 22.13
    expect(nodeTooOld("not-a-version")).toBe(false); // unparseable → don't block
  });

  it("honors a custom minimum", () => {
    expect(nodeTooOld("20.0.0", [18, 0])).toBe(false);
    expect(nodeTooOld("16.5.0", [18, 0])).toBe(true);
  });
});
