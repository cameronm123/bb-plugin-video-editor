// Compiles a timeline plan into one ffmpeg command: an argument list plus the
// filter graph text. PURE — no I/O, no process spawning. Both hosts build on
// this: bb's render.ts spawns ffmpeg itself, and the Claude Code mod builds
// its own $.process.run argv from the same output.
//
// Time is integer milliseconds in the plan; ffmpeg wants seconds, converted
// here at the last moment.
import type { Clip, Effect, EffectType, Millis, Timeline } from "./types.ts";
import { timelineDurationMs } from "./types.ts";

export interface CompileOptions {
  outputPath: string;
  /**
   * Where the caller will write the generated caption subtitle file before
   * running ffmpeg (only needed when the timeline has captions). The caller
   * owns the file lifecycle: write result.captionContent here, delete later.
   */
  captionFile?: string;
}

export interface CompileResult {
  /** Full ffmpeg argument list, ready to prepend the binary and run. */
  args: string[];
  /** The -filter_complex value (also embedded as args). */
  filterGraph: string;
  /**
   * Present iff the timeline has captions and opts.captionFile was given:
   * .ass (Advanced SubStation) content the caller must write to
   * opts.captionFile before invoking ffmpeg.
   */
  captionContent?: string;
}

function sec(ms: Millis): string {
  // Milliseconds divide cleanly into a decimal string; no float math on plan
  // data beyond this rendering step.
  return (ms / 1000).toString();
}

function effectOf(clip: Clip, type: EffectType): Effect | undefined {
  return clip.effects.find((e) => e.type === type);
}

function speedRate(clip: Clip): number | undefined {
  const effect = effectOf(clip, "speed");
  if (effect === undefined) return undefined;
  return effect.to ?? effect.from ?? 1;
}

function fadeMs(clip: Clip, kind: "fadeIn" | "fadeOut"): number {
  // Fade duration is a fraction (amount, 0..1) of the clip's length.
  const effect = effectOf(clip, kind);
  if (effect === undefined) return 0;
  const amount = effect.amount ?? 0;
  return Math.round(Math.min(Math.max(amount, 0), 1) * clip.durationMs);
}

// xfade blends the tail of clip A with the head of clip B, so the joined pair
// is dur_a + dur_b - d long: everything after a transition renders `d` earlier
// than its plan position. Everything placed by absolute time (overlays, audio
// via adelay, captions) must be shifted by the same amount or it drifts.
interface TransitionCut {
  atMs: Millis; // cut point in plan time (= incoming clip's startMs)
  durationMs: Millis;
}

function baseTransitionCuts(timeline: Timeline): TransitionCut[] {
  const videoTracks = timeline.tracks.filter((t) => t.kind === "video");
  const base = videoTracks[0];
  if (base === undefined) return [];
  const ordered = [...base.clips].sort((a, b) => a.startMs - b.startMs);
  const cuts: TransitionCut[] = [];
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1];
    const clip = ordered[i];
    const adjacent = prev.startMs + prev.durationMs === clip.startMs;
    if (clip.transition !== undefined && adjacent) {
      cuts.push({ atMs: clip.startMs, durationMs: clip.transition.durationMs });
    }
  }
  return cuts;
}

function shiftFn(cuts: TransitionCut[]): (ms: Millis) => Millis {
  return (ms) => {
    let shift = 0;
    for (const cut of cuts) {
      if (cut.atMs <= ms) shift += cut.durationMs;
    }
    return ms - shift;
  };
}

// --- per-clip filter chains -------------------------------------------------

function trimChain(clip: Clip): string {
  const parts = [
    `trim=start=${sec(clip.inMs)}:end=${sec(clip.outMs)}`,
    "setpts=PTS-STARTPTS",
  ];
  const rate = speedRate(clip);
  if (rate !== undefined && rate !== 1) {
    parts.push(`setpts=PTS/${rate}`);
  }
  return parts.join(",");
}

function cropFilter(clip: Clip): string | undefined {
  const effect = effectOf(clip, "crop");
  if (effect === undefined) return undefined;
  const from = Math.min(Math.max(effect.from ?? 0, 0), 1);
  const to = Math.min(Math.max(effect.to ?? 1, from), 1);
  if (to - from <= 0) return undefined;
  // Crop keeps the box from fraction `from` to fraction `to` on both axes.
  return `crop=w=iw*${to - from}:h=ih*${to - from}:x=iw*${from}:y=ih*${from}`;
}

