// Runs ffmpeg — the only place in core that spawns a process, so this file is
// for the bb host only (the Claude Code mod runs ffmpeg itself via
// $.process.run and builds its argv from the pure core/ffmpeg.ts output).
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { compileFfmpeg } from "./ffmpeg.ts";
import type { Timeline } from "./types.ts";
import { timelineDurationMs } from "./types.ts";

export interface RenderOptions {
  ffmpegPath?: string;
  /** Abort the render: ffmpeg is killed and the promise rejects. */
  signal?: AbortSignal;
  /** Called with the 0..1 fraction of output time encoded so far. */
  onProgress?: (fraction: number) => void;
}

export interface RenderResult {
  outputPath: string;
  exitCode: number;
  /** Wall-clock time the render took, not the video length. */
  durationMs: number;
}

function tail(text: string, max = 4000): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

export async function renderTimeline(
  timeline: Timeline,
  outputPath: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  options.signal?.throwIfAborted();
  const startedAt = Date.now();

  // Caption temp file lifecycle: create before the run, delete in finally.
  const hasCaptions = timeline.captions.some((c) => c.endMs > c.atMs);
  let captionDir: string | undefined;
  if (hasCaptions) {
    captionDir = await mkdtemp(join(tmpdir(), "ve-captions-"));
  }

  try {
    const captionFile =
      captionDir === undefined ? undefined : join(captionDir, "captions.ass");
    const { args, captionContent } = compileFfmpeg(timeline, {
      outputPath,
      captionFile,
    });
    if (captionContent !== undefined && captionFile !== undefined) {
      await writeFile(captionFile, captionContent, "utf8");
    }

    const totalMs = timelineDurationMs(timeline);
    const ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    await mkdir(dirname(outputPath), { recursive: true });

    const exitCode = await new Promise<number>((resolve, reject) => {
      const proc = spawn(
        ffmpegPath,
        ["-progress", "pipe:1", "-nostats", ...args],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stderr = "";
      let aborted = false;
      const onAbort = () => {
        aborted = true;
        proc.kill("SIGKILL");
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      // Covers the window where the signal aborted after the entry check but
      // before the listener above was attached (already-aborted signals fire
      // no event).
      if (options.signal?.aborted === true) onAbort();

      proc.stdout.on("data", (chunk: Buffer) => {
        // ffmpeg's own out_time_ms is really microseconds; out_time_us is exact.
        const match = /out_time_us=(\d+)/.exec(chunk.toString());
        if (match !== null && options.onProgress !== undefined && totalMs > 0) {
          const doneMs = Number(match[1]) / 1000;
          options.onProgress(Math.min(doneMs / totalMs, 1));
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr = tail(stderr + chunk.toString());
      });
      proc.on("error", (err) => {
        options.signal?.removeEventListener("abort", onAbort);
        reject(new Error(`could not run ffmpeg at "${ffmpegPath}": ${err.message}`));
      });
      proc.on("close", (code) => {
        options.signal?.removeEventListener("abort", onAbort);
        if (code === 0) {
          resolve(0);
        } else if (aborted) {
          reject(new Error("render aborted"));
        } else {
          reject(
            new Error(
              `ffmpeg exited with code ${code ?? -1}:\n${tail(stderr)}`,
            ),
          );
        }
      });
    });

    if (!existsSync(outputPath)) {
      throw new Error(`ffmpeg reported success but ${outputPath} does not exist`);
    }
    if (statSync(outputPath).size === 0) {
      throw new Error(`ffmpeg reported success but ${outputPath} is empty`);
    }

    return { outputPath, exitCode, durationMs: Date.now() - startedAt };
  } finally {
    if (captionDir !== undefined) {
      await rm(captionDir, { recursive: true, force: true });
    }
  }
}
