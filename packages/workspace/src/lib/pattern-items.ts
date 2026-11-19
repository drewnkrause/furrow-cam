import { pathBounds } from "@furrow/cam-core";
import type { Message, OperationTarget, PatternSettings, Point, Shape } from "@furrow/document";
import type { DocumentStore } from "../stores/document-store";
import type { ActionResult } from "../stores/operation-actions";
import {
  addPatternItem,
  convertPatternToDrawing,
  patternBoundary,
  setPatternItem,
} from "../stores/pattern-actions";
import {
  boundaryPaths,
  DEFAULT_PATTERN,
  type Generated,
  PATTERN_FAILED,
  type PatternWorkerRequest,
  type PatternWorkerResponse,
} from "./patterns";

/**
 * Fills the closed paths `targets` select with a pattern of the default
 * settings, anchored at their bounds' bottom-left corner (PRD-0016 P1), its
 * cells generated off the main thread, and adds it as one undo step named
 * `name`. Returns its id.
 */
export async function addPattern(
  store: DocumentStore,
  targets: readonly OperationTarget[],
  name: string,
): Promise<{ ok: true; id: string } | { ok: false; error: Message }> {
  for (;;) {
    const { document } = store.getState();
    const bound = patternBoundary(document, targets);
    if (!bound.ok) return bound;
    const paths = boundaryPaths(document.geometry, bound.boundary);
    const corner: Point = [
      Math.min(...paths.map((path) => pathBounds(path).min[0])),
      Math.min(...paths.map((path) => pathBounds(path).min[1])),
    ];
    const settings: PatternSettings = {
      ...DEFAULT_PATTERN,
      placement: { position: corner, rotation: 0, mirrored: false },
      boundary: bound.boundary,
    };
    const generated = await generatePatternOffThread(document.geometry, settings);
    if (!generated.ok) return generated;
    // Moved or changed meanwhile: fill it where it is now.
    if (store.getState().document.geometry !== document.geometry) continue;
    return { ok: true, id: addPatternItem(store, name, settings, generated.paths) };
  }
}

export type PatternEdits = Partial<Omit<PatternSettings, "boundary">>;
type EditResult = { ok: true; removedTabs: number } | { ok: false; error: Message };

/** A pattern's edits waiting to be generated, merged so the latest of each wins, and who waits on them. */
type Queue = { edits: PatternEdits | null; waiting: ((result: EditResult) => void)[] };
const queues = new Map<string, Queue>();

/**
 * Changes pattern `id`'s settings by `edits` and generates its cells again off
 * the main thread, as one undo step keeping the operations machining it
 * (PRD-0016 P5, `setPatternItem`). Edits made while one is generated are
 * merged and generated next, so a scrub generates once per wait. Moved or
 * its boundary changed meanwhile, it is generated again where it is.
 */
export function editPattern(store: DocumentStore, id: string, edits: PatternEdits) {
  return new Promise<EditResult>((resolve) => {
    const queue = queues.get(id);
    if (queue) {
      queue.edits = { ...queue.edits, ...edits };
      queue.waiting.push(resolve);
      return;
    }
    const started: Queue = { edits, waiting: [resolve] };
    queues.set(id, started);
    void run(store, id, started);
  });
}

/** Resolves once pattern `id` has no edits waiting or being generated, with how the last went. */
export function patternSettled(id: string): Promise<EditResult | null> {
  const queue = queues.get(id);
  return queue ? new Promise((resolve) => queue.waiting.push(resolve)) : Promise.resolve(null);
}

/**
 * Turns pattern `id` into a plain drawing (PRD-0016 P9) once its pending edits
 * have landed. An undo step left open by a scrub is closed first, so the
 * conversion is one of its own.
 */
export async function convertPattern(store: DocumentStore, id: string): Promise<ActionResult> {
  const pending = await patternSettled(id);
  if (pending && !pending.ok) return pending;
  const state = store.getState();
  if (state.inTransaction) state.commitTransaction();
  convertPatternToDrawing(store, id);
  return { ok: true };
}

async function run(store: DocumentStore, id: string, queue: Queue) {
  let result: EditResult = { ok: true, removedTabs: 0 };
  while (queue.edits) {
    const edits = queue.edits;
    queue.edits = null;
    const { document } = store.getState();
    const pattern = document.drawings.find((drawing) => drawing.id === id)?.pattern;
    if (!pattern) break;
    const settings = { ...pattern, ...edits };
    const generated = await generatePatternOffThread(document.geometry, settings);
    // Read again: `editPattern` may have queued newer edits meanwhile.
    const newer = queue.edits as PatternEdits | null;
    if (newer) {
      queue.edits = { ...edits, ...newer };
      continue;
    }
    if (!generated.ok) {
      result = generated;
      break;
    }
    if (store.getState().document.geometry !== document.geometry) {
      queue.edits = edits;
      continue;
    }
    result = { ok: true, removedTabs: setPatternItem(store, id, settings, generated.paths) };
  }
  queues.delete(id);
  for (const resolve of queue.waiting) resolve(result);
}

// Here, not in `patterns.ts`: the worker imports that, and a worker bundling its own spawn never builds.
let worker: Worker | null = null;
const waiting = new Map<number, (response: Generated) => void>();
let nextId = 0;

/**
 * `generatePattern` in a Web Worker (ADR-0004) that stays for the next edit,
 * so a slow pattern never freezes the workspace (PRD-0016 P7).
 */
export function generatePatternOffThread(
  geometry: readonly Shape[],
  settings: PatternSettings,
): Promise<Generated> {
  const running = worker ?? start();
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    const request: PatternWorkerRequest = {
      id,
      boundary: boundaryPaths(geometry, settings.boundary),
      settings,
    };
    running.postMessage(request);
  });
}

function start(): Worker {
  const started = new Worker(new URL("../workers/pattern.worker.ts", import.meta.url), {
    type: "module",
  });
  started.onmessage = ({ data }: MessageEvent<PatternWorkerResponse>) => {
    const answer = waiting.get(data.id);
    waiting.delete(data.id);
    const { id: _, ...generated } = data;
    answer?.(generated as Generated);
  };
  // A worker that fails to load fails every request; the next one starts another.
  started.onerror = (event) => {
    event.preventDefault();
    started.terminate();
    worker = null;
    for (const answer of waiting.values()) answer({ ok: false, error: PATTERN_FAILED });
    waiting.clear();
  };
  worker = started;
  return started;
}
