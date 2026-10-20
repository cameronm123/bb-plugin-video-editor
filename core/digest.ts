// The compact text digest an agent reads instead of raw timeline JSON — the
// replacement for the 40 MB .prproj: whole edit on one screen, one line per
// track item.
import type { Clip, Effect, Timeline } from "./types.ts";
import { timelineDurationMs } from "./types.ts";

function effectText(effect: Effect): string {
  switch (effect.type) {
    case "position":
      return `position(x=${effect.x ?? 0},y=${effect.y ?? 0})`;
    case "crop":
      return `crop(from=${effect.from ?? 0},to=${effect.to ?? 1})`;
    case "speed":
      return `speed(to=${effect.to ?? 1})`;
    default:
      return `${effect.type}=${effect.amount ?? ""}`;
  }
}

function clipText(clip: Clip): string[] {
  const lines = [
    `  ${clip.id} @${clip.startMs}+${clip.durationMs}ms ` +
      `in=${clip.inMs} out=${clip.outMs} src=${clip.media.path}` +
      (clip.label !== undefined ? ` "${clip.label}"` : "") +
      (clip.transition !== undefined
        ? ` [enter:xfade ${clip.transition.name} ${clip.transition.durationMs}ms]`
        : ""),
  ];
  if (clip.effects.length > 0) {
    lines.push(
      `    effects: ${clip.effects.map(effectText).join(", ")}`,
    );
  }
  return lines;
}

export function digestTimeline(timeline: Timeline): string {
  const lines: string[] = [
    `timeline "${timeline.name}" ${timeline.width}x${timeline.height} @${timeline.fps}fps ` +
      `${timelineDurationMs(timeline)}ms`,
  ];
  let videoIndex = 0;
  for (const track of timeline.tracks) {
    if (track.kind === "video") {
      videoIndex += 1;
    }
    const kindLabel =
      track.kind === "video"
        ? `video${videoIndex}${videoIndex === 1 ? " (base)" : ""}`
        : "audio";
    lines.push(
      `track ${track.id} [${kindLabel}]${track.muted ? " MUTED" : ""}`,
    );
    if (track.clips.length === 0) {
      lines.push("  (empty)");
    } else {
      for (const clip of track.clips) {
        lines.push(...clipText(clip));
      }
    }
  }
  if (timeline.markers.length > 0) {
    lines.push("markers:");
    for (const marker of timeline.markers) {
      lines.push(`  ${marker.id} @${marker.atMs}ms "${marker.name}"`);
    }
  }
  if (timeline.captions.length > 0) {
    lines.push("captions:");
    for (const caption of timeline.captions) {
      lines.push(
        `  ${caption.id} @${caption.atMs}-${caption.endMs}ms "${caption.text}"`,
      );
    }
  }
  return lines.join("\n");
}
