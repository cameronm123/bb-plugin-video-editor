// The Claude Code mod's own logic. Kept pure on purpose: no `$` (the mods
// API) may be passed into this file — `claude plugin validate` only allows
// `$` inside register.ts's own file. Every $.x call lives in register.ts;
// this file takes plain arguments and returns plain data.

import { applyOperation, validateOperation } from "../core/operations.ts";
import type { Timeline } from "../core/types.ts";

// --- the narrow slice of the mods API this mod uses ------------------------
// Hand-rolled to keep the mod free of bare imports: the hooks-module rule
// allows importing only plugin files by relative path (plus `claude-code`),
// so we type the few methods we call instead of the full engine surface.

export interface CommandSpec {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface ProcessRunInit {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs?: number;
}

export interface ProcessRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VideoModsApi {
  command: { register(spec: CommandSpec): Promise<unknown> };
  tool: { register(spec: ToolSpec): Promise<{ tool: string }> };
  store: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  fs: { write(path: string, text: string): Promise<void> };
  env: { get(name: string): Promise<string | undefined> };
  process: {
    run(argv: readonly string[], init?: ProcessRunInit): Promise<ProcessRunResult>;
  };
}

export type NextFn = (event?: unknown) => Promise<unknown>;

export type Hook = (
  $: VideoModsApi,
  event: any,
  next: NextFn,
) => Promise<unknown>;

export interface HookFailure {
  kind: string;
  message: string;
}

export interface Registration {
  catch(handler: (
    $: VideoModsApi,
    event: any,
    next: NextFn & { readonly error: HookFailure; readonly called: boolean },
  ) => unknown): void;
}

export type OnEvent = {
  (event: string, hook: Hook): Registration;
  (
    event: string,
    matcher: Record<string, unknown>,
    hook: Hook,
  ): Registration;
};

// The input of `tool.call` for a registered tool: the tool's arguments are
// fields of `e` itself (`e.operations`), beside the reserved `tool` and
// `tool_use_id`.
export interface ToolCallEvent {
  tool: string;
  tool_use_id?: string;
  [argument: string]: unknown;
}

// --- the mod's logic ---------------------------------------------------------

/** A fresh default timeline plan, before any operation is applied. */
export function emptyTimeline(): Timeline {
  return {
    id: "timeline-1",
    name: "untitled",
    width: 1920,
    height: 1080,
    fps: 30,
    tracks: [],
    markers: [],
    captions: [],
  };
}

function isTimeline(value: unknown): value is Timeline {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    typeof v.width === "number" &&
    typeof v.height === "number" &&
    typeof v.fps === "number" &&
    Array.isArray(v.tracks) &&
    Array.isArray(v.markers) &&
    Array.isArray(v.captions)
  );
}

/** The stored timeline, or the default plan when nothing valid is stored. */
export function timelineFromStored(stored: unknown): Timeline {
  return isTimeline(stored) ? stored : emptyTimeline();
}

/**
 * Validate freeform (agent) operations at the boundary, then reduce them one
 * by one. Throws on the first invalid operation; the caller only persists the
 * result after every operation applied, so a failed batch leaves the stored
 * timeline untouched.
 */
export function reduceOperations(
  timeline: Timeline,
  rawOperations: unknown,
): Timeline {
  if (!Array.isArray(rawOperations)) {
    throw new Error(
      `operations must be an array, got ${typeof rawOperations}`,
    );
  }
  let next: Timeline = timeline;
  for (const raw of rawOperations) {
    next = applyOperation(next, validateOperation(raw));
  }
  return next;
}
