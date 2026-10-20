import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOperation, validateOperation } from "./operations.ts";
import type { Timeline } from "./types.ts";

function baseTimeline(): Timeline {
  return {
    id: "tl",
    name: "Test",
    width: 1280,
    height: 720,
    fps: 30,
    tracks: [
      { id: "v1", kind: "video", clips: [] },
      { id: "a1", kind: "audio", clips: [] },
    ],
    markers: [],
    captions: [],
  };
}

const media = { path: "/media/a.mp4" };

function addClip(timeline: Timeline, startMs: number, durationMs = 2000): Timeline {
  return applyOperation(
    timeline,
    validateOperation({
      type: "add_clip",
      trackId: "v1",
      media,
      startMs,
      durationMs,
      inMs: 0,
      outMs: durationMs,
    }),
  );
}

test("validateOperation accepts a valid operation", () => {
  const op = validateOperation({
    type: "add_clip",
    trackId: "v1",
    media: { path: "/x.mp4", durationMs: 1000, width: 640, height: 360, fps: 30 },
    startMs: 0,
    durationMs: 1000,
    inMs: 0,
    outMs: 1000,
    label: "intro",
  });
  assert.equal(op.type, "add_clip");
  assert.deepEqual(op.media, {
    path: "/x.mp4",
    durationMs: 1000,
    width: 640,
    height: 360,
    fps: 30,
  });
});

test("validateOperation rejects invalid input", () => {
  assert.throws(() => validateOperation(null), /expected an object/);
  assert.throws(() => validateOperation({ type: "explode" }), /unknown type/);
  assert.throws(() => validateOperation({ type: "add_clip" }), /missing field/);
  assert.throws(
    () => validateOperation({ type: "add_clip", trackId: "v1", media, startMs: 1.5, durationMs: 1000, inMs: 0, outMs: 1000 }),
    /integer/,
  );
  assert.throws(
    () => validateOperation({ type: "add_clip", trackId: "v1", media, startMs: -1, durationMs: 1000, inMs: 0, outMs: 1000 }),
    /integer/,
  );
  assert.throws(
    () => validateOperation({ type: "set_effect", clipId: "c", effect: { type: "blur", amount: 1 } }),
    /effect\.type/,
  );
  assert.throws(
    () => validateOperation({ type: "mute_track", trackId: "v1", muted: "yes" }),
    /boolean/,
  );
  assert.throws(
    () => validateOperation({ type: "add_track", kind: "smell" }),
    /kind/,
  );
});

test("add_clip appends, sorts by start, generates ids", () => {
  let tl = baseTimeline();
  tl = addClip(tl, 2000);
  tl = addClip(tl, 0);
  assert.deepEqual(
    tl.tracks[0].clips.map((c) => [c.id, c.startMs]),
    [["clip-2", 0], ["clip-1", 2000]],
  );
});

test("add_clip throws on unknown track and on overlap", () => {
  let tl = baseTimeline();
  tl = addClip(tl, 0, 1000);
  assert.throws(() => applyOperation(tl, validateOperation({
    type: "add_clip", trackId: "nope", media, startMs: 0, durationMs: 500, inMs: 0, outMs: 500,
  })), /no track/);
  assert.throws(() => addClip(tl, 500, 1000), /overlap/);
  // Butting up exactly is fine.
  addClip(tl, 1000, 1000);
});

test("trim_clip changes duration and throws on bad ranges", () => {
  let tl = baseTimeline();
  tl = addClip(tl, 0, 2000);
  tl = applyOperation(tl, validateOperation({
    type: "trim_clip", clipId: "clip-1", durationMs: 1000, outMs: 1000,
  }));
  assert.equal(tl.tracks[0].clips[0].durationMs, 1000);
  assert.throws(() => applyOperation(tl, validateOperation({
    type: "trim_clip", clipId: "clip-1", inMs: 1000, outMs: 1000,
  })), /outMs must be greater/);
  assert.throws(() => applyOperation(tl, validateOperation({
    type: "trim_clip", clipId: "ghost", durationMs: 500,
  })), /no clip/);
});

