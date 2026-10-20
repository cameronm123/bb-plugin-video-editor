import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAssSubtitles, compileFfmpeg } from "../core/ffmpeg.ts";
import type { Clip, Timeline } from "../core/types.ts";

function clip(id: string, startMs: number, opts: Partial<Clip> = {}): Clip {
  return {
    id,
    media: { path: `/${id}.mp4` },
    startMs,
    durationMs: 2000,
    inMs: 0,
    outMs: 2000,
    effects: [],
    ...opts,
  };
}

function timeline(tracks: Timeline["tracks"], captions: Timeline["captions"] = []): Timeline {
  return {
    id: "tl",
    name: "Test",
    width: 640,
    height: 360,
    fps: 30,
    tracks,
    markers: [],
    captions,
  };
}

test("one base clip compiles to an exact argument list", () => {
  const tl = timeline([
    { id: "v1", kind: "video", clips: [clip("c1", 0)] },
  ]);
  const { args, filterGraph } = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  assert.deepEqual(args, [
    "-i",
    "/c1.mp4",
    "-filter_complex",
    "[0:v]trim=start=0:end=2,setpts=PTS-STARTPTS,scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p[b0]",
    "-map",
    "[b0]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    "/out.mp4",
  ]);
  assert.ok(filterGraph.length > 0);
});

test("adjacent clips with a transition join via xfade at the cumulative offset", () => {
  const tl = timeline([
    {
      id: "v1",
      kind: "video",
      clips: [
        clip("c1", 0),
        clip("c2", 2000, { transition: { name: "fade", durationMs: 500 } }),
      ],
    },
  ]);
  const { filterGraph } = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  assert.ok(
    filterGraph.includes(
      "xfade=transition=fade:duration=0.5:offset=1.5",
    ),
    filterGraph,
  );
  assert.ok(filterGraph.includes("concat=n=2:v=1:a=0") === false);
});

test("a second transition shifts the following offset by the consumed overlap", () => {
  const tl = timeline([
    {
      id: "v1",
      kind: "video",
      clips: [
        clip("c1", 0),
        clip("c2", 2000, { transition: { name: "fade", durationMs: 500 } }),
        clip("c3", 4000, { transition: { name: "wipeleft", durationMs: 500 } }),
      ],
    },
  ]);
  const { filterGraph } = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  // Second xfade: cut at 4000, minus its own 500 overlap minus the 500ms
  // already consumed by the first transition.
  assert.ok(
    filterGraph.includes("xfade=transition=wipeleft:duration=0.5:offset=3"),
    filterGraph,
  );
});

test("a gap between base clips renders as black tpad then concat", () => {
  const tl = timeline([
    {
      id: "v1",
      kind: "video",
      clips: [clip("c1", 0, { durationMs: 1000, outMs: 1000 }), clip("c2", 2000)],
    },
  ]);
  const { filterGraph } = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  assert.ok(filterGraph.includes("tpad=start_duration=1:start_mode=add:color=black"), filterGraph);
  assert.ok(filterGraph.includes("concat=n=2:v=1:a=0"), filterGraph);
});

test("overlay track clips stack with transparent padding and overlay", () => {
  const tl = timeline([
    { id: "v1", kind: "video", clips: [clip("c1", 0)] },
    {
      id: "v2",
      kind: "video",
      clips: [
        clip("c2", 1000, {
          durationMs: 1000,
          outMs: 1000,
          effects: [
            { type: "opacity", amount: 0.5 },
            { type: "position", x: 0.5, y: -1 },
          ],
        }),
      ],
    },
  ]);
  const { filterGraph } = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  assert.ok(
    filterGraph.includes("tpad=start_duration=1:start_mode=add:color=black@0.0"),
    filterGraph,
  );
  assert.ok(
    filterGraph.includes("colorchannelmixer=aa=0.5"),
    filterGraph,
  );
  assert.ok(
    filterGraph.includes(
      "overlay=x='(main_w-overlay_w)/2+0.5*main_w/2':y='(main_h-overlay_h)/2+-1*main_h/2':eof_action=pass:format=auto",
    ),
    filterGraph,
  );
});

test("overlays with no base clips composite onto a black canvas", () => {
  const tl = timeline([
    { id: "v1", kind: "video", clips: [] },
    { id: "v2", kind: "video", clips: [clip("c1", 0)] },
  ]);
  const { args, filterGraph } = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  assert.ok(args.includes("color=c=black:s=640x360:r=30:d=2"), args.join(" "));
  assert.ok(filterGraph.includes("format=yuv420p[base]"), filterGraph);
});