function fadeFilters(clip: Clip, alpha: boolean): string[] {
  const parts: string[] = [];
  const inMs = fadeMs(clip, "fadeIn");
  const outMs = fadeMs(clip, "fadeOut");
  if (inMs > 0) {
    parts.push(`fade=t=in:st=0:d=${sec(inMs)}${alpha ? ":alpha=1" : ""}`);
  }
  if (outMs > 0) {
    const start = clip.durationMs - outMs;
    parts.push(
      `fade=t=out:st=${sec(start)}:d=${sec(outMs)}${alpha ? ":alpha=1" : ""}`,
    );
  }
  return parts;
}

/** Base-track clip chain: scaled/padded to canvas, opaque black padding. */
function baseClipChain(
  clip: Clip,
  timeline: Timeline,
  headMs: Millis,
): string {
  const parts = [trimChain(clip)];
  const crop = cropFilter(clip);
  if (crop !== undefined) parts.push(crop);
  parts.push(
    `scale=${timeline.width}:${timeline.height}:force_original_aspect_ratio=decrease`,
    `pad=${timeline.width}:${timeline.height}:(ow-iw)/2:(oh-ih)/2`,
  );
  // The scale effect shrinks the picture inside the canvas. It runs after the
  // fit-and-pad, so the canvas is not scaled back up, and a second pad
  // centres the smaller picture.
  const scale = effectOf(clip, "scale");
  if (scale !== undefined && scale.amount !== undefined && scale.amount !== 1) {
    const amt = Math.min(Math.max(scale.amount, 0), 2);
    parts.push(
      `scale=w=${amt}*iw:h=${amt}*ih`,
      `pad=${timeline.width}:${timeline.height}:(ow-iw)/2:(oh-ih)/2`,
    );
  }
  const opacity = effectOf(clip, "opacity");
  if (opacity !== undefined && opacity.amount !== undefined) {
    // Opacity on the base track darkens the picture, because the base track
    // is composited over black. Scaling each colour channel by the opacity
    // is that blend; an alpha channel would be discarded by the yuv420p
    // conversion that follows.
    const amt = Math.min(Math.max(opacity.amount, 0), 1);
    parts.push(
      `colorchannelmixer=rr=${amt}:rg=0:rb=0:gr=0:gg=${amt}:gb=0:br=0:bg=0:bb=${amt}`,
    );
  }
  parts.push(...fadeFilters(clip, false));
  parts.push(`fps=${timeline.fps}`, "format=yuv420p");
  if (headMs > 0) {
    parts.push(`tpad=start_duration=${sec(headMs)}:start_mode=add:color=black`);
  }
  return parts.join(",");
}

/** Overlay-track clip chain: keeps alpha, transparent padding before it. */
function overlayClipChain(
  clip: Clip,
  timeline: Timeline,
  startMs: Millis,
): string {
  const parts = [trimChain(clip)];
  const crop = cropFilter(clip);
  if (crop !== undefined) parts.push(crop);
  const scale = effectOf(clip, "scale");
  if (scale !== undefined && scale.amount !== undefined && scale.amount !== 1) {
    const amt = Math.min(Math.max(scale.amount, 0), 2);
    parts.push(`scale=w=${amt}*iw:h=${amt}*ih`);
  }
  parts.push("format=yuva420p");
  const opacity = effectOf(clip, "opacity");
  if (opacity !== undefined && opacity.amount !== undefined) {
    parts.push(
      `colorchannelmixer=aa=${Math.min(Math.max(opacity.amount, 0), 1)}`,
    );
  }
  parts.push(...fadeFilters(clip, true));
  parts.push(`fps=${timeline.fps}`);
  // Transparent lead-in places the clip at its (transition-shifted) position.
  parts.push(
    `tpad=start_duration=${sec(startMs)}:start_mode=add:color=black@0.0`,
  );
  return parts.join(",");
}

function overlayPosition(clip: Clip): { x: string; y: string } {
  const position = effectOf(clip, "position");
  const px = position?.x ?? 0;
  const py = position?.y ?? 0;
  return {
    // -1..1 maps the clip centre across the frame; 0 is centred.
    x: `(main_w-overlay_w)/2+${px}*main_w/2`,
    y: `(main_h-overlay_h)/2+${py}*main_h/2`,
  };
}