test("trim_clip that overlaps the neighbour throws", () => {
  let tl = baseTimeline();
  tl = addClip(tl, 0, 1000);
  tl = addClip(tl, 1000, 1000);
  assert.throws(() => applyOperation(tl, validateOperation({
    type: "trim_clip", clipId: "clip-1", durationMs: 2000,
  })), /overlap/);
});

test("move_clip repositions and can change track", () => {
  let tl = baseTimeline();
  tl = addClip(tl, 0, 1000);
  tl = addClip(tl, 1000, 1000);
  tl = applyOperation(tl, validateOperation({
    type: "move_clip", clipId: "clip-1", startMs: 2000,
  }));
  assert.deepEqual(
    tl.tracks[0].clips.map((c) => [c.id, c.startMs]),
    [["clip-2", 1000], ["clip-1", 2000]],
  );
  tl = applyOperation(tl, validateOperation({
    type: "move_clip", clipId: "clip-1", startMs: 0, trackId: "a1",
  }));
  assert.equal(tl.tracks[0].clips.length, 1);
  assert.equal(tl.tracks[1].clips[0].id, "clip-1");
  assert.throws(() => applyOperation(tl, validateOperation({
    type: "move_clip", clipId: "clip-1", startMs: 1000, trackId: "v1",
  })), /overlap/);
});

test("remove_clip removes only that clip", () => {
  let tl = baseTimeline();
  tl = addClip(tl, 0);
  tl = addClip(tl, 2000);
  tl = applyOperation(tl, validateOperation({ type: "remove_clip", clipId: "clip-1" }));
  assert.deepEqual(tl.tracks[0].clips.map((c) => c.id), ["clip-2"]);
  assert.throws(() => applyOperation(tl, validateOperation({ type: "remove_clip", clipId: "clip-1" })), /no clip/);
});

test("set_effect adds then replaces by type", () => {
  let tl = baseTimeline();
  tl = addClip(tl, 0);
  tl = applyOperation(tl, validateOperation({
    type: "set_effect", clipId: "clip-1", effect: { type: "opacity", amount: 0.5 },
  }));
  tl = applyOperation(tl, validateOperation({
    type: "set_effect", clipId: "clip-1", effect: { type: "opacity", amount: 0.9 },
  }));
  tl = applyOperation(tl, validateOperation({
    type: "set_effect", clipId: "clip-1", effect: { type: "volume", amount: 1.2 },
  }));
  assert.deepEqual(tl.tracks[0].clips[0].effects, [
    { type: "opacity", amount: 0.9, x: undefined, y: undefined, from: undefined, to: undefined },
    { type: "volume", amount: 1.2, x: undefined, y: undefined, from: undefined, to: undefined },
  ]);
});

test("split_clip cuts proportionally in timeline and source time", () => {
  let tl = baseTimeline();
  tl = addClip(tl, 1000, 2000); // in 0..2000
  tl = applyOperation(tl, validateOperation({ type: "split_clip", clipId: "clip-1", atMs: 2000 }));
  const [left, right] = tl.tracks[0].clips;
  assert.deepEqual(
    [left.startMs, left.durationMs, left.inMs, left.outMs],
    [1000, 1000, 0, 1000],
  );
  assert.deepEqual(
    [right.startMs, right.durationMs, right.inMs, right.outMs],
    [2000, 1000, 1000, 2000],
  );
  assert.notEqual(left.id, right.id);
  assert.throws(() => applyOperation(tl, validateOperation({
    type: "split_clip", clipId: right.id, atMs: 1000,
  })), /not inside/);
});

