import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { probeMedia } from "./probe.ts";
import { renderTimeline } from "./render.ts";
import type { Timeline } from "./types.ts";

const execFileAsync = promisify(execFile);

const FFMPEG = process.env.FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH ?? "/opt/homebrew/bin/ffprobe";

test("end-to-end: render a two-clip timeline", async (t) => {
  if (!existsSync(FFMPEG)) {
    t.skip(`ffmpeg not found at ${FFMPEG}`);
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "ve-render-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Source fixtures: two 2s color clips and a 2s tone.
  const a = join(dir, "a.mp4");
  const b = join(dir, "b.mp4");
  const tone = join(dir, "tone.m4a");
  const run = (args: string[]) => execFileAsync(FFMPEG, ["-y", ...args]);
  await run([
    "-f", "lavfi", "-i", "testsrc2=duration=2:size=320x240:rate=30",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", a,
  ]);
  await run([
    "-f", "lavfi", "-i", "smptebars=duration=2:size=320x240:rate=30",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", b,
  ]);
  await run([
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-c:a", "aac", tone,
  ]);

  // 320x240@30: base track of two clips crossfaded 500ms, an overlay, two
  // audio clips mixed, and one caption. Renders every required feature once.
  const timeline: Timeline = {
    id: "e2e",
    name: "E2E",
    width: 320,
    height: 240,
    fps: 30,
    tracks: [
      {
        id: "v1",
        kind: "video",
        clips: [
          {
            id: "c1",
            media: { path: a, durationMs: 2000, width: 320, height: 240, fps: 30 },
            startMs: 0,
            durationMs: 2000,
            inMs: 0,
            outMs: 2000,
            effects: [],
          },
          {
            id: "c2",
            media: { path: b, durationMs: 2000, width: 320, height: 240, fps: 30 },
            startMs: 2000,
            durationMs: 2000,
            inMs: 0,
            outMs: 2000,
            effects: [],
            transition: { name: "fade", durationMs: 500 },
          },
        ],
      },
      {
        id: "v2",
        kind: "video",
        clips: [
          {
            id: "c3",
            media: { path: a, durationMs: 2000, width: 320, height: 240, fps: 30 },
            startMs: 500,
            durationMs: 1000,
            inMs: 0,
            outMs: 1000,
            effects: [
              { type: "opacity", amount: 0.6 },
              { type: "position", x: 0.25, y: 0.25 },
            ],
          },
        ],
      },
      {
        id: "a1",
        kind: "audio",
        clips: [
          {
            id: "s1",
            media: { path: tone, durationMs: 2000 },
            startMs: 0,
            durationMs: 2000,
            inMs: 0,
            outMs: 2000,
            effects: [],
          },
          {
            id: "s2",
            media: { path: tone, durationMs: 2000 },
            startMs: 2000,
            durationMs: 1000,
            inMs: 0,
            outMs: 1000,
            effects: [{ type: "volume", amount: 0.5 }],
          },
        ],
      },
    ],
    markers: [],
    captions: [{ id: "cap1", atMs: 100, endMs: 1600, text: "Hello, editor" }],
  };

  const out = join(dir, "out.mp4");
  const fractions: number[] = [];
  const result = await renderTimeline(timeline, out, {
    ffmpegPath: FFMPEG,
    onProgress: (fraction) => fractions.push(fraction),
  });

  assert.equal(result.exitCode, 0);
  assert.ok(existsSync(out), "render output exists");
  assert.ok(statSync(out).size > 0, "render output is non-empty");
  if (fractions.length > 0) {
    // Progress is advisory; when it fires it must be monotonic and in range.
    assert.ok(fractions.every((f) => f >= 0 && f <= 1));
    assert.deepEqual([...fractions].sort((x, y) => x - y), fractions);
  }

  // The xfade consumes 500ms of overlap: 2s + 2s - 0.5s = 3.5s of video.
  if (existsSync(FFPROBE)) {
    const media = await probeMedia(out, { ffprobePath: FFPROBE });
    assert.equal(media.width, 320);
    assert.equal(media.height, 240);
    assert.ok(
      media.durationMs !== undefined && media.durationMs >= 3300 && media.durationMs <= 3700,
      `unexpected duration ${media.durationMs}`,
    );
    assert.equal(media.fps, 30);
  }
});

test("a pre-aborted signal rejects before spawning", async () => {
  if (!existsSync(FFMPEG)) return; // nothing to spawn anyway; still valid
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    renderTimeline(
      {
        id: "x", name: "x", width: 64, height: 64, fps: 10,
        tracks: [{ id: "v1", kind: "video", clips: [] }],
        markers: [], captions: [],
      },
      "/tmp/should-not-exist.mp4",
      { signal: controller.signal },
    ),
    /abort/i,
  );
});

test("aborting a running render kills ffmpeg and rejects", async (t) => {
  if (!existsSync(FFMPEG)) {
    t.skip(`ffmpeg not found at ${FFMPEG}`);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "ve-render-abort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = join(dir, "src.mp4");
  await execFileAsync(FFMPEG, [
    "-y",
    "-f", "lavfi", "-i", "testsrc2=duration=30:size=160x120:rate=30",
    "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "veryslow", src,
  ]);

  const timeline: Timeline = {
    id: "abort", name: "abort", width: 160, height: 120, fps: 30,
    tracks: [{
      id: "v1", kind: "video",
      clips: [{
        id: "c1",
        media: { path: src },
        startMs: 0, durationMs: 30000, inMs: 0, outMs: 30000,
        effects: [],
      }],
    }],
    markers: [], captions: [],
  };

  const controller = new AbortController();
  const rendering = renderTimeline(timeline, join(dir, "out.mp4"), {
    ffmpegPath: FFMPEG,
    signal: controller.signal,
  });
  // Kill immediately; a 30s encode cannot have finished in this gap.
  controller.abort();
  await assert.rejects(rendering, /aborted/);
});
