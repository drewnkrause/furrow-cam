import type { Model, ReliefFinishOperation, Tool } from "@furrow/document";
import { ballEndMill, endMill } from "@furrow/document/fixtures";
import { describe, expect, it } from "vitest";
import {
  expectFeedsAboveModel,
  PYRAMID,
  pyramidMesh,
  RIDGE,
  retracts,
  ridgeMesh,
  STEP,
  stepMesh,
  TWIN,
  twinMesh,
} from "../link-test-utils";
import type { Toolpath } from "../toolpath";
import { runSteps } from "./finish";
import { reliefFinishSteps } from "./finishing";

// The feeds waterline finishing makes without retracting (#574): from one
// contour to the next, and down from one level to the next.

function waterline(
  tool: Tool,
  model: Model,
  stepDown: number,
  rest = false,
): ReliefFinishOperation {
  return {
    id: "3d2c1b0a-9f8e-4d7c-8b6a-5f4e3d2c1b0a",
    type: "relief_finish",
    name: "Waterline",
    enabled: true,
    stockSide: "top",
    targets: [],
    tool,
    params: {
      modelId: model.id,
      strategy: { type: "waterline", stepDown },
      stepOver: 20,
      stockToLeave: 0,
      boundary: { type: "model" },
      rest,
    },
  };
}

/**
 * Tools are dropped onto cell centres (ADR-0030), so a flat rim reaches up to
 * a cell's worth of the pyramid's slope between them.
 */
const SAMPLING = 0.8 * 0.1 + 0.005;

const options = { safeZ: 5, entryClearance: 1 };

function finish(tool: Tool, model: Model, mesh: Float32Array, stepDown: number): Toolpath {
  return runSteps(reliefFinishSteps(waterline(tool, model, stepDown), model, mesh, options));
}

describe("waterline links", () => {
  it("feeds down from level to level along a wall without going into the model", () => {
    // Contours along the wall, a level apart and right above each other: well within reach.
    const toolpath = finish(endMill, STEP, stepMesh, 1);
    expect(expectFeedsAboveModel(toolpath, endMill, STEP, stepMesh, 0.005)).toBeGreaterThanOrEqual(
      4,
    );
    expect(retracts(toolpath)).toBeLessThanOrEqual(2);
  });

  it("retracts over a ridge between contours in reach rather than feeding through it", () => {
    // Below the ridge, a contour either side of it, 10.35 mm apart: in the
    // flat end mill's 12.7 mm reach, but the straight way is through the ridge.
    const toolpath = finish(endMill, RIDGE, ridgeMesh, 1);
    expectFeedsAboveModel(toolpath, endMill, RIDGE, ridgeMesh, 0.005);
    const levels = new Set(
      toolpath.moves.filter(({ kind, to }) => kind === "feed" && to[2] < -2).map(({ to }) => to[2]),
    );
    // Over the ridge once on each of the six levels below it, and out at the end.
    expect(levels.size).toBe(6);
    expect(retracts(toolpath)).toBeGreaterThanOrEqual(levels.size + 1);
  });

  it("retracts between contours out of reach, never feeding through the model", () => {
    // Around two pyramids, the 3 mm ball end mill's reach is less than the valley between them.
    const toolpath = finish(ballEndMill, TWIN, twinMesh, 1);
    expectFeedsAboveModel(toolpath, ballEndMill, TWIN, twinMesh, 0.005);
    const levels = new Set(
      toolpath.moves.filter(({ kind, to }) => kind === "feed" && to[2] < -4).map(({ to }) => to[2]),
    );
    // From one pyramid to the other at least once on each level around them.
    expect(levels.size).toBe(4);
    expect(retracts(toolpath)).toBeGreaterThanOrEqual(levels.size);
  });

  it("goes from level to level down a pyramid without going into the model", () => {
    // Contours half a millimetre apart in height on faces rising 0.8 in 1.
    for (const tool of [ballEndMill, endMill]) {
      const tolerance = tool === ballEndMill ? 0.005 : SAMPLING;
      expectFeedsAboveModel(
        finish(tool, PYRAMID, pyramidMesh, 0.5),
        tool,
        PYRAMID,
        pyramidMesh,
        tolerance,
      );
    }
  }, 20_000);

  it("links the runs rest machining leaves without going into the model", () => {
    // Earlier cuts along the wall's contours at both ends only, as far as y = 3 and from y = 7.
    const x = 10 + endMill.diameter / 2;
    const segments: number[] = [];
    for (let z = -5; z >= -10; z--) segments.push(x, 0, z, x, 3, z, x, 7, z, x, 10, z);
    const toolpath = runSteps(
      reliefFinishSteps(waterline(endMill, STEP, 1, true), STEP, stepMesh, {
        ...options,
        rest: { cuts: [{ tool: endMill, segments: new Float32Array(segments) }], stock: null },
      }),
    );
    const middle = toolpath.moves.filter(
      ({ kind, to }) => kind === "feed" && to[1] > 3.5 && to[1] < 6.5 && to[2] < -4.5,
    );
    expect(middle.length).toBeGreaterThan(0);
    expectFeedsAboveModel(toolpath, endMill, STEP, stepMesh, 0.005);
  });
});