test("markers and captions add and remove with generated ids", () => {
  let tl = baseTimeline();
  tl = applyOperation(tl, validateOperation({ type: "add_marker", atMs: 5000, name: "Chapter 1" }));
  tl = applyOperation(tl, validateOperation({ type: "add_marker", atMs: 100, name: "Start" }));
  assert.deepEqual(tl.markers.map((m) => [m.id, m.atMs]), [["marker-2", 100], ["marker-1", 5000]]);
  tl = applyOperation(tl, validateOperation({ type: "remove_marker", markerId: "marker-1" }));
  assert.equal(tl.markers.length, 1);
  assert.throws(() => applyOperation(tl, validateOperation({ type: "remove_marker", markerId: "marker-1" })), /no marker/);

  tl = applyOperation(tl, validateOperation({ type: "add_caption", atMs: 0, endMs: 1000, text: "hello" }));
  assert.equal(tl.captions[0].id, "caption-1");
  assert.throws(() => applyOperation(tl, validateOperation({
    type: "add_caption", atMs: 1000, endMs: 1000, text: "bad",
  })), /endMs must be greater/);
  tl = applyOperation(tl, validateOperation({ type: "remove_caption", captionId: "caption-1" }));
  assert.equal(tl.captions.length, 0);
});

test("set_property, add_track, remove_track, mute_track", () => {
  let tl = baseTimeline();
  tl = applyOperation(tl, validateOperation({
    type: "set_property", name: "Final", width: 1920, height: 1080, fps: 24,
  }));
  assert.deepEqual([tl.name, tl.width, tl.height, tl.fps], ["Final", 1920, 1080, 24]);

  tl = applyOperation(tl, validateOperation({ type: "add_track", kind: "video" }));
  const added = tl.tracks[tl.tracks.length - 1];
  assert.deepEqual([added.id, added.kind, added.clips.length], ["track-1", "video", 0]);

  tl = applyOperation(tl, validateOperation({ type: "mute_track", trackId: "a1", muted: true }));
  const a1 = tl.tracks.find((t) => t.id === "a1");
  assert.ok(a1 !== undefined);
  assert.equal(a1.muted, true);

  tl = applyOperation(tl, validateOperation({ type: "remove_track", trackId: "track-1" }));
  assert.equal(tl.tracks.find((t) => t.id === "track-1"), undefined);
  assert.throws(() => applyOperation(tl, validateOperation({ type: "remove_track", trackId: "ghost" })), /no track/);
});

test("reducer is pure: the input timeline is never mutated", () => {
  const tl = addClip(baseTimeline(), 0);
  const before = structuredClone(tl);
  const ops: unknown[] = [
    { type: "add_clip", trackId: "v1", media, startMs: 2000, durationMs: 1000, inMs: 0, outMs: 1000 },
    { type: "set_effect", clipId: "clip-1", effect: { type: "fadeIn", amount: 0.25 } },
    { type: "split_clip", clipId: "clip-1", atMs: 500 },
    { type: "add_marker", atMs: 10, name: "m" },
    { type: "add_caption", atMs: 0, endMs: 100, text: "t" },
    { type: "set_property", name: "X" },
    { type: "mute_track", trackId: "a1", muted: true },
  ];
  let current = tl;
  for (const raw of ops) {
    current = applyOperation(current, validateOperation(raw));
  }
  assert.deepEqual(tl, before);
  assert.notEqual(current, tl);
  assert.equal(current.tracks[0].clips.length, 3);
});

test("operations apply in sequence as an undoable log", () => {
  let tl = baseTimeline();
  const log = [
    validateOperation({ type: "add_clip", trackId: "v1", media, startMs: 0, durationMs: 3000, inMs: 0, outMs: 3000 }),
    validateOperation({ type: "set_effect", clipId: "clip-1", effect: { type: "fadeOut", amount: 0.1 } }),
    validateOperation({ type: "trim_clip", clipId: "clip-1", durationMs: 2000, outMs: 2000 }),
  ];
  for (const op of log) tl = applyOperation(tl, op);
  assert.equal(tl.tracks[0].clips[0].durationMs, 2000);
  assert.equal(tl.tracks[0].clips[0].effects[0].type, "fadeOut");
});
