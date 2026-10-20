// Pure ffprobe JSON parsing — no zod, no node builtins, importable from hosts
// (the Claude Code mod) whose loaders forbid bare imports. The mod runs
// ffprobe itself and feeds the JSON string to this function.
import type { MediaRef, Millis } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ffprobe emits rationals like "30000/1001"; "0/0" means unknown.
function parseFps(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const [num, den] = value.split("/");
  const n = Number(num);
  const d = den === undefined ? 1 : Number(den);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0 || n === 0) {
    return undefined;
  }
  return Math.round((n / d) * 1000) / 1000;
}

function durationMsOf(value: unknown): Millis | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const seconds = Number.parseFloat(String(value));
  if (!Number.isFinite(seconds)) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * Parse ffprobe JSON output (as produced by
 * `ffprobe -print_format json -show_format -show_streams`) into a MediaRef.
 * Pure: no I/O, no process.
 */
export function parseFfprobeJson(json: string, path: string): MediaRef {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) {
    throw new Error("ffprobe output is not a JSON object");
  }
  if (!Array.isArray(parsed.streams)) {
    throw new Error("ffprobe output has no streams array");
  }
  const streams = parsed.streams.filter(isRecord);
  const video = streams.find((s) => s.codec_type === "video");
  const format = isRecord(parsed.format) ? parsed.format : undefined;
  const durationMs =
    durationMsOf(format?.duration) ??
    durationMsOf(video?.duration) ??
    durationMsOf(streams.find((s) => s.duration !== undefined)?.duration);

  const media: MediaRef = { path };
  if (durationMs !== undefined) {
    media.durationMs = durationMs;
  }
  if (video !== undefined) {
    media.width = typeof video.width === "number" ? video.width : undefined;
    media.height = typeof video.height === "number" ? video.height : undefined;
    media.fps = parseFps(video.avg_frame_rate) ?? parseFps(video.r_frame_rate);
  }
  return media;
}
