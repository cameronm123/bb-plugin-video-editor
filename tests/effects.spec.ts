// Semantic tests for the effects: render a frame and measure it, rather than
// assert on the filter text. A filter can be present and still do nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { compileFfmpeg } from "../core/ffmpeg.ts";
import type { Clip, Effect, Timeline, Track } from "../core/types.ts";

const execFileAsync = promisify(execFile);

function hasFfmpeg(): Promise<boolean> {
  return execFileAsync("ffmpeg", ["-version"])
    .then(() => true)
    .catch(() => false);
}

/** Mean luma of one frame, in 0..255. */
async function meanLuma(path: string, atSeconds: number): Promise<number> {
  const { stdout } = await execFileAsync("ffmpeg", [
    "-v",
    "error",
    "-ss",
    String(atSeconds),
    "-i",
    path,
    "-frames:v",
    "1",
    "-vf",
    "format=gray",
    "-f",
    "rawvideo",
    "-",
  ], { encoding: "buffer", maxBuffer: 1 << 28 });
  let sum = 0;
  for (const byte of stdout) sum += byte;
  return sum / stdout.length;
}

function planWith(effects: Effect[], mediaPath: string): Timeline {
  const clip: Clip = {
    id: "c1",
    media: { path: mediaPath },
    startMs: 0,
    durationMs: 2000,
    inMs: 0,
    outMs: 2000,
    effects,
  };
  const track: Track = { id: "v1", kind: "video", clips: [clip] };
  return {
    id: "t",
    name: "T",
    width: 320,
    height: 240,
    fps: 30,
    tracks: [track],
    markers: [],
    captions: [],
  };
}

test("effects change the rendered picture, not just the filter text", async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg is not installed");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "ve-effects-"));
  const source = join(dir, "source.mp4");
  try {
    // A bright, uniform source makes a measurement unambiguous: the picture
    // starts white, and anything the effects do shows up as a luma change.
    await execFileAsync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=white:s=320x240:d=2:r=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", source,
    ]);

    const render = async (effects: Effect[], name: string): Promise<number> => {
      const out = join(dir, `${name}.mp4`);
      const { args } = compileFfmpeg(planWith(effects, source), {
        outputPath: out,
      });
      await execFileAsync("ffmpeg", args);
      assert.ok(existsSync(out), `${name} did not render`);
      return meanLuma(out, 1);
    };

    const plain = await render([], "plain");
    assert.ok(plain > 200, `expected a bright source, got ${plain}`);

    // Opacity on the base track blends the clip over black.
    const dimmed = await render([{ type: "opacity", amount: 0.3 }], "dim");
    assert.ok(
      dimmed < plain * 0.6,
      `opacity 0.3 should darken the picture: plain=${plain} dim=${dimmed}`,
    );

    // Scale shrinks the picture, so less of the frame is covered.
    const scaled = await render([{ type: "scale", amount: 0.5 }], "scaled");
    assert.ok(
      scaled < plain * 0.8,
      `scale 0.5 should shrink the picture: plain=${plain} scaled=${scaled}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("position shifts the picture inside the frame", async (t) => {
  if (!(await hasFfmpeg())) {
    t.skip("ffmpeg is not installed");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "ve-position-"));
  const source = join(dir, "red.mp4");
  try {
    await execFileAsync("ffmpeg", [
      "-v", "error",
      "-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", source,
    ]);

    // The first red column of a frame, at the vertical middle.
    const firstRedColumn = async (effects: Effect[]): Promise<number> => {
      const out = join(dir, "pos.mp4");
      const { args } = compileFfmpeg(planWith(effects, source), {
        outputPath: out,
      });
      await execFileAsync("ffmpeg", args);
      const { stdout } = await execFileAsync("ffmpeg", [
        "-v", "error", "-ss", "1", "-i", out, "-frames:v", "1",
        "-vf", "format=rgb24", "-f", "rawvideo", "-",
      ], { encoding: "buffer", maxBuffer: 1 << 28 });
      const width = 320;
      for (let x = 0; x < width; x += 1) {
        const i = (120 * width + x) * 3;
        if (stdout[i] > 150) return x;
      }
      return -1;
    };

    const centred = await firstRedColumn([]);
    assert.equal(centred, 0, "an unpositioned picture starts at the left edge");

    // x moves the picture by x * width/2 pixels.
    const shifted = await firstRedColumn([{ type: "position", x: 0.5, y: 0 }]);
    assert.equal(shifted, 80, `x 0.5 should shift by 80px, got ${shifted}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
