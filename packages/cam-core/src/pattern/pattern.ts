import {
  LINE_PATTERN_CELLS,
  type Path,
  type PatternSettings,
  type Point,
  type TextPlacement,
} from "@furrow/document";
import type { Rect } from "../geometry/bounds";
import {
  clipLines,
  containmentIn,
  intersectionEach,
  offset,
  type Polygon,
  signedArea,
} from "../geometry/clipper";
import { DEFAULT_CHORD_TOLERANCE, flattenPath } from "../geometry/flatten";
import { cleanPath, polygonPath } from "../geometry/path";
import { cellLattice, cellLines, type Lattice, voronoiCells } from "./cells";

/**
 * The most cells a pattern may have, about `size²` each over the boundary's
 * bounds: well past the 10 000 a pattern must stay responsive with (P7), short
 * of what would exhaust a worker's memory.
 */
export const MAX_PATTERN_CELLS = 200_000;

/** Thrown when a pattern's cells are too small for its boundary to generate (see `MAX_PATTERN_CELLS`). */
export class PatternTooDenseError extends RangeError {
  constructor(readonly cells: number) {
    super(`A pattern of about ${Math.round(cells)} cells is too dense`);
    this.name = "PatternTooDenseError";
  }
}

/**
 * A pattern's paths in stock coordinates (PRD-0016 P3, P5, P6, ADR-0087):
 * `settings`' cells tiled from its placement over `boundary`, and cut at it.
 * The boundary's closed paths count even-odd, so counters and inner outlines
 * stay empty, and its open paths are ignored; the pattern stops `inset` inside
 * it. Closed cells, each shrunk by half the gap, become closed paths, those
 * crossing the boundary closed along it; line patterns become open paths
 * ending on it. Empty if nothing lies inside.
 */
export function patternPaths(
  boundary: readonly Path[],
  settings: PatternSettings,
  tolerance = DEFAULT_CHORD_TOLERANCE,
): Path[] {
  const rings = boundary.filter((path) => path.closed).map((path) => flattenPath(path, tolerance));
  if (rings.length === 0) return [];
  // Clean rings, outer boundaries counter-clockwise and holes clockwise, so the
  // even-odd area clips under the default rule from here on.
  const region = offset(rings, -settings.inset, { fillRule: "evenOdd", arcTolerance: tolerance });
  if (region.length === 0) return [];
  const { toStock, toLocal } = placementFrame(settings.placement);
  const local = pointsBounds(region.flat().map(toLocal));
  const estimate =
    ((local.max[0] - local.min[0] + 2 * settings.size) *
      (local.max[1] - local.min[1] + 2 * settings.size)) /
    settings.size ** 2;
  if (estimate > MAX_PATTERN_CELLS) throw new PatternTooDenseError(estimate);

  if (LINE_PATTERN_CELLS.includes(settings.cell)) {
    const lines = (cellLines(settings, local, tolerance) ?? []).map((line) => line.map(toStock));
    return clipLines(lines, region).flatMap((line) => cleanPath(polygonPath(line, false)) ?? []);
  }

  const lattice = cellLattice(settings, tolerance);
  const halfGap = settings.gap / 2;
  const cells = lattice
    ? tile(insetMotif(lattice, halfGap, tolerance), local)
    : voronoiCells(settings, local).flatMap((cell) => inset([cell], halfGap, tolerance));
  const minArea = tolerance ** 2;
  return cutCells(
    cells.map((cell) => cell.map(toStock)),
    region,
    settings.size,
  ).flatMap((ring) =>
    Math.abs(signedArea(ring)) > minArea ? (cleanPath(polygonPath(ring)) ?? []) : [],
  );
}

/** The maps from a pattern's own frame to stock coordinates and back (ADR-0087). */
function placementFrame({ position: [px, py], rotation, mirrored }: TextPlacement) {
  const angle = (rotation * Math.PI) / 180;
  const [c, s, m] = [Math.cos(angle), Math.sin(angle), mirrored ? -1 : 1];
  return {
    toStock: ([x, y]: Point): Point => [px + c * m * x - s * y, py + s * m * x + c * y],
    toLocal: ([x, y]: Point): Point => {
      const [dx, dy] = [x - px, y - py];
      return [m * (c * dx + s * dy), -s * dx + c * dy];
    },
  };
}

/** `lattice` with each cell of its motif shrunk by `distance` on its own. */
function insetMotif(lattice: Lattice, distance: number, tolerance: number): Lattice {
  return { ...lattice, motif: lattice.motif.flatMap((cell) => inset([cell], distance, tolerance)) };
}

