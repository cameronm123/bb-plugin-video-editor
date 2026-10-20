// The patch-op model: the agent never writes the timeline wholesale, it
// applies named operations through one pure reducer. Freeform input is
// validated here, at this boundary — the reducer trusts what it gets.
//
// Validation is hand-rolled (no zod): the Claude Code mod can only import its
// own files by relative path, and this module is on the mod's import path.
import type {
  Caption,
  Clip,
  ClipId,
  Effect,
  EffectType,
  Marker,
  MediaRef,
  Millis,
  Timeline,
  Track,
} from "./types.ts";
export type { Millis, Timeline } from "./types.ts";

export type Operation =
  | {
      type: "add_clip";
      trackId: string;
      media: MediaRef;
      startMs: Millis;
      durationMs: Millis;
      inMs: Millis;
      outMs: Millis;
      label?: string;
      id?: string;
    }
  | {
      type: "trim_clip";
      clipId: string;
      startMs?: Millis;
      durationMs?: Millis;
      inMs?: Millis;
      outMs?: Millis;
    }
  | { type: "move_clip"; clipId: string; startMs: Millis; trackId?: string }
  | { type: "remove_clip"; clipId: string }
  | { type: "set_effect"; clipId: string; effect: Effect }
  | { type: "split_clip"; clipId: string; atMs: Millis }
  | {
      type: "add_marker";
      atMs: Millis;
      name: string;
      color?: string;
      id?: string;
    }
  | { type: "remove_marker"; markerId: string }
  | {
      type: "add_caption";
      atMs: Millis;
      endMs: Millis;
      text: string;
      id?: string;
    }
  | { type: "remove_caption"; captionId: string }
  | {
      type: "set_property";
      name?: string;
      width?: number;
      height?: number;
      fps?: number;
    }
  | { type: "add_track"; kind: "video" | "audio"; id?: string }
  | { type: "remove_track"; trackId: string }
  | { type: "mute_track"; trackId: string; muted: boolean }
  | {
      type: "set_transition";
      clipId: string;
      /** ffmpeg xfade transition name, e.g. "fade", "wipeleft". */
      name: string;
      durationMs: Millis;
    };

// --- boundary guards: plain predicates over `unknown`, no casts ------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function req(value: unknown, field: string): unknown {
  if (value === undefined) {
    throw new Error(`invalid operation: missing field "${field}"`);
  }
  return value;
}

function str(value: unknown, field: string): string {
  const v = req(value, field);
  if (typeof v !== "string" || v === "") {
    throw new Error(`invalid operation: "${field}" must be a non-empty string`);
  }
  return v;
}

function optStr(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : str(value, field);
}

function millis(value: unknown, field: string): Millis {
  const v = req(value, field);
  if (
    typeof v !== "number" ||
    !Number.isInteger(v) ||
    v < 0
  ) {
    throw new Error(
      `invalid operation: "${field}" must be an integer >= 0 (milliseconds)`,
    );
  }
  return v;
}

function positiveInt(value: unknown, field: string): number {
  const v = req(value, field);
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Error(`invalid operation: "${field}" must be an integer > 0`);
  }
  return v;
}

function positiveNumber(value: unknown, field: string): number {
  const v = req(value, field);
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
    throw new Error(`invalid operation: "${field}" must be a number > 0`);
  }
  return v;
}

function optNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`invalid operation: "${field}" must be a number`);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  const v = req(value, field);
  if (typeof v !== "boolean") {
    throw new Error(`invalid operation: "${field}" must be a boolean`);
  }
  return v;
}

const EFFECT_TYPES: readonly string[] = [
  "opacity",
  "scale",
  "position",
  "crop",
  "volume",
  "fadeIn",
  "fadeOut",
  "speed",
];

function isEffectType(value: string): value is EffectType {
  return EFFECT_TYPES.includes(value);
}

