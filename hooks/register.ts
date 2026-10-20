// The Claude Code mod's entry point. Every mods API call lives here, written
// in full ($.x.y(...)): `claude plugin validate` requires each call spelled
// out, `$` may only be passed to top-level functions in this same file, and
// each on(...) event name must be a string literal.
import { digestTimeline } from "../core/digest.ts";
import { compileFfmpeg } from "../core/ffmpeg.ts";
import type { Timeline } from "../core/types.ts";
import {
  reduceOperations,
  timelineFromStored,
  type OnEvent,
  type ToolCallEvent,
  type VideoModsApi,
} from "./video.ts";

// The timeline plan persists in $.store (a JSON key-value store shared by
// every session on the machine), under this namespaced key.
const STORE_KEY = "video-editor.timeline";

// The full name of the registered tool: mcp__, the plugin name from
// .claude-plugin/plugin.json, and the name passed to $.tool.register.
const TOOL_NAME = "mcp__video-editor__video_edit";

// $.process.run caps at ten minutes.
const FFMPEG_TIMEOUT_MS = 600000;

export function register(on: OnEvent) {
  on("session.start", async ($, e, next) => {
    await $.command.register({
      name: "video",
      description: "Show the current video timeline digest",
    });
    await $.tool.register({
      name: "video_edit",
      description:
        "Apply editing operations to the video timeline plan and return its digest. " +
        "Each operation is an object with a `type` field: add_track (a track must exist " +
        "before add_clip), add_clip, trim_clip, move_clip, remove_clip, set_effect, " +
        "split_clip, add_marker, remove_marker, add_caption, remove_caption, " +
        "set_property, remove_track, mute_track. Operations apply in order. " +
        "Set `render` to an output file path to render the timeline with ffmpeg after applying.",
      inputSchema: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            description: "Operations to apply, in order.",
            items: { type: "object" },
          },
          render: {
            type: "string",
            description:
              "Optional output file path (e.g. out.mp4) to render the timeline to with ffmpeg after applying the operations.",
          },
        },
        required: ["operations"],
      },
    });
    return next(e);
  });

  on("command.run", { command: "video" }, async ($) => {
    const timeline = timelineFromStored(await $.store.get(STORE_KEY));
    return { text: digestTimeline(timeline) };
  });

  on("tool.call", { tool: TOOL_NAME }, async ($, e: ToolCallEvent) => {
    try {
      const timeline = timelineFromStored(await $.store.get(STORE_KEY));
      const updated = reduceOperations(timeline, e.operations);
      await $.store.set(STORE_KEY, updated);
      let digest = digestTimeline(updated);
      if (typeof e.render === "string" && e.render !== "") {
        // The operations already applied and persisted, so a render failure
        // reports beside the digest instead of masking it as an error.
        try {
          digest += "\n" + (await render($, updated, e.render));
        } catch (error) {
          digest += "\nrender FAILED: " + errorMessage(error);
        }
      }
      return { result: digest };
    } catch (error) {
      // Answer the call either way, so the model learns why it failed.
      return { result: "error: " + errorMessage(error) };
    }
  }).catch(async ($, e, next) => {
    // The hook itself threw or overran: answer with the failure.
    return {
      result: "error: video_edit hook failed: " + next.error.message,
    };
  });
}

/**
 * Render a timeline with ffmpeg via $.process.run, from the pure core's
 * compiled argument list. Top-level in this file so it may take `$`.
 */
async function render(
  $: VideoModsApi,
  timeline: Timeline,
  outputPath: string,
): Promise<string> {
  // Captions burn in from an .ass file the caller writes. $.fs has no
  // delete, so the temp file is overwritten each render, never removed.
  // shortcut: the file lingers in TMPDIR until the OS cleans it.
  const tmpDir = await $.env.get("TMPDIR");
  const captionFile =
    tmpDir !== undefined && tmpDir !== ""
      ? tmpDir + (tmpDir.endsWith("/") ? "" : "/") +
        "video-editor-captions.ass"
      : "video-editor-captions.ass";
  const { args, captionContent } = compileFfmpeg(timeline, {
    outputPath,
    captionFile,
  });
  if (captionContent !== undefined) {
    await $.fs.write(captionFile, captionContent);
  }
  const run = await $.process.run(["ffmpeg", ...args], {
    timeoutMs: FFMPEG_TIMEOUT_MS,
  });
  if (run.exitCode !== 0) {
    return "render FAILED (ffmpeg exit " + run.exitCode + "): " +
      run.stderr.slice(-400);
  }
  return "rendered " + outputPath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
