import { flattenPath, signedArea } from "@furrow/cam-core";
import {
  type PatternSettings,
  type Point,
  ProjectDocument,
  type ProjectDocument as ProjectDocumentType,
} from "@furrow/document";
import {
  CIRCLE_ID,
  DRAWING_ID,
  fullDocument,
  SQUARE_ID,
  textItem,
  textShape,
} from "@furrow/document/fixtures";
import { describe, expect, it } from "vitest";
import { DEFAULT_PATTERN, generatePattern } from "../lib/patterns";
import { createDocumentStore } from "./document-store";
import {
  drawingShapes,
  duplicateDrawing,
  mirrorDrawing,
  moveDrawing,
  rotateDrawing,
  setDrawingSize,
} from "./geometry-actions";
import {
  addPatternItem,
  convertPatternToDrawing,
  PATTERN_NO_CLOSED_PATH,
  PATTERN_NO_SELECTION,
  PATTERN_OF_PATTERN,
  PATTERN_ONE_DRAWING,
  patternBoundary,
  setPatternItem,
} from "./pattern-actions";

/** 10 mm squares with no gap from the stock's corner, filling `square` less `circle`. */
const SETTINGS: PatternSettings = {
  ...DEFAULT_PATTERN,
  cell: "square",
  size: 10,
  gap: 0,
  placement: { position: [0, 0], rotation: 0, mirrored: false },
  boundary: [{ shapeId: SQUARE_ID, paths: null }],
};

/** `fullDocument` and the text item, with a pattern filling its square drawing. */
function withPattern(settings = SETTINGS) {
  const base = fullDocument();
  const doc = {
    ...base,
    drawings: [...base.drawings, textItem],
    geometry: [...base.geometry, textShape],
  };
  const generated = generatePattern(doc.geometry, settings);
  if (!generated.ok) throw new Error("fixture");
  const store = createDocumentStore(doc);
  const id = addPatternItem(store, "Pattern", settings, generated.paths);
  const document = () => store.getState().document;
  const pattern = () => document().drawings.find((drawing) => drawing.id === id)?.pattern;
  const cells = () => drawingShapes(document().geometry, id)[0]?.paths ?? [];
  return { store, id, document, pattern, cells };
}

const valid = (doc: ProjectDocumentType) => expect(ProjectDocument.parse(doc)).toEqual(doc);
const points = (paths: ReturnType<ReturnType<typeof withPattern>["cells"]>) =>
  paths.flatMap((path) => flattenPath(path));
const areas = (paths: ReturnType<ReturnType<typeof withPattern>["cells"]>) =>
  paths.map((path) => Math.abs(signedArea(flattenPath(path))));

describe("patternBoundary", () => {
  it("keeps the closed paths of one drawing that isn't a pattern, or says why not", () => {
    const { document, id } = withPattern();
    const doc = document();
    const patternShape = drawingShapes(doc.geometry, id)[0]?.id as string;
    expect(patternBoundary(doc, [])).toEqual({ ok: false, error: PATTERN_NO_SELECTION });
    expect(
      patternBoundary(doc, [
        { shapeId: SQUARE_ID, paths: null },
        { shapeId: textShape.id, paths: null },
      ]),
    ).toEqual({ ok: false, error: PATTERN_ONE_DRAWING });
    expect(patternBoundary(doc, [{ shapeId: patternShape, paths: null }])).toEqual({
      ok: false,
      error: PATTERN_OF_PATTERN,
    });
    const open = {
      ...doc,
      geometry: doc.geometry.map((shape) =>
        shape.id === SQUARE_ID
          ? { ...shape, paths: shape.paths.map((path) => ({ ...path, closed: false })) }
          : shape,
      ),
    };
    expect(patternBoundary(open, [{ shapeId: SQUARE_ID, paths: null }])).toEqual({
      ok: false,
      error: PATTERN_NO_CLOSED_PATH,
    });
    expect(
      patternBoundary(doc, [
        { shapeId: SQUARE_ID, paths: null },
        { shapeId: CIRCLE_ID, paths: [0] },
      ]),
    ).toEqual({
      ok: true,
      boundary: [
        { shapeId: SQUARE_ID, paths: null },
        { shapeId: CIRCLE_ID, paths: [0] },
      ],
    });
  });
});