function effect(value: unknown): Effect {
  if (!isRecord(value)) {
    throw new Error(`invalid operation: "effect" must be an object`);
  }
  const type = str(value.type, "effect.type");
  if (!isEffectType(type)) {
    throw new Error(
      `invalid operation: "effect.type" must be one of ${EFFECT_TYPES.join(", ")}`,
    );
  }
  const parsed: Effect = { type };
  parsed.amount = optNumber(value.amount, "effect.amount");
  parsed.x = optNumber(value.x, "effect.x");
  parsed.y = optNumber(value.y, "effect.y");
  parsed.from = optNumber(value.from, "effect.from");
  parsed.to = optNumber(value.to, "effect.to");
  // The ranges the skill documents. A value outside them is a mistake, not
  // something to clamp silently at render time.
  if (parsed.amount !== undefined) {
    const range = type === "scale" ? [0, 2] : [0, 1];
    if (parsed.amount < range[0] || parsed.amount > range[1]) {
      throw new Error(
        `invalid operation: "effect.amount" for ${type} must be between ${range[0]} and ${range[1]}`,
      );
    }
  }
  if (parsed.x !== undefined && (parsed.x < -1 || parsed.x > 1)) {
    throw new Error(
      `invalid operation: "effect.x" must be between -1 and 1`,
    );
  }
  if (parsed.y !== undefined && (parsed.y < -1 || parsed.y > 1)) {
    throw new Error(
      `invalid operation: "effect.y" must be between -1 and 1`,
    );
  }
  if (parsed.from !== undefined && type !== "speed" && (parsed.from < 0 || parsed.from > 1)) {
    throw new Error(
      `invalid operation: "effect.from" must be between 0 and 1`,
    );
  }
  if (parsed.to !== undefined && type !== "speed" && (parsed.to < 0 || parsed.to > 1)) {
    throw new Error(
      `invalid operation: "effect.to" must be between 0 and 1`,
    );
  }
  // A speed rate of 0 or a negative one would produce no output at all.
  const rate = parsed.to ?? parsed.from;
  if (type === "speed" && rate !== undefined && (rate <= 0 || rate > 16)) {
    throw new Error(
      `invalid operation: a speed rate must be greater than 0 and at most 16, got ${rate}`,
    );
  }
  return parsed;
}

function media(value: unknown): MediaRef {
  if (!isRecord(value)) {
    throw new Error(`invalid operation: "media" must be an object`);
  }
  const media: MediaRef = { path: str(value.path, "media.path") };
  if (value.durationMs !== undefined) {
    media.durationMs = millis(value.durationMs, "media.durationMs");
  }
  if (value.width !== undefined) {
    media.width = optNumber(value.width, "media.width");
  }
  if (value.height !== undefined) {
    media.height = optNumber(value.height, "media.height");
  }
  if (value.fps !== undefined) {
    media.fps = positiveNumber(value.fps, "media.fps");
  }
  return media;
}

function operationFields(raw: Record<string, unknown>): Operation {
  const type = str(raw.type, "type");
  const f = raw;
  switch (type) {
    case "add_clip":
      return {
        type,
        trackId: str(f.trackId, "trackId"),
        media: media(f.media),
        startMs: millis(f.startMs, "startMs"),
        durationMs: positiveInt(f.durationMs, "durationMs"),
        inMs: millis(f.inMs, "inMs"),
        outMs: positiveInt(f.outMs, "outMs"),
        label: optStr(f.label, "label"),
        id: optStr(f.id, "id"),
      };
    case "trim_clip":
      return {
        type,
        clipId: str(f.clipId, "clipId"),
        startMs:
          f.startMs === undefined ? undefined : millis(f.startMs, "startMs"),
        durationMs:
          f.durationMs === undefined
            ? undefined
            : positiveInt(f.durationMs, "durationMs"),
        inMs: f.inMs === undefined ? undefined : millis(f.inMs, "inMs"),
        outMs:
          f.outMs === undefined ? undefined : positiveInt(f.outMs, "outMs"),
      };
    case "move_clip":
      return {
        type,
        clipId: str(f.clipId, "clipId"),
        startMs: millis(f.startMs, "startMs"),
        trackId: optStr(f.trackId, "trackId"),
      };
    case "remove_clip":
      return { type, clipId: str(f.clipId, "clipId") };
    case "set_effect":
      return {
        type,
        clipId: str(f.clipId, "clipId"),
        effect: effect(f.effect),
      };
    case "split_clip":
      return {
        type,
        clipId: str(f.clipId, "clipId"),
        atMs: millis(f.atMs, "atMs"),
      };
    case "add_marker":
      return {
        type,
        atMs: millis(f.atMs, "atMs"),
        name: str(f.name, "name"),
        color: optStr(f.color, "color"),
        id: optStr(f.id, "id"),
      };
    case "remove_marker":
      return { type, markerId: str(f.markerId, "markerId") };
    case "add_caption":
      return {
        type,
        atMs: millis(f.atMs, "atMs"),
        endMs: positiveInt(f.endMs, "endMs"),
        text: str(f.text, "text"),
        id: optStr(f.id, "id"),
      };
    case "remove_caption":
      return { type, captionId: str(f.captionId, "captionId") };
    case "set_property":
      return {
        type,
        name: optStr(f.name, "name"),
        width:
          f.width === undefined ? undefined : positiveInt(f.width, "width"),
        height:
          f.height === undefined
            ? undefined
            : positiveInt(f.height, "height"),
        fps: f.fps === undefined ? undefined : positiveNumber(f.fps, "fps"),
      };
    case "add_track": {
      const kind = str(f.kind, "kind");
      if (kind !== "video" && kind !== "audio") {
        throw new Error(
          `invalid operation: "kind" must be "video" or "audio"`,
        );
      }
      return {
        type,
        kind,
        id: optStr(f.id, "id"),
      };
    }
    case "remove_track":
      return { type, trackId: str(f.trackId, "trackId") };
    case "mute_track":
      return {
        type,
        trackId: str(f.trackId, "trackId"),
        muted: bool(f.muted, "muted"),
      };
    case "set_transition":
      return {
        type,
        clipId: str(f.clipId, "clipId"),
        name: str(f.name, "name"),
        durationMs: positiveInt(f.durationMs, "durationMs"),
      };
    default:
      throw new Error(
        `invalid operation: unknown type "${String(type)}" — expected one of add_clip, trim_clip, move_clip, remove_clip, set_effect, split_clip, add_marker, remove_marker, add_caption, remove_caption, set_property, add_track, remove_track, mute_track, set_transition`,
      );
  }
}