test("per-clip effects compile to their filter chains", () => {
  const tl = timeline([
    {
      id: "v1",
      kind: "video",
      clips: [
        clip("c1", 0, {
          effects: [
            { type: "speed", to: 2 },
            { type: "crop", from: 0.1, to: 0.9 },
            { type: "opacity", amount: 0.75 },
            { type: "fadeIn", amount: 0.25 },
            { type: "fadeOut", amount: 0.5 },
          ],
        }),
      ],
    },
  ]);
  const { filterGraph } = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  assert.ok(filterGraph.includes("setpts=PTS/2"), filterGraph);
  assert.ok(filterGraph.includes("crop=w=iw*0.8:h=ih*0.8:x=iw*0.1:y=ih*0.1"), filterGraph);
  assert.ok(filterGraph.includes("colorchannelmixer=aa=0.75"), filterGraph);
  assert.ok(filterGraph.includes("fade=t=in:st=0:d=0.5"), filterGraph);
  assert.ok(filterGraph.includes("fade=t=out:st=1:d=1"), filterGraph);
});

test("audio tracks mix with adelay placement and amix", () => {
  const tl = timeline([
    { id: "v1", kind: "video", clips: [clip("c1", 0)] },
    {
      id: "a1",
      kind: "audio",
      clips: [
        clip("s1", 0, {
          media: { path: "/s1.wav" },
          durationMs: 1000,
          outMs: 1000,
          effects: [{ type: "volume", amount: 0.8 }],
        }),
        clip("s2", 2000, { media: { path: "/s2.wav" } }),
      ],
    },
  ]);
  const { args, filterGraph } = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  assert.ok(filterGraph.includes("volume=0.8"), filterGraph);
  assert.ok(filterGraph.includes("adelay=0:all=1"), filterGraph);
  assert.ok(filterGraph.includes("adelay=2000:all=1"), filterGraph);
  assert.ok(
    filterGraph.includes("amix=inputs=2:duration=longest:normalize=0"),
    filterGraph,
  );
  assert.deepEqual(args.slice(-6), ["-map", "[amix]", "-c:a", "aac", "-y", "/out.mp4"]);
});

test("muted audio tracks render silent (no chains)", () => {
  const tl = timeline([
    { id: "v1", kind: "video", clips: [clip("c1", 0)] },
    { id: "a1", kind: "audio", muted: true, clips: [clip("s1", 0, { media: { path: "/s1.wav" } })] },
  ]);
  const { args, filterGraph } = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  assert.ok(!filterGraph.includes("adelay"));
  assert.ok(!args.includes("-c:a"));
});

test("captions burn in via a caller-written subtitle file", () => {
  const tl = timeline(
    [{ id: "v1", kind: "video", clips: [clip("c1", 0)] }],
    [{ id: "cap1", atMs: 1000, endMs: 2500, text: "Hello" }],
  );
  const { args, filterGraph, captionContent } = compileFfmpeg(tl, {
    outputPath: "/out.mp4",
    captionFile: "/tmp/captions.ass",
  });
  assert.ok(filterGraph.includes("subtitles=filename='/tmp/captions.ass'"), filterGraph);
  assert.ok(captionContent !== undefined);
  assert.ok(captionContent.includes("Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,Hello"), captionContent);
  assert.ok(args.includes("-map"));
  // No caption path: the compiler demands one rather than silently dropping.
  assert.throws(
    () => compileFfmpeg(tl, { outputPath: "/out.mp4" }),
    /captionFile/,
  );
});

test("caption times shift with base-track transitions", () => {
  const tl = timeline(
    [
      {
        id: "v1",
        kind: "video",
        clips: [
          clip("c1", 0),
          clip("c2", 2000, { transition: { name: "fade", durationMs: 500 } }),
        ],
      },
    ],
    [{ id: "cap1", atMs: 2500, endMs: 4000, text: "after" }],
  );
  const ass = buildAssSubtitles(tl);
  // 2500ms plan time is 500ms after a 500ms-consuming transition.
  assert.ok(ass.includes("Dialogue: 0,0:00:02.00,0:00:03.50"), ass);
});

test("audio-only timelines map no video stream", () => {
  const tl = timeline([
    { id: "a1", kind: "audio", clips: [clip("s1", 0, { media: { path: "/s1.wav" } })] },
  ]);
  const { args } = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  assert.ok(!args.includes("libx264"));
  assert.ok(args.includes("-c:a"));
});

test("an empty timeline is rejected", () => {
  assert.throws(() => compileFfmpeg(timeline([{ id: "v1", kind: "video", clips: [] }]), { outputPath: "/o.mp4" }), /no clips/);
});

test("compileFfmpeg is pure: identical input, identical output, no mutation", () => {
  const tl = timeline([
    {
      id: "v1",
      kind: "video",
      clips: [
        clip("c1", 0),
        clip("c2", 2000, { transition: { name: "fade", durationMs: 500 } }),
      ],
    },
    { id: "a1", kind: "audio", clips: [clip("s1", 0, { media: { path: "/s.wav" } })] },
  ]);
  const before = structuredClone(tl);
  const first = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  const second = compileFfmpeg(tl, { outputPath: "/out.mp4" });
  assert.deepEqual(first, second);
  assert.deepEqual(tl, before);
});