describe("pattern items", () => {
  it("are added, edited and converted in one undo step each, the document staying valid", () => {
    const { store, id, document, pattern, cells } = withPattern();
    valid(document());
    expect(areas(cells()).every((area) => area <= 100 + 1e-6)).toBe(true);
    const shapeId = drawingShapes(document().geometry, id)[0]?.id as string;
    const [operation] = document().operations;
    store.getState().change("target", (draft) => {
      draft.operations[0]?.targets.push({ shapeId, paths: [0] });
    });

    const bigger = { ...SETTINGS, size: 20 };
    const generated = generatePattern(document().geometry, bigger);
    if (!generated.ok) throw new Error("generated");
    setPatternItem(store, id, bigger, generated.paths);
    expect(pattern()?.size).toBe(20);
    // The old cells' numbers mean nothing in the new ones: the target takes them all.
    expect(document().operations[0]?.targets.at(-1)).toEqual({ shapeId, paths: null });
    valid(document());
    store.getState().undo();
    expect(pattern()?.size).toBe(10);

    convertPatternToDrawing(store, id);
    expect(pattern()).toBeUndefined();
    expect(cells().length).toBeGreaterThan(0);
    valid(document());
    store.getState().undo();
    expect(pattern()).toEqual(SETTINGS);
    expect(operation).toBeDefined();
  });

  it("move, turn and mirror with their boundary, cells and all, in the same undo step", () => {
    const { store, document, pattern, cells } = withPattern();
    const before = cells();
    moveDrawing(store, DRAWING_ID, [5, 7]);
    expect(pattern()?.placement.position).toEqual([5, 7]);
    const key = ([x, y]: Point) => `${x.toFixed(6)},${y.toFixed(6)}`;
    const moved = new Set(points(before).map(([x, y]) => key([x + 5, y + 7])));
    expect(points(cells()).filter((point) => !moved.has(key(point)))).toEqual([]);
    valid(document());
    store.getState().undo();
    expect(cells()).toEqual(before);
    expect(pattern()).toEqual(SETTINGS);

    rotateDrawing(store, DRAWING_ID, 90);
    expect(pattern()?.placement.rotation).toBe(90);
    expect(cells()).toHaveLength(before.length);
    valid(document());
    mirrorDrawing(store, DRAWING_ID, "x");
    expect(pattern()?.placement.mirrored).toBe(true);
    valid(document());
  });

  it("are generated again, cells keeping their size, when their boundary is resized", () => {
    const { store, document, pattern, cells } = withPattern();
    const count = cells().length;
    expect(setDrawingSize(store, DRAWING_ID, "width", 200)).toEqual({ ok: true });
    expect(pattern()?.size).toBe(10);
    expect(cells().length).toBeGreaterThan(3 * count);
    expect(areas(cells()).filter((area) => Math.abs(area - 100) < 1e-6).length).toBeGreaterThan(
      3 * count * 0.5,
    );
    valid(document());
    store.getState().undo();
    expect(cells()).toHaveLength(count);
  });

  it("refuse a resize that leaves no cell inside, changing nothing", () => {
    const { store, document } = withPattern({ ...SETTINGS, inset: 4 });
    const before = document();
    expect(setDrawingSize(store, DRAWING_ID, "width", 5)).toEqual({
      ok: false,
      error: { code: "workspace.patternEmpty" },
    });
    expect(document()).toBe(before);
  });

  it("are generated again inside their boundary when moved or resized on their own", () => {
    const { store, id, document, pattern, cells } = withPattern();
    moveDrawing(store, id, [3, 0]);
    expect(pattern()?.placement.position).toEqual([3, 0]);
    // Still cut at the square's sides.
    const xs = points(cells()).map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(0, 6);
    expect(Math.max(...xs)).toBeCloseTo(100, 6);
    valid(document());

    const width = (paths: ReturnType<typeof cells>) => {
      const all = points(paths).map(([x]) => x);
      return Math.max(...all) - Math.min(...all);
    };
    setDrawingSize(store, id, "width", width(cells()) / 2);
    expect(pattern()?.size).toBeCloseTo(5, 6);
    valid(document());
  });

  it("are copied as plain drawings, and plain drawings when their boundary goes", () => {
    const { store, id, document } = withPattern();
    const copy = duplicateDrawing(store, id);
    expect(document().drawings.find((drawing) => drawing.id === copy)?.pattern).toBeUndefined();
    valid(document());
  });
});
