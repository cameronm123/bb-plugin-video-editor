# bb-plugin-video-editor

A video editing environment for bb. The agent edits a timeline through named
operations, and the plugin compiles that timeline into an ffmpeg render.

The same core ships twice: as a **bb plugin** (the primary surface) and as a
**Claude Code mod**, so the editing workflow works in either tool.

## The idea

Video editors describe edits in two layers: a **plan** (what is on the
timeline) and a **render** (the pixels that come out). Adobe Premiere, DaVinci
Resolve and CapCut all keep the plan in a project file that only their own
application understands. That file is a bad interface for an agent. A real
`.prproj` from a real project is 40 MB of XML with a 17,000-node object graph.

This plugin keeps the plan as **compact JSON** and the only way to change it is
through **named operations**. That makes the plan something an agent can read
in one screen and change in one call.

The domain model came from reverse-engineering Adobe Premiere Pro 2026 with
[REA](https://github.com/morluto/rea). Premiere's shape is
`Project → Sequence → Track → TrackItem → Clip → ComponentChain → Param`, with
keyframes on the params and markers hanging off the clip. This plugin keeps
that shape, drops the object graph, and swaps Adobe ticks for integer
milliseconds.

## What you get in bb

- A **Video editor** page in the left sidebar showing the timeline: tracks,
  clips laid out to scale, markers, captions, and the render state.
- A `video_edit` **agent tool**. The agent calls it to show the timeline, apply
  a batch of operations, or render.
- A `bb video` **CLI command** for the same three things from a terminal.
- A skill (`skills/video-editing`) that teaches an agent the operation set.

The plan lives in the plugin's own storage, scoped to the thread. A shell call
outside a thread is scoped to the working directory instead, so repeated
`bb video` calls in one folder share one plan. Pass `--thread <id>` to target
a thread's plan from a shell.

## What you get in Claude Code

Load the mod and the same core answers:

```
claude --plugin-dir .
```

- `/video` prints the timeline digest.
- The `video_edit` tool applies operations and renders.

The mod keeps the plan in Claude Code's own `$.store`, so it works without bb
running.

## The core

`core/` is plain TypeScript with no host dependencies. Both hosts import it.

| File | What it does |
| --- | --- |
| `core/types.ts` | The data shape: `Timeline`, `Track`, `Clip`, `Effect`, `Marker`, `Caption` |
| `core/operations.ts` | The operation union, validation, and the pure reducer |
| `core/digest.ts` | The compact text digest an agent reads |
| `core/ffmpeg.ts` | Compiles a timeline to an ffmpeg argument list and filter graph |
| `core/probe-parse.ts` | Parses ffprobe output into a `MediaRef` |
| `core/probe.ts` | Runs ffprobe (bb only) |
| `core/render.ts` | Runs ffmpeg and reports progress (bb only) |

The reducer is pure. Rendering is a separate step that reads the finished plan.
Nothing in `core/` spawns a process except `core/render.ts` and `core/probe.ts`.

The files the Claude Code mod reaches (`types`, `operations`, `digest`,
`ffmpeg`, `probe-parse`) import nothing but each other. The mod's sandbox
refuses a bare import, not even `node:fs`, so those files stay free of them.
`core/render.ts` and `core/probe.ts` are the bb-only runners; the mod calls
ffmpeg itself with `$.process.run`.

## Operations

`add_clip`, `trim_clip`, `move_clip`, `remove_clip`, `set_effect`,
`split_clip`, `add_marker`, `remove_marker`, `add_caption`, `remove_caption`,
`set_property`, `add_track`, `remove_track`, `mute_track`.

Effects: `opacity`, `scale`, `position`, `crop`, `volume`, `fadeIn`, `fadeOut`,
`speed`.

See `skills/video-editing/SKILL.md` for the full table and the workflow.

## Requirements

- `ffmpeg` and `ffprobe` on `PATH`. The plugin's `ffmpegPath` and
  `ffprobePath` settings override them.
- Node 22 for the plugin runtime.

## Install in bb

```
npm install
bb plugin install .
```

Then reload after editing sources, or use `bb plugin dev` to rebuild and
reload on every save.

```
bb plugin reload video-editor
```

## Configure

```
bb plugin config video-editor
bb plugin config video-editor set ffmpegPath /opt/homebrew/bin/ffmpeg
bb plugin config video-editor set renderRoot /Volumes/ql-content/02_JOBS
```

## Test

```
npm test            # node --test over tests/*.spec.ts
npm run test:mod    # claude plugin test over the mod
npm run typecheck   # both tsconfigs
```

The two suites live apart on purpose. `tests/*.spec.ts` runs under `node --test`
and covers the core, including a real ffmpeg render. `hooks/*.test.ts` runs
under `claude plugin test` and drives the mod's hooks end to end. The Claude
kit refuses a `node:test` import, and `node --test` does not know the kit, so
the file naming keeps them from meeting.

The end-to-end render test skips itself when ffmpeg is absent.

## Types & API reference

The plugin API ships as `@get-bb/plugin-sdk`, pinned in `devDependencies`.
The full surface is on disk at
`node_modules/@get-bb/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts`.

```
bb plugin types          # sync this plugin's SDK surface to the running BB
bb plugin types --check  # CI: fail when it does not match
```

## License

MIT
