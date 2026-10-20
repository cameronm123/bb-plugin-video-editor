// bb-plugin-video-editor — a BB plugin backend entry.
//
// A video editing environment. The agent edits a "timeline plan" (a compact
// JSON description of tracks, clips, effects, markers and captions) through
// named operations; the plugin compiles that plan into an ffmpeg render.
//
// Three surfaces share one store:
//   - the `video_edit` agent tool (server.ts) — how the agent edits,
//   - the `bb video` CLI command — how a human or a shell script edits,
//   - the Video editor nav panel (app.tsx) — how the user sees the edit.
//
// The plan lives in bb.storage.kv under "timeline:<threadId>", so each thread
// owns its own edit. Rendering runs ffmpeg on the host that owns the media.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  applyOperation,
  validateOperation,
  type Timeline,
  type Millis,
} from "./core/operations";
import { digestTimeline } from "./core/digest";
import { probeMedia } from "./core/probe";
import { renderTimeline } from "./core/render";

const timelineSchema = z.object({
  id: z.string(),
  name: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive(),
  tracks: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["video", "audio"]),
      muted: z.boolean().optional(),
      clips: z.array(
        z.object({
          id: z.string(),
          media: z.object({
            path: z.string(),
            durationMs: z.number().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
            fps: z.number().optional(),
          }),
          startMs: z.number(),
          durationMs: z.number(),
          inMs: z.number(),
          outMs: z.number(),
          label: z.string().optional(),
          effects: z.array(
            z.object({
              type: z.enum([
                "opacity",
                "scale",
                "position",
                "crop",
                "volume",
                "fadeIn",
                "fadeOut",
                "speed",
              ]),
              amount: z.number().optional(),
              x: z.number().optional(),
              y: z.number().optional(),
              from: z.number().optional(),
              to: z.number().optional(),
            }),
          ),
        }),
      ),
    }),
  ),
  markers: z.array(
    z.object({
      id: z.string(),
      atMs: z.number(),
      name: z.string(),
      color: z.string().optional(),
    }),
  ),
  captions: z.array(
    z.object({
      id: z.string(),
      atMs: z.number(),
      endMs: z.number(),
      text: z.string(),
    }),
  ),
});

export const rpcContract = defineRpcContract({
  timeline_get: {
    input: z.object({ threadId: z.string() }),
    output: z.object({ timeline: timelineSchema }),
  },
  timeline_apply: {
    input: z.object({
      threadId: z.string(),
      operations: z.array(z.unknown()),
    }),
    output: z.object({
      timeline: timelineSchema,
      digest: z.string(),
      applied: z.number(),
    }),
  },
  timeline_render: {
    input: z.object({
      threadId: z.string(),
      outputPath: z.string().optional(),
    }),
    output: z.object({
      started: z.boolean(),
      outputPath: z.string().optional(),
      message: z.string(),
    }),
  },
  render_status: {
    input: z.object({ threadId: z.string() }),
    output: z.object({
      state: z.enum(["idle", "rendering", "done", "failed"]),
      outputPath: z.string().optional(),
      message: z.string(),
    }),
  },
  media_probe: {
    input: z.object({ path: z.string() }),
    output: z.object({
      durationMs: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      fps: z.number().optional(),
    }),
  },
});

/** Realtime channel app.tsx listens on. */
const TIMELINE_CHANGED = "timeline-changed";

