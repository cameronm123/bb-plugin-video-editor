Edit video from a bb thread. The agent works on a timeline plan, the plugin
compiles it into an ffmpeg render.

## What you get

- A **Video editor** page in the left sidebar showing tracks, clips laid out to
  scale, markers, captions, and the render state.
- A `video_edit` agent tool. The agent shows the timeline, applies a batch of
  named operations, and renders.
- A `bb video` command that does the same from a terminal: `bb video timeline
  show`, `bb video timeline apply --op '<json>'`, `bb video render`, and
  `bb video probe` for reading a media file's real duration.
- The same editing core as a Claude Code mod, so the same workflow works in
  either tool.

## How it works

A real Premiere project is 40 MB of XML with a 17,000-node object graph. That
is a poor interface for an agent, so this plugin keeps the plan as compact
JSON and changes it only through named operations: `add_clip`, `trim_clip`,
`move_clip`, `split_clip`, `set_effect`, `add_marker`, `add_caption`, and
about six more.

The agent reads the plan as a short text digest, applies a batch of operations
in one call, and renders. Rendering compiles the plan into one ffmpeg command
handling multi-track video, xfade transitions, opacity, scale, position, crop,
speed, burned-in captions, and mixed audio.

## For agents

The bundled skill teaches the operation set, the timing model (source in/out
points versus timeline position), and the workflow: show, probe, apply, show
again, render.

## Requirements

`ffmpeg` and `ffprobe` on `PATH`. Both paths are configurable.
