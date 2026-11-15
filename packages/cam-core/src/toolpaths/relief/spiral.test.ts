import type { Model, ReliefFinishOperation, Tool } from "@furrow/document";
import { ballEndMill, endMill } from "@furrow/document/fixtures";
import { describe, expect, it } from "vitest";
import {
  expectFeedsAboveModel,
  PYRAMID,
  pyramidMesh,
  segmentsOf,
  TWIN,
  twinMesh,
} from "../link-test-utils";
import type { Toolpath } from "../toolpath";
import { runSteps } from "./finish";
import { reliefFinishSteps } from "./finishing";

// The feeds spiral finishing makes without retracting (#574): from each run
// straight on into the next, and across the gaps rest machining leaves.

function spiral(
  tool: Tool,
  model: Model,
  start: "outside" | "centre",
  rest = false,
): ReliefFinishOperation {
  return {
    id: "4e3d2c1b-0a9f-4e8d-9c7b-6a5f4e3d2c1b",
    type: "relief_finish",
    name: "Spiral",
    enabled: true,
    stockSide: "top",
    targets: [],
    tool,
    params: {
      modelId: model.id,
      strategy: { type: "spiral", start },
      stepOver: 20,
      stockToLeave: 0,
      boundary: { type: "model" },
      rest,
    },
  };
}

const options = { safeZ: 5, entryClearance: 1 };

const rapids = ({ moves }: Toolpath) => moves.filter(({ kind }) => kind === "rapid").length;

describe("spiral links", () => {
  for (const [label, tool, tolerance] of [
    ["a ball end mill", ballEndMill, 0.005],
    // Dropped onto cell centres (ADR-0030): a flat rim reaches a cell's worth of the slope between them.
    ["a flat end mill", endMill, 0.8 * 0.1 + 0.005],
  ] as const) {
    for (const start of ["outside", "centre"] as const) {
      it(`goes on from run to run without going into the model, from the ${start}, with ${label}`, () => {
        for (const [model, mesh] of [
          [PYRAMID, pyramidMesh],
          [TWIN, twinMesh],
        ] as const) {
          const toolpath = runSteps(
            reliefFinishSteps(spiral(tool, model, start), model, mesh, options),
          );
          // Down once and up once: every run joined to the one before.
          expect(rapids(toolpath)).toBe(3);
          expectFeedsAboveModel(toolpath, tool, model, mesh, tolerance);
        }
      });
    }
  }

  it("joins and retracts across the runs rest machining leaves without going into the model", () => {
    const first = runSteps(
      reliefFinishSteps(spiral(ballEndMill, TWIN, "outside"), TWIN, twinMesh, options),
    );
    // Earlier cuts over the left pyramid only.
    const all = segmentsOf(first);
    const left: number[] = [];
    for (let i = 0; i + 5 < all.length; i += 6) {
      if ((all[i] as number) < 15 && (all[i + 3] as number) < 15)
        left.push(...all.subarray(i, i + 6));
    }
    const toolpath = runSteps(
      reliefFinishSteps(spiral(ballEndMill, TWIN, "outside", true), TWIN, twinMesh, {
        ...options,
        rest: { cuts: [{ tool: ballEndMill, segments: new Float32Array(left) }], stock: null },
      }),
    );
    // Each lap crosses the cut half and back: more than one way in.
    expect(rapids(toolpath)).toBeGreaterThan(3);
    expect(toolpath.moves.length).toBeLessThan(first.moves.length);
    expectFeedsAboveModel(toolpath, ballEndMill, TWIN, twinMesh, 0.005);
  });
});