function emptyTimeline(): Timeline {
  return {
    id: randomUUID(),
    name: "Untitled",
    width: 1920,
    height: 1080,
    fps: 30,
    tracks: [
      { id: randomUUID(), kind: "video", clips: [] },
      { id: randomUUID(), kind: "audio", clips: [] },
    ],
    markers: [],
    captions: [],
  };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    ffmpegPath: {
      type: "string",
      label: "ffmpeg path",
      default: "ffmpeg",
    },
    ffprobePath: {
      type: "string",
      label: "ffprobe path",
      default: "ffprobe",
    },
    renderRoot: {
      type: "string",
      label: "Render output directory",
      default: "",
    },
  });
  const { ffmpegPath, ffprobePath, renderRoot } = await settings.get();

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS renders (
       id TEXT PRIMARY KEY,
       thread_id TEXT NOT NULL,
       output_path TEXT NOT NULL,
       state TEXT NOT NULL,
       message TEXT NOT NULL DEFAULT '',
       created_at TEXT NOT NULL
     )`,
  ]);

  const key = (threadId: string) => `timeline:${threadId}`;

  async function readTimeline(threadId: string): Promise<Timeline> {
    const stored = await bb.storage.kv.get<Timeline>(key(threadId));
    return stored ?? emptyTimeline();
  }
  async function writeTimeline(threadId: string, timeline: Timeline): Promise<void> {
    await bb.storage.kv.set(key(threadId), timeline);
    bb.realtime.publish(TIMELINE_CHANGED, { threadId });
  }

  async function applyToThread(
    threadId: string,
    operations: unknown[],
  ): Promise<{ timeline: Timeline; digest: string; applied: number }> {
    let timeline = await readTimeline(threadId);
    for (const raw of operations) {
      const operation = validateOperation(raw);
      timeline = applyOperation(timeline, operation);
    }
    await writeTimeline(threadId, timeline);
    return {
      timeline,
      digest: digestTimeline(timeline),
      applied: operations.length,
    };
  }

  bb.rpc.register(rpcContract, {
    timeline_get: async ({ threadId }) => ({ timeline: await readTimeline(threadId) }),
    timeline_apply: async ({ threadId, operations }) =>
      applyToThread(threadId, operations),
    timeline_render: async ({ threadId, outputPath }) => {
      const timeline = await readTimeline(threadId);
      const hasClips = timeline.tracks.some((track) => track.clips.length > 0);
      if (!hasClips) {
        return {
          started: false,
          message: "Timeline has no clips. Add a clip before rendering.",
        };
      }
      const target =
        outputPath ??
        `${renderRoot || process.cwd()}/${timeline.name.replace(/[^\w.-]+/g, "_") || "output"}.mp4`;
      db.prepare(
        `INSERT INTO renders (id, thread_id, output_path, state, message, created_at)
         VALUES (?, ?, ?, 'rendering', '', ?)`,
      ).run(randomUUID(), threadId, target, new Date().toISOString());
      bb.realtime.publish(TIMELINE_CHANGED, { threadId });
      // Fire and forget: the render outlives this call, so the agent is not
      // blocked on ffmpeg. Poll render_status for the outcome.
      void renderTimeline(timeline, target, { ffmpegPath })
        .then((result) => {
          db.prepare(
            `UPDATE renders SET state = 'done', message = ? WHERE output_path = ?`,
          ).run(`Rendered in ${result.durationMs}ms`, target);
        })
        .catch((cause: unknown) => {
          db.prepare(
            `UPDATE renders SET state = 'failed', message = ? WHERE output_path = ?`,
          ).run(cause instanceof Error ? cause.message : String(cause), target);
        })
        .finally(() => {
          bb.realtime.publish(TIMELINE_CHANGED, { threadId });
        });
      return { started: true, outputPath: target, message: `Rendering to ${target}` };
    },
    render_status: async ({ threadId }) => {
      const row = db
        .prepare(
          `SELECT state, output_path, message FROM renders
           WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1`,
        )
        .get(threadId) as
        | { state: string; output_path: string; message: string }
        | undefined;
      if (row === undefined) {
        return { state: "idle" as const, message: "No render yet" };
      }
      return {
        state: row.state as "idle" | "rendering" | "done" | "failed",
        outputPath: row.output_path,
        message: row.message,
      };
    },
    media_probe: async ({ path }) => {
      const media = await probeMedia(path, { ffprobePath });
      return {
        durationMs: media.durationMs,
        width: media.width,
        height: media.height,
        fps: media.fps,
      };
    },
  });

  // The agent's handle on the timeline. One call, many operations, so a whole
  // edit is one atomic step the agent can reason about.
  bb.agents.registerTool({
    name: "video_edit",
    description:
      "Edit this thread's video timeline. Pass a list of operations; each is applied in order to the timeline plan and the new plan is returned as a digest. Read the timeline first with the video_edit action 'show' to learn the clip ids.",
    presentation: {
      label: {
        pending: "Editing timeline",
        completed: "Edited timeline",
      },
    },
    parameters: z.object({
      action: z
        .enum(["show", "apply", "render"])
        .describe(
          "show = return the current timeline digest; apply = apply operations; render = render the timeline to a file",
        ),
      operations: z
        .array(z.unknown())
        .optional()
        .describe(
          "Operations to apply, in order. Kinds: add_clip, trim_clip, move_clip, remove_clip, set_effect, split_clip, add_marker, remove_marker, add_caption, remove_caption, set_property, add_track, remove_track, mute_track.",
        ),
      outputPath: z
        .string()
        .optional()
        .describe("Where to write the render. Defaults to the thread's render root."),
    }),
    async execute(params, ctx) {
      if (params.action === "show") {
        const timeline = await readTimeline(ctx.threadId);
        return digestTimeline(timeline);
      }
      if (params.action === "apply") {
        const operations = params.operations ?? [];
        const result = await applyToThread(ctx.threadId, operations);
        return `${result.applied} operation(s) applied.\n\n${result.digest}`;
      }
      const timeline = await readTimeline(ctx.threadId);
      const target =
        params.outputPath ??
        `${renderRoot || process.cwd()}/${timeline.name.replace(/[^\w.-]+/g, "_") || "output"}.mp4`;
      const result = await renderTimeline(timeline, target, {
        ffmpegPath,
        signal: ctx.signal,
      });
      return `Rendered to ${result.outputPath} in ${result.durationMs}ms.`;
    },
  });

  // The `bb video` command family: what a human or a shell script uses.
  bb.cli.register({
    name: "video",
    summary: "Edit and render the video timeline",
    commands: [
      { name: "probe", summary: "Probe a media file", usage: "bb video probe <path>" },
      {
        name: "timeline",
        summary: "Show or edit the timeline",
        usage: "bb video timeline show|apply [--thread <id>] [--op <json>]",
      },
      {
        name: "render",
        summary: "Render the timeline",
        usage: "bb video render [--thread <id>] [--out <path>]",
      },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json");
      const threadId = ctx.threadId ?? "default";
      const flag = (name: string): string | undefined => {
        const index = argv.indexOf(name);
        return index === -1 ? undefined : argv[index + 1];
      };
      const positionals = argv.filter(
        (arg, index) =>
          !arg.startsWith("--") &&
          argv[index - 1] !== "--thread" &&
          argv[index - 1] !== "--op" &&
          argv[index - 1] !== "--out",
      );
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });

      const [command, sub] = positionals;
      if (command === "probe") {
        const path = positionals[2];
        if (path === undefined) {
          return { exitCode: 1, stderr: "Usage: bb video probe <path>" };
        }
        const media = await probeMedia(path, { ffprobePath });
        return reply(media, JSON.stringify(media, null, 2));
      }

      if (command === "timeline") {
        if (sub === "apply") {
          const raw = flag("--op");
          if (raw === undefined) {
            return { exitCode: 1, stderr: "Pass --op '<json>'" };
          }
          const parsed: unknown = JSON.parse(raw);
          const operations = Array.isArray(parsed) ? parsed : [parsed];
          const result = await applyToThread(threadId, operations);
          return reply(result, result.digest);
        }
        const timeline = await readTimeline(threadId);
        return reply(timeline, digestTimeline(timeline));
      }

      if (command === "render") {
        const timeline = await readTimeline(threadId);
        const target =
          flag("--out") ??
          `${renderRoot || process.cwd()}/${timeline.name.replace(/[^\w.-]+/g, "_") || "output"}.mp4`;
        const result = await renderTimeline(timeline, target, { ffmpegPath });
        return reply(result, `Rendered to ${result.outputPath}`);
      }

      return {
        exitCode: 1,
        stderr:
          "Usage:\n  bb video probe <path>\n  bb video timeline show|apply [--op <json>]\n  bb video render [--out <path>]",
      };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