function inset(cell: Polygon[], distance: number, tolerance: number): Polygon[] {
  return distance > 0 ? offset(cell, -distance, { join: "miter", arcTolerance: tolerance }) : cell;
}

/** The motif's cells at every lattice point where they overlap `bounds`. */
function tile({ a, b, motif }: Lattice, bounds: Rect): Polygon[] {
  if (motif.length === 0) return [];
  const extent = pointsBounds(motif.flat());
  // The translations that bring some of the motif inside the bounds.
  const lo: Point = [bounds.min[0] - extent.max[0], bounds.min[1] - extent.max[1]];
  const hi: Point = [bounds.max[0] - extent.min[0], bounds.max[1] - extent.min[1]];
  const det = a[0] * b[1] - a[1] * b[0];
  const box: Point[] = [lo, hi, [lo[0], hi[1]], [hi[0], lo[1]]];
  const corners = box.map(
    ([x, y]): Point => [(x * b[1] - y * b[0]) / det, (a[0] * y - a[1] * x) / det],
  );
  const is = corners.map(([i]) => i);
  const js = corners.map(([, j]) => j);
  const cells: Polygon[] = [];
  for (let i = Math.floor(Math.min(...is)); i <= Math.ceil(Math.max(...is)); i++) {
    for (let j = Math.floor(Math.min(...js)); j <= Math.ceil(Math.max(...js)); j++) {
      const t: Point = [i * a[0] + j * b[0], i * a[1] + j * b[1]];
      if (t[0] < lo[0] || t[0] > hi[0] || t[1] < lo[1] || t[1] > hi[1]) continue;
      for (const cell of motif) cells.push(cell.map(([x, y]): Point => [x + t[0], y + t[1]]));
    }
  }
  return cells;
}

/**
 * The rings of `cells` inside `region`, each cell cut on its own. Cells far
 * from the region's edges are kept or dropped whole, found through a grid of
 * `bucket` squares marking where the edges run, so only the cells the
 * boundary crosses go through the clipper.
 */
function cutCells(cells: Polygon[], region: Polygon[], bucket: number): Polygon[] {
  const bounds = pointsBounds(region.flat());
  const key = (x: number, y: number) =>
    Math.floor((x - bounds.min[0]) / bucket) * 0x100000 + Math.floor((y - bounds.min[1]) / bucket);
  const edges = new Set<number>();
  for (const ring of region) {
    ring.forEach((p, k) => {
      const q = ring[(k + 1) % ring.length] as Point;
      // Samples half a bucket apart, each marking its bucket's neighbours too,
      // mark every bucket the edge runs through.
      const steps = Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / (bucket / 2));
      for (let n = 0; n <= steps; n++) {
        const [x, y] = [p[0] + ((q[0] - p[0]) * n) / steps, p[1] + ((q[1] - p[1]) * n) / steps];
        for (const dx of [-bucket, 0, bucket]) {
          for (const dy of [-bucket, 0, bucket]) edges.add(key(x + dx, y + dy));
        }
      }
    });
  }
  const contains = region.map(containmentIn);
  const inside = (point: Point) =>
    contains.filter((ring) => ring(point) === "inside").length % 2 === 1;

  const kept: Polygon[] = [];
  const crossing: Polygon[][] = [];
  for (const cell of cells) {
    const box = pointsBounds(cell);
    if (
      box.max[0] < bounds.min[0] ||
      box.max[1] < bounds.min[1] ||
      box.min[0] > bounds.max[0] ||
      box.min[1] > bounds.max[1]
    ) {
      continue;
    }
    if (crossesEdges(box)) crossing.push([cell]);
    else if (inside(cell[0] as Point)) kept.push(cell);
  }
  return [...kept, ...intersectionEach(crossing, region).flat()];

  function crossesEdges({ min, max }: Rect): boolean {
    for (let x = min[0]; x < max[0] + bucket; x += bucket) {
      for (let y = min[1]; y < max[1] + bucket; y += bucket) {
        if (edges.has(key(Math.min(x, max[0]), Math.min(y, max[1])))) return true;
      }
    }
    return false;
  }
}

function pointsBounds(points: readonly Point[]): Rect {
  const min: Point = [Infinity, Infinity];
  const max: Point = [-Infinity, -Infinity];
  for (const [x, y] of points) {
    min[0] = Math.min(min[0], x);
    min[1] = Math.min(min[1], y);
    max[0] = Math.max(max[0], x);
    max[1] = Math.max(max[1], y);
  }
  return { min, max };
}