/** Audio-track clip chain: placed with adelay (integer milliseconds). */
function audioClipChain(clip: Clip, startMs: Millis): string {
  const parts = [
    `atrim=start=${sec(clip.inMs)}:end=${sec(clip.outMs)}`,
    "asetpts=PTS-STARTPTS",
  ];
  const rate = speedRate(clip);
  if (rate !== undefined && rate !== 1) {
    parts.push(`atempo=${rate}`);
  }
  const volume = effectOf(clip, "volume");
  if (volume !== undefined && volume.amount !== undefined) {
    parts.push(`volume=${volume.amount}`);
  }
  const inMs = fadeMs(clip, "fadeIn");
  if (inMs > 0) parts.push(`afade=t=in:st=0:d=${sec(inMs)}`);
  const outMs = fadeMs(clip, "fadeOut");
  if (outMs > 0) {
    parts.push(`afade=t=out:st=${sec(clip.durationMs - outMs)}:d=${sec(outMs)}`);
  }
  parts.push(`adelay=${startMs}:all=1`);
  return parts.join(",");
}

// --- captions ----------------------------------------------------------------

function assTime(ms: Millis): string {
  const centis = Math.floor(ms / 10);
  const totalSeconds = Math.floor(centis / 100);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${hours}:${pad(minutes)}:${pad(seconds)}.${pad(centis % 100)}`;
}

/**
 * Generate the .ass (Advanced SubStation) subtitle file content for the
 * timeline's captions, burned in at render. Pure.
 */
export function buildAssSubtitles(timeline: Timeline): string {
  const { width, height } = timeline;
  const shift = shiftFn(baseTransitionCuts(timeline));
  const lines = [
    "[Script Info]",
    "; Generated by bb-plugin-video-editor",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,Arial,${Math.round(height * 0.05)},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];
  for (const caption of timeline.captions) {
    if (caption.endMs <= caption.atMs) continue;
    const text = caption.text.replace(/\r?\n/g, "\\N");
    lines.push(
      `Dialogue: 0,${assTime(shift(caption.atMs))},${assTime(shift(caption.endMs))},Default,,0,0,0,,${text}`,
    );
  }
  return lines.join("\n") + "\n";
}

function escapeFilterPath(path: string): string {
  // Inside single quotes only quotes and backslashes are special to the
  // filter-graph parser.
  return `'${path.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// --- the compiler --------------------------------------------------------------

interface InputPlan {
  /** argv chunks for -i entries, in input-index order. */
  args: string[];
}

export function compileFfmpeg(
  timeline: Timeline,
  opts: CompileOptions,
): CompileResult {
  const clips = timeline.tracks.flatMap((t) => t.clips);
  if (clips.length === 0) {
    throw new Error("timeline has no clips to render");
  }

  const videoTracks = timeline.tracks.filter((t) => t.kind === "video");
  const audioTracks = timeline.tracks.filter((t) => t.kind === "audio");
  const base = videoTracks[0];
  const overlayTracks = videoTracks.slice(1);
  const cuts = baseTransitionCuts(timeline);
  const shift = shiftFn(cuts);

  const inputPlan: InputPlan = { args: [] };
  let inputIndex = 0;
  const nextInput = (clip: Clip): number => {
    const index = inputIndex;
    inputIndex += 1;
    inputPlan.args.push("-i", clip.media.path);
    return index;
  };

  const graph: string[] = [];

  // Base video track: sequential joins with xfade at transitions, black
  // padding for gaps.
  let videoLabel: string | undefined;
  if (base !== undefined && base.clips.length > 0) {
    const ordered = [...base.clips].sort((a, b) => a.startMs - b.startMs);
    let prevLabel: string | undefined;
    let prevEnd: Millis | undefined;
    let shiftAccum = 0;
    ordered.forEach((clip, i) => {
      const headMs =
        prevEnd === undefined
          ? clip.startMs
          : Math.max(clip.startMs - prevEnd, 0);
      const label = `b${i}`;
      graph.push(
        `[${nextInput(clip)}:v]${baseClipChain(clip, timeline, headMs)}[${label}]`,
      );
      const transition =
        prevEnd !== undefined && clip.startMs === prevEnd
          ? clip.transition
          : undefined;
      if (prevLabel === undefined) {
        videoLabel = label;
      } else if (transition !== undefined && transition.durationMs > 0) {
        if (transition.durationMs >= clip.durationMs) {
          throw new Error(
            `transition "${transition.name}" (${transition.durationMs}ms) is not shorter than clip "${clip.id}" (${clip.durationMs}ms)`,
          );
        }
        // Crossfade starts `d` before the plan cut point, in rendered time.
        const offsetMs = clip.startMs - transition.durationMs - shiftAccum;
        const outLabel = `x${i}`;
        graph.push(
          `[${prevLabel}][${label}]xfade=transition=${transition.name}:duration=${sec(transition.durationMs)}:offset=${sec(offsetMs)}[${outLabel}]`,
        );
        shiftAccum += transition.durationMs;
        videoLabel = outLabel;
      } else {
        const outLabel = `c${i}`;
        graph.push(`[${prevLabel}][${label}]concat=n=2:v=1:a=0[${outLabel}]`);
        videoLabel = outLabel;
      }
      prevLabel = videoLabel;
      prevEnd = clip.startMs + clip.durationMs;
    });
  }

  // A timeline with no video track still has to produce a video: render a
  // black canvas for the plan's full duration and lay the audio over it.
  if (videoLabel === undefined) {
    const total = Math.max(timelineDurationMs(timeline), 1);
    const index = inputIndex;
    inputIndex += 1;
    inputPlan.args.push(
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${timeline.width}x${timeline.height}:r=${timeline.fps}:d=${sec(total)}`,
    );
    graph.push(`[${index}:v]format=yuv420p[base]`);
    videoLabel = "base";
  }

  // Overlay clips stacked on top, in track order (higher track = on top).
  for (const track of overlayTracks) {
    if (track.clips.length === 0) continue;
    for (const clip of track.clips) {
      const label = `ov${graph.length}`;
      const startMs = shift(clip.startMs);
      graph.push(
        `[${nextInput(clip)}:v]${overlayClipChain(clip, timeline, startMs)}[${label}]`,
      );
      const { x, y } = overlayPosition(clip);
      const outLabel = `v${graph.length}`;
      graph.push(
        `[${videoLabel}][${label}]overlay=x='${x}':y='${y}':eof_action=pass:format=auto[${outLabel}]`,
      );
      videoLabel = outLabel;
    }
  }

  // Audio: per-clip chains (adelay places them), one amix over all.
  const audioLabels: string[] = [];
  for (const track of audioTracks) {
    if (track.muted === true) continue;
    for (const clip of track.clips) {
      const label = `a${audioLabels.length}`;
      graph.push(
        `[${nextInput(clip)}:a]${audioClipChain(clip, shift(clip.startMs))}[${label}]`,
      );
      audioLabels.push(label);
    }
  }
  let audioLabel: string | undefined;
  if (audioLabels.length === 1) {
    audioLabel = audioLabels[0];
  } else if (audioLabels.length >= 2) {
    audioLabel = "amix";
    graph.push(
      `${audioLabels.map((l) => `[${l}]`).join("")}amix=inputs=${audioLabels.length}:duration=longest:normalize=0[${audioLabel}]`,
    );
  }

  // Caption burn-in via the caller-written subtitle file.
  let captionContent: string | undefined;
  if (
    timeline.captions.some((c) => c.endMs > c.atMs) &&
    videoLabel !== undefined
  ) {
    if (opts.captionFile === undefined) {
      throw new Error(
        "timeline has captions: pass captionFile so the subtitles filter can reference it",
      );
    }
    captionContent = buildAssSubtitles(timeline);
    const outLabel = `sub${graph.length}`;
    graph.push(
      `[${videoLabel}]subtitles=filename=${escapeFilterPath(opts.captionFile)}[${outLabel}]`,
    );
    videoLabel = outLabel;
  }

  const filterGraph = graph.join(";");

  const args = [...inputPlan.args, "-filter_complex", filterGraph];
  if (videoLabel !== undefined) {
    args.push(
      "-map",
      `[${videoLabel}]`,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
    );
  }
  if (audioLabel !== undefined) {
    args.push("-map", `[${audioLabel}]`, "-c:a", "aac");
  }
  args.push("-y", opts.outputPath);

  const result: CompileResult = { args, filterGraph };
  if (captionContent !== undefined) {
    result.captionContent = captionContent;
  }
  return result;
}
