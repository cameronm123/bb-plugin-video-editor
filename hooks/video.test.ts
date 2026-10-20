// Tests `claude plugin test` runs. The kit's `$` fires events the way Claude
// Code would (each method fires the event of the same name); `on` registers
// stubs that answer in Claude Code's place. The mod's hooks are live, so
// these run the real register.ts against the real core.
import {
  expect,
  mock,
  test,
  type SessionKit,
  type StubFn,
} from "claude-code/testing";

const TOOL = "mcp__video-editor__video_edit";

// session.start registers the /video command and the video_edit tool; firing
// it needs stubs for the two $.register calls the hook makes. Every stub is
// registered before the test's first call on `$`, as the kit requires.
async function startSession($: SessionKit, on: StubFn): Promise<void> {
  mock.store(on);
  on("command.register", () => ({ value: undefined }));
  on("tool.register", () => ({ value: undefined }));
  // The store key carries the session's project root, so the mod keeps one
  // timeline per project rather than one per machine.
  on("session.root", () => ({ value: "/work" }));
  on("session.start", () => ({ cwd: "/work" }));
  await $.session.start({ surface: "terminal", isInteractive: true, cwd: "/work" });
}

test("/video shows the digest of a fresh timeline", async ($, on) => {
  await startSession($, on);

  const answer = await $.command.run({ command: "video", args: "" });
  expect(answer.text).toContain('timeline "untitled" 1920x1080 @30fps 0ms');
});

test("video_edit applies operations and returns the digest", async ($, on) => {
  await startSession($, on);

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

test("video_edit answers an invalid operation with an error and keeps the timeline", async ($, on) => {
  await startSession($, on);

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
