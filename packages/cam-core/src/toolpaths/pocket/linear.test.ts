import type { PocketParams, Shape } from "@furrow/document";
import { describe, expect, it } from "vitest";
import {
  below,
  dumbbell,
  expectNoLinkThroughStock,
  island,
  lifts,
  pocketOperation,
  pocketTool,
  square,
} from "../link-test-utils";
import { pocketToolpath } from "./pocket";

// The moves linear clearing makes without retracting (#574): along the lap
// from pass to pass, and through the cleared depth to the nearest pass left.
// Unlike peel's, its cuts aren't checked for width: the first pass beside an
// island cuts full width, with no pass next to it yet. A link through the
// cleared depth that leaves the area is caught by the clearing outside the
// paths in pocket.test.ts (#386); a link along the lap runs on what the lap cut.

const options = { safeZ: 5, entryClearance: 1 };

function linear(angle: 0 | 90 | 45 | -45, shapes: Shape[], overrides: Partial<PocketParams> = {}) {
  const operation = pocketOperation({ strategy: { type: "linear", angle }, ...overrides }, shapes);
  return pocketToolpath(operation, shapes, options);
}

describe("linear clearing links", () => {
  for (const angle of [0, 45, -45, 90] as const) {
    for (const ramp of [false, true]) {
      it(`stays down around an island without cutting through stock, at ${angle}°${ramp ? ", ramping" : ""}`, () => {
        const toolpath = linear(angle, [square, island], { ramp });
        // Below the first level, every pass linked to the next at depth: out at the end, and at
        // most once to come back down onto a lap.
        expect(lifts(below(toolpath, -2))).toBeLessThanOrEqual(2);
        expectNoLinkThroughStock(toolpath, pocketTool, 100, 100);
      });
    }
  }

  it("crosses a neck the passes leave without cutting through stock", () => {
    for (const angle of [0, 90] as const) {
      const toolpath = linear(angle, [dumbbell], { allowance: 1 });
      expectNoLinkThroughStock(toolpath, pocketTool, 100, 40);
    }
  });
});
