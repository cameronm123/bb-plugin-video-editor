---
name: video-editing
description: Use when editing video, cutting clips, adding captions or markers, adjusting audio, or rendering a video in this thread. Covers the video_edit tool and the bb video CLI.
---

# Video editing

This thread owns a **timeline plan**: a compact JSON description of a video
edit. You edit it by applying named operations, then render it with ffmpeg.

The plan is not a video file. It is the recipe the plugin compiles into an
ffmpeg command. Never write the plan by hand — apply operations to it.

## The tool

`video_edit` is the only tool you need. It takes an `action`:

- `show` — return the current timeline as a digest. **Always call this first.**
  The digest lists every clip with its id, which is what the operations need.
- `apply` — apply a list of `operations`, in order. Returns the new digest.
- `render` — render the timeline to a file. Returns the output path.

## The digest

The digest is the whole timeline, in a form you can read and reason about.
This is a real one:

```
timeline "Untitled" 1920x1080 @30fps 9000ms
track video-1 [video1 (base)]
  clip-1 @0+4000ms in=0 out=4000 src=/tmp/skilldemo2/t1.mp4 "intro"
  clip-2 @4000+5000ms in=1200 out=6200 src=/tmp/skilldemo2/t2.mp4
    effects: fadeIn=0.5
track audio-1 [audio]
  clip-3 @0+9000ms in=0 out=9000 src=/tmp/skilldemo2/t1.mp4
    effects: volume=0.8
markers:
  marker-1 @2000ms "hook"
captions:
  caption-1 @500-3000ms "First words"
```

How to read a clip line:

- `clip-1` — the id. Address it in `trim_clip`, `move_clip`, `remove_clip`,
  `set_effect`, `split_clip` and `set_transition`. Ids are unique across the
  whole timeline, so a clip on the audio track is never confused with a clip
  on the video track.
- `@0+4000ms` — where it sits on the timeline, and for how long.
- `in=0 out=4000` — the source range it takes. This is *source* time, not
  timeline time.
- `src=` — the media file.
- `[enter:xfade fade 500ms]` — a transition into this clip. Only set by
  `set_transition`.

All times in the plan are integer milliseconds.

## Operations

Each operation is an object with a `type` field. Pass them as a list to
`action: "apply"`.

| `type` | Fields | What it does |
| --- | --- | --- |
| `add_clip` | `trackId`, `media: { path }`, `startMs`, `durationMs`, `inMs`, `outMs`, `label?` | Put a clip on a track |
| `trim_clip` | `clipId`, `startMs?`, `durationMs?`, `inMs?`, `outMs?` | Change a clip's timing |
| `move_clip` | `clipId`, `startMs`, `trackId?` | Move a clip in time, or to another track |
| `remove_clip` | `clipId` | Delete a clip |
| `set_effect` | `clipId`, `effect: { type, ... }` | Add or replace one effect on a clip |
| `split_clip` | `clipId`, `atMs` | Cut a clip in two at a time point |
| `add_marker` | `atMs`, `name` | Add a marker |
| `remove_marker` | `markerId` | Remove a marker |
| `add_caption` | `atMs`, `endMs`, `text` | Add a subtitle |
| `remove_caption` | `captionId` | Remove a subtitle |
| `set_property` | `name?`, `width?`, `height?`, `fps?` | Change the sequence |
| `add_track` | `kind: "video" \| "audio"` | Add a track |
| `remove_track` | `trackId` | Remove a track and its clips |
| `mute_track` | `trackId`, `muted` | Mute or unmute an audio track |
| `set_transition` | `clipId`, `name`, `durationMs` | Cross-fade into a clip |

### Effects

`set_effect` takes one of these `type` values:

- `opacity` — `amount` 0 to 1. The clip fades toward black.
- `scale` — `amount`. 1 is native size, 0.5 is half size, 2 is double. The
  smaller picture sits centred in the frame.
- `position` — `x` and `y`, each -1 to 1. 0 is centred, 1 moves the picture
  half a frame right (or down), -1 half a frame left (or up).
- `crop` — `from` and `to`, each 0 to 1. Keeps the part of the source
  between those fractions, on both axes.
- `volume` — `amount` 0 to 1 (audio)
- `fadeIn` / `fadeOut` — `amount` as a fraction of the clip's length
- `speed` — `to` is the new rate, 1 is native (2 is double speed)

`scale` and `position` move the picture *inside* the frame. On the base
track, `position` shifts the picture and leaves black where it moved away
from, so a picture pushed off the edge is partly out of frame. To place a
picture over another one, put it on a second video track.

### Transitions

`set_transition` cross-fades into a clip. It needs:

- the clip to be on a video track,
- the clip to be exactly adjacent to the one before it, and
- a `durationMs` shorter than the clip.

`name` is an ffmpeg xfade transition: `fade`, `wipeleft`, `wiperight`,
`slideup`, `slidedown`, `circleopen`, `dissolve`, `pixelize`, and the rest
of ffmpeg's list. `fade` is the safe default.

A transition shortens the render by its own duration, because the cross-fade
overlaps the two clips. Everything after it moves that much earlier.

## Workflow

1. `show` to see the timeline and learn the clip ids.
2. Probe a file before you use it, so you know its duration:
   `bb video probe /path/to/file.mp4`.
3. `apply` the operations. Batch related changes into one call.
4. `show` again to confirm the result reads right.
5. `render` when the edit is done.

## Rules

- **Probe before you trim.** A clip's `outMs` past the end of the source
  renders black or fails. Probe gives you the real duration.
- **`inMs` and `outMs` are source time**, not timeline time. `startMs` is where
  the clip sits on the timeline. They are different numbers.
- **Clips on one track must not overlap.** Split a track into two tracks
  instead of stacking overlapping clips.
- **A `speed` effect needs enough source.** A clip that is 4000ms on the
  timeline at 2x needs 8000ms of source. The operation refuses a rate the
  source cannot fill, so shorten the clip or slow it down first.
- **One `apply` per logical edit.** A batch that fails leaves the whole batch
  unapplied.
- **Render last.** Rendering is the slow step. `render` starts the render and
  returns; the file is finished a moment later. Poll with `bb video status`
  or the `render_status` RPC.

## From a shell

The same edits are available without the tool:

```
bb video timeline show
bb video timeline apply --op '{"type":"add_marker","atMs":2000,"name":"hook"}'
bb video render --out /tmp/out.mp4
bb video status
bb video probe /path/to/file.mp4
```

`bb video timeline` and `bb video render` act on the current thread. Pass
`--thread <id>` to target another one.

With `--json`, every command returns the same envelope:
`{"timeline": {...}, "digest": "..."}` for the timeline commands.
