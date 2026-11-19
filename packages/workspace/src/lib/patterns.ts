import { PatternTooDenseError, patternPaths } from "@furrow/cam-core";
import type { Message, Path, PatternSettings, Shape, ShapePaths } from "@furrow/document";

/** A new pattern's settings but its placement and boundary, the same in the workspace and the MCP server (PRD-0016 P10). */
export const DEFAULT_PATTERN: Omit<PatternSettings, "placement" | "boundary"> = {
  cell: "hexagon",
  size: 10,
  gap: 1,
  inset: 0,
  amplitude: 3,
  wavelength: 15,
  seed: 1,
};

/** Why a pattern can't be generated: no cell lies inside its boundary. */
export const PATTERN_EMPTY: Message = { code: "workspace.patternEmpty" };

/** Why a pattern can't be generated: its cells are too small for its boundary. */
export const PATTERN_TOO_DENSE: Message = { code: "workspace.patternTooDense" };

/** Why a pattern couldn't be generated, when nothing more precise is known. */
export const PATTERN_FAILED: Message = { code: "workspace.patternFailed" };

/** The paths `boundary` selects in `geometry`; shapes it no longer finds give none. */
export function boundaryPaths(geometry: readonly Shape[], boundary: readonly ShapePaths[]): Path[] {
  const byId = new Map(boundary.map((selection) => [selection.shapeId, selection.paths]));
  return geometry.flatMap((shape) => {
    if (!byId.has(shape.id)) return [];
    const indices = byId.get(shape.id);
    return indices ? indices.flatMap((i) => shape.paths[i] ?? []) : shape.paths;
  });
}

export type Generated = { ok: true; paths: Path[] } | { ok: false; error: Message };

/**
 * `settings`' cells inside their boundary in `geometry` (`patternPaths`), or
 * why there are none to store: a pattern's shape has at least one path.
 */
export function generatePattern(geometry: readonly Shape[], settings: PatternSettings): Generated {
  return generateInside(boundaryPaths(geometry, settings.boundary), settings);
}

/** `generatePattern` inside the boundary's paths, `boundary`. */
export function generateInside(boundary: readonly Path[], settings: PatternSettings): Generated {
  try {
    const paths = patternPaths(boundary, settings);
    return paths.length > 0 ? { ok: true, paths } : { ok: false, error: PATTERN_EMPTY };
  } catch (error) {
    if (error instanceof PatternTooDenseError) return { ok: false, error: PATTERN_TOO_DENSE };
    console.error(error);
    return { ok: false, error: PATTERN_FAILED };
  }
}

/** What the pattern worker is asked: `settings`' cells inside `boundary`, `id` pairing the answer. */
export type PatternWorkerRequest = { id: number; boundary: Path[]; settings: PatternSettings };
export type PatternWorkerResponse = { id: number } & Generated;
