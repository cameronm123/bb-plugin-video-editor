// Tests `claude plugin test` runs. The kit's `$` is the engine's own mods
// API and the mod's hooks are live, so these fire real events end to end:
// the tool.call hook answers the registered tool, the command.run hook
// answers /video, and the store is the mocked one the kit provides.
import { expect, test } from "claude-code/testing";

// Same key register.ts persists the timeline plan under.
const STORE_KEY = "video-editor.timeline";
const TOOL = "mcp__video-editor__video_edit";

test("/video shows the digest of a fresh timeline", async ($) => {
  await $.store.delete(STORE_KEY);

  const answer = await $.command.run({ command: "video", args: "" });
  expect(answer.text).toContain('timeline "untitled" 1920x1080 @30fps 0ms');
});

test("video_edit applies operations and returns the digest", async ($) => {
  await $.store.delete(STORE_KEY);

  const applied = await $.tool.call({
    tool: TOOL,
    operations: [
      { type: "add_track", kind: "video" },
      {
        type: "add_clip",
        trackId: "track-1",
        media: { path: "/tmp/sample.mp4" },
        startMs: 0,
        durationMs: 2000,
        inMs: 0,
        outMs: 2000,
      },
    ],
  });
  expect(String(applied.result)).toContain("track-1");
  expect(String(applied.result)).toContain("clip-1 @0+2000ms");

  // The applied timeline persisted: /video shows the same clip.
  const answer = await $.command.run({ command: "video", args: "" });
  expect(answer.text).toContain("clip-1 @0+2000ms");
});

test("video_edit answers an invalid operation with an error and keeps the timeline", async ($) => {
  await $.store.delete(STORE_KEY);

  const applied = await $.tool.call({
    tool: TOOL,
    operations: [
      {
        type: "add_clip",
        trackId: "no-such-track",
        media: { path: "/tmp/x.mp4" },
        startMs: 0,
        durationMs: 100,
        inMs: 0,
        outMs: 100,
      },
    ],
  });
  expect(String(applied.result)).toContain("error:");

  // Nothing was written: the digest is still the default plan.
  const answer = await $.command.run({ command: "video", args: "" });
  expect(answer.text).toContain('timeline "untitled"');
  expect(answer.text).not.toContain("clip-1");
});