/** Boundary: validate freeform (agent) input into a typed operation. Throws. */
export function validateOperation(input: unknown): Operation {
  if (!isRecord(input)) {
    throw new Error("invalid operation: expected an object");
  }
  return operationFields(input);
}

// --- the reducer -----------------------------------------------------------
//
// The reducer is pure so undo is trivial (replay the log) and tests never
// need ffmpeg. Deterministic id generation keeps it pure: ids derive from the
// state itself, never from a clock or RNG.

function nextId(existing: Iterable<string>, prefix: string): string {
  let max = 0;
  for (const id of existing) {
    if (id.startsWith(`${prefix}-`)) {
      const suffix = Number(id.slice(prefix.length + 1));
      if (Number.isInteger(suffix)) {
        max = Math.max(max, suffix);
      }
    }
  }
  return `${prefix}-${max + 1}`;
}

/**
 * A clip id unique across the whole timeline. Numbering per track would
 * make "clip-1" ambiguous the moment a plan has two tracks, and an agent
 * addressing a clip by id would always get the first one.
 */
function nextClipId(timeline: Timeline): ClipId {
  const used = timeline.tracks.flatMap((t) => t.clips.map((c) => c.id));
  return nextId(used, "clip");
}
function findTrack(timeline: Timeline, trackId: string): Track {
  const track = timeline.tracks.find((t) => t.id === trackId);
  if (track === undefined) throw new Error(`no track with id "${trackId}"`);
  return track;
}

function findClipTrack(timeline: Timeline, clipId: ClipId): {
  track: Track;
  clip: Clip;
} {
  for (const track of timeline.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip !== undefined) return { track, clip };
  }
  throw new Error(`no clip with id "${clipId}"`);
}

function sortedByStart(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.startMs - b.startMs);
}

function assertNoOverlap(clips: Clip[], label: string): void {
  const ordered = sortedByStart(clips);
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const clip = ordered[i];
    if (clip.startMs < prev.startMs + prev.durationMs) {
      throw new Error(
        `${label}: clip "${clip.id}" overlaps clip "${prev.id}" on track`,
      );
    }
  }
}

function updateTrack(
  timeline: Timeline,
  trackId: string,
  update: (clips: Clip[]) => Clip[],
): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.id === trackId ? { ...track, clips: update(track.clips) } : track,
    ),
  };
}

