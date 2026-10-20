// The data shape — the single source of truth for the timeline plan.
// Everything in core/ speaks these types; both hosts (bb, Claude Code) import
// them from here so the plan is portable between hosts.

export type Millis = number; // integer milliseconds — never floats
export type ClipId = string; // stable, generated

/**
 * The scope of a plan: the name every surface uses to agree on which plan it
 * is looking at.
 *
 * A thread's plan belongs to that thread. A shell call outside a thread has
 * no thread id, so it falls back to the working directory: one edit per
 * project folder, stable across invocations. A plugin page has neither a
 * thread nor a directory, so it uses the project.
 */
export function scopeFor(ctx: {
  threadId?: string | null;
  cwd?: string;
  projectId?: string | null;
}): string {
  if (ctx.threadId != null && ctx.threadId !== "") return `thread:${ctx.threadId}`;
  if (ctx.cwd != null && ctx.cwd !== "") return `cwd:${ctx.cwd}`;
  if (ctx.projectId != null && ctx.projectId !== "") return `project:${ctx.projectId}`;
  return "default";
}

export interface MediaRef {
  path: string; // absolute path on the host
  durationMs?: Millis; // filled by probe
  width?: number;
  height?: number;
  fps?: number;
}

export type EffectType =
  | "opacity"
  | "scale"
  | "position"
  | "crop"
  | "volume"
  | "fadeIn"
  | "fadeOut"
  | "speed";

export interface Effect {
  type: EffectType;
  amount?: number; // 0..1 opacity, 0..2 scale, 0..1 fade fraction, 1 = full volume
  x?: number; // position, -1..1 of frame
  y?: number;
  from?: number; // crop/speed: start fraction, or source rate
  to?: number; // crop/speed: end fraction, or target rate
}

export interface Clip {
  id: ClipId;
  media: MediaRef;
  startMs: Millis; // position on the timeline
  durationMs: Millis; // length on the timeline
  inMs: Millis; // source in point
  outMs: Millis; // source out point
  label?: string;
  effects: Effect[];
  // Transition between the previous adjacent clip and this one (the cut point
  // at startMs). Rendered as xfade; not every cut needs one — absent means a
  // hard cut. The operation model cannot create these (its op set is closed),
  // but the plan carries them so renders can cross-fade.
  transition?: { name: string; durationMs: Millis };
}

export interface Track {
  id: string;
  kind: "video" | "audio";
  clips: Clip[]; // ordered, non-overlapping
  muted?: boolean;
}

export interface Marker {
  id: string;
  atMs: Millis;
  name: string;
  color?: string;
}

export interface Caption {
  id: string;
  atMs: Millis;
  endMs: Millis;
  text: string;
}

export interface Timeline {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
  markers: Marker[];
  captions: Caption[]; // subtitle track, burned in at render
}

/**
 * The program length: the end of the last video clip, or the end of the last
 * clip on any track when the plan has no video. A video track defines the
 * length, so audio running past it does not stretch the program.
 */
export function timelineDurationMs(timeline: Timeline): Millis {
  const endOf = (kind: "video" | "audio"): Millis => {
    let end = 0;
    for (const track of timeline.tracks) {
      if (track.kind !== kind) continue;
      for (const clip of track.clips) {
        const at = clip.startMs + clip.durationMs;
        if (at > end) end = at;
      }
    }
    return end;
  };
  const videoEnd = endOf("video");
  return videoEnd > 0 ? videoEnd : endOf("audio");
}