/** Pure reducer: (timeline, operation) => timeline. Throws on invalid ops. */
export function applyOperation(
  timeline: Timeline,
  operation: Operation,
): Timeline {
  switch (operation.type) {
    case "add_clip": {
      const track = findTrack(timeline, operation.trackId);
      const clip: Clip = {
        id: operation.id ?? nextClipId(timeline),
        media: operation.media,
        startMs: operation.startMs,
        durationMs: operation.durationMs,
        inMs: operation.inMs,
        outMs: operation.outMs,
        label: operation.label,
        effects: [],
      };
      assertNoOverlap([...track.clips, clip], "add_clip");
      return updateTrack(timeline, operation.trackId, (clips) =>
        sortedByStart([...clips, clip]),
      );
    }

    case "trim_clip": {
      const { track, clip } = findClipTrack(timeline, operation.clipId);
      const updated: Clip = {
        ...clip,
        startMs: operation.startMs ?? clip.startMs,
        durationMs: operation.durationMs ?? clip.durationMs,
        inMs: operation.inMs ?? clip.inMs,
        outMs: operation.outMs ?? clip.outMs,
      };
      if (updated.outMs <= updated.inMs) {
        throw new Error(`trim_clip: outMs must be greater than inMs`);
      }
      const others = track.clips.filter((c) => c.id !== clip.id);
      assertNoOverlap([...others, updated], "trim_clip");
      return updateTrack(timeline, track.id, (clips) =>
        sortedByStart(clips.map((c) => (c.id === clip.id ? updated : c))),
      );
    }

    case "move_clip": {
      const { track, clip } = findClipTrack(timeline, operation.clipId);
      const targetId = operation.trackId ?? track.id;
      const target = findTrack(timeline, targetId);
      const moved: Clip = { ...clip, startMs: operation.startMs };
      if (moved.startMs === clip.startMs && targetId === track.id) {
        return timeline;
      }
      const remaining = track.clips.filter((c) => c.id !== clip.id);
      const placed = [
        ...target.clips.filter((c) => c.id !== clip.id),
        moved,
      ];
      assertNoOverlap(placed, "move_clip");
      let next: Timeline = updateTrack(timeline, track.id, () =>
        sortedByStart(remaining),
      );
      next = updateTrack(next, targetId, (clips) =>
        sortedByStart(
          targetId === track.id
            ? clips.filter((c) => c.id !== moved.id).concat(moved)
            : [...clips, moved],
        ),
      );
      return next;
    }

    case "remove_clip": {
      const { track } = findClipTrack(timeline, operation.clipId);
      return updateTrack(timeline, track.id, (clips) =>
        clips.filter((c) => c.id !== operation.clipId),
      );
    }

    case "set_effect": {
      const { track, clip } = findClipTrack(timeline, operation.clipId);
      if (operation.effect.type === "speed") {
        // A speed effect changes the source rate, so the source has to be
        // long enough to fill the clip's timeline duration at that rate.
        // Without this the render is silently short and every later clip
        // falls out of the frame.
        const rate = operation.effect.to ?? operation.effect.from ?? 1;
        const needed = Math.round(clip.durationMs * rate);
        const available = clip.outMs - clip.inMs;
        if (needed > available) {
          throw new Error(
            `set_effect: speed ${rate}x on clip "${clip.id}" needs ${needed}ms of source for its ${clip.durationMs}ms on the timeline, but the clip has only ${available}ms. Trim the clip to ${Math.floor(available / rate)}ms or slow it down.`,
          );
        }
      }
      const rest = clip.effects.filter(
        (e) => e.type !== operation.effect.type,
      );
      const effects: Effect[] = [...rest, operation.effect];
      return updateTrack(timeline, track.id, (clips) =>
        clips.map((c) => (c.id === clip.id ? { ...c, effects } : c)),
      );
    }

    case "split_clip": {
      const { track, clip } = findClipTrack(timeline, operation.clipId);
      const endMs = clip.startMs + clip.durationMs;
      if (operation.atMs <= clip.startMs || operation.atMs >= endMs) {
        throw new Error(
          `split_clip: atMs ${operation.atMs} is not inside clip "${clip.id}" [${clip.startMs}..${endMs}]`,
        );
      }
      // Split the source range proportionally, so it also holds when a speed
      // effect makes timeline and source durations differ.
      const leftDuration = operation.atMs - clip.startMs;
      const ratio = leftDuration / clip.durationMs;
      const splitSource =
        clip.inMs + Math.round((clip.outMs - clip.inMs) * ratio);
      const left: Clip = {
        ...clip,
        durationMs: leftDuration,
        outMs: splitSource,
        effects: [...clip.effects],
      };
      const right: Clip = {
        ...clip,
        id: nextClipId(timeline),
        startMs: operation.atMs,
        durationMs: endMs - operation.atMs,
        inMs: splitSource,
        effects: [...clip.effects],
        transition: undefined,
      };
      return updateTrack(timeline, track.id, (clips) => {
        const index = clips.findIndex((c) => c.id === clip.id);
        return sortedByStart([
          ...clips.slice(0, index),
          left,
          right,
          ...clips.slice(index + 1),
        ]);
      });
    }

    case "add_marker": {
      const marker: Marker = {
        id: operation.id ?? nextId(timeline.markers.map((m) => m.id), "marker"),
        atMs: operation.atMs,
        name: operation.name,
        color: operation.color,
      };
      return {
        ...timeline,
        markers: [...timeline.markers, marker].sort((a, b) => a.atMs - b.atMs),
      };
    }

    case "remove_marker": {
      if (!timeline.markers.some((m) => m.id === operation.markerId)) {
        throw new Error(`no marker with id "${operation.markerId}"`);
      }
      return {
        ...timeline,
        markers: timeline.markers.filter((m) => m.id !== operation.markerId),
      };
    }

    case "add_caption": {
      if (operation.endMs <= operation.atMs) {
        throw new Error("add_caption: endMs must be greater than atMs");
      }
      const caption: Caption = {
        id: operation.id ?? nextId(timeline.captions.map((c) => c.id), "caption"),
        atMs: operation.atMs,
        endMs: operation.endMs,
        text: operation.text,
      };
      return {
        ...timeline,
        captions: [...timeline.captions, caption].sort(
          (a, b) => a.atMs - b.atMs,
        ),
      };
    }

    case "remove_caption": {
      if (!timeline.captions.some((c) => c.id === operation.captionId)) {
        throw new Error(`no caption with id "${operation.captionId}"`);
      }
      return {
        ...timeline,
        captions: timeline.captions.filter(
          (c) => c.id !== operation.captionId,
        ),
      };
    }

    case "set_property": {
      return {
        ...timeline,
        name: operation.name ?? timeline.name,
        width: operation.width ?? timeline.width,
        height: operation.height ?? timeline.height,
        fps: operation.fps ?? timeline.fps,
      };
    }

    case "add_track": {
      const track: Track = {
        id: operation.id ?? nextId(timeline.tracks.map((t) => t.id), "track"),
        kind: operation.kind,
        clips: [],
      };
      return { ...timeline, tracks: [...timeline.tracks, track] };
    }

    case "remove_track": {
      findTrack(timeline, operation.trackId);
      return {
        ...timeline,
        tracks: timeline.tracks.filter((t) => t.id !== operation.trackId),
      };
    }

    case "mute_track": {
      const track = findTrack(timeline, operation.trackId);
      // Only an audio track can be muted. A muted video track would still
      // render, so the operation is refused rather than silently ignored.
      if (track.kind !== "audio") {
        throw new Error(
          `mute_track: track "${track.id}" is a video track. Only an audio track can be muted; remove the track or its clips instead.`,
        );
      }
      return {
        ...timeline,
        tracks: timeline.tracks.map((t) =>
          t.id === operation.trackId ? { ...t, muted: operation.muted } : t,
        ),
      };
    }

    case "set_transition": {
      const { track, clip } = findClipTrack(timeline, operation.clipId);
      if (track.kind !== "video") {
        throw new Error(
          `set_transition: clip "${clip.id}" is on an ${track.kind} track, and only a video track can transition`,
        );
      }
      if (operation.durationMs >= clip.durationMs) {
        throw new Error(
          `set_transition: duration ${operation.durationMs}ms is not shorter than clip "${clip.id}" (${clip.durationMs}ms)`,
        );
      }
      // The transition belongs to the incoming clip, and only renders when
      // the clip is exactly adjacent to the one before it.
      const index = track.clips.findIndex((c) => c.id === clip.id);
      const previous = track.clips[index - 1];
      if (previous === undefined) {
        throw new Error(
          `set_transition: clip "${clip.id}" is the first on its track, so it has no clip to transition from`,
        );
      }
      if (previous.startMs + previous.durationMs !== clip.startMs) {
        throw new Error(
          `set_transition: clip "${clip.id}" is not adjacent to "${previous.id}", so a transition between them would not render`,
        );
      }
      return updateTrack(timeline, track.id, (clips) =>
        clips.map((c) =>
          c.id === clip.id
            ? {
                ...c,
                transition: {
                  name: operation.name,
                  durationMs: operation.durationMs,
                },
              }
            : c,
        ),
      );
    }
  }
}
