// bb-plugin-video-editor — a BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never bundled),
// so this file must be loaded by BB, not imported directly.
//
// The components under components/ui/ are YOURS: vendored source (shadcn
// model), edit freely. Add more from the BB registry with
// `npx shadcn add @bb/<name>` (see components.json) — dropdowns, tables,
// the full shadcn set, version-matched to this BB install. Run
// `npm install` once before `bb plugin build`.
import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { definePluginApp, useBbContext, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

interface Clip {
  id: string;
  media: { path: string; durationMs?: number };
  startMs: number;
  durationMs: number;
  inMs: number;
  outMs: number;
  label?: string;
  effects: { type: string }[];
}
interface Track {
  id: string;
  kind: "video" | "audio";
  muted?: boolean;
  clips: Clip[];
}
interface Plan {
  id: string;
  name: string;
  width: number;
  height: number;
  fps: number;
  tracks: Track[];
  markers: { id: string; atMs: number; name: string }[];
  captions: { id: string; atMs: number; endMs: number; text: string }[];
}

/** mm:ss.cs — the unit editors actually read a timeline in. */
function timecode(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frames = Math.floor(((ms % 1000) / 1000) * 30);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(frames).padStart(2, "0")}`;
}

function useTimeline(threadId: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    if (threadId === null) return;
    rpc
      .call("timeline_get", { threadId })
      .then((result) => {
        setPlan(result.timeline as unknown as Plan);
        setError(null);
      }, report);
  }, [rpc, report, threadId]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime("timeline-changed", refetch);
  return { rpc, plan, error, report, refetch };
}

/** The dashed box BB's own list pages use for loading and empty states. */
function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground"
    >
      {children}
    </div>
  );
}

function TrackRow({
  track,
  totalMs,
}: {
  track: Track;
  totalMs: number;
}) {
  const span = Math.max(totalMs, 1);
  return (
    <div className="flex items-stretch gap-2">
      <div className="w-16 shrink-0 pt-1 text-xs text-muted-foreground">
        {track.kind === "video" ? "V" : "A"}
        {track.muted ? " · mute" : ""}
      </div>
      <div className="relative h-9 min-w-0 flex-1 overflow-hidden rounded bg-muted">
        {track.clips.length === 0 ? (
          <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            empty
          </span>
        ) : null}
        {track.clips.map((clip) => (
          <div
            key={clip.id}
            title={`${clip.label ?? clip.media.path}\n${timecode(clip.startMs)} → ${timecode(clip.startMs + clip.durationMs)}`}
            className="absolute top-1 bottom-1 overflow-hidden rounded border border-border bg-card px-1.5 text-[11px] leading-4"
            style={{
              left: `${(clip.startMs / span) * 100}%`,
              width: `${Math.max((clip.durationMs / span) * 100, 1)}%`,
            }}
          >
            <span className="block truncate">
              {clip.label ?? clip.media.path.split("/").pop()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function VideoEditorPage() {
  const { threadId } = useBbContext();
  const { rpc, plan, error, report, refetch } = useTimeline(threadId);
  const [renderState, setRenderState] = useState<string>("idle");

  useEffect(() => {
    if (threadId === null) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await rpc.call("render_status", { threadId });
        if (cancelled) return;
        setRenderState(status.state);
        if (status.state === "rendering") setTimeout(poll, 1500);
      } catch {
        // The status endpoint is best-effort; a failed poll is not worth
        // surfacing next to the real error channel.
      }
    };
    void poll();
    return () => {
      cancelled = true;
    };
  }, [rpc, threadId, plan]);

  const totalMs =
    plan?.tracks.reduce(
      (max, track) =>
        Math.max(
          max,
          ...track.clips.map((clip) => clip.startMs + clip.durationMs),
        ),
      0,
    ) ?? 0;

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-4 pt-3 md:px-5 md:pt-4">
        {plan === null ? (
          <EmptyState>Loading timeline…</EmptyState>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <h1 className="truncate text-lg font-semibold">{plan.name}</h1>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {plan.width}×{plan.height} @ {plan.fps}fps · {timecode(totalMs)}
              </span>
            </div>
            {error === null ? null : (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="mt-4 space-y-2">
              {plan.tracks.map((track) => (
                <TrackRow key={track.id} track={track} totalMs={totalMs} />
              ))}
            </div>
            {plan.markers.length > 0 ? (
              <div className="mt-5">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Markers
                </h2>
                <ul className="mt-1.5 space-y-0.5 text-sm">
                  {plan.markers.map((marker) => (
                    <li key={marker.id} className="flex gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {timecode(marker.atMs)}
                      </span>
                      <span className="truncate">{marker.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {plan.captions.length > 0 ? (
              <div className="mt-5">
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Captions
                </h2>
                <ul className="mt-1.5 space-y-0.5 text-sm">
                  {plan.captions.map((caption) => (
                    <li key={caption.id} className="flex gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {timecode(caption.atMs)}
                      </span>
                      <span className="truncate">{caption.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="mt-5 flex items-center gap-2">
              <Button
                disabled={threadId === null}
                onClick={() => {
                  if (threadId === null) return;
                  rpc
                    .call("timeline_render", { threadId })
                    .then(refetch, report);
                }}
              >
                <Icon name="Play" className="size-4" />
                Render
              </Button>
              {renderState === "rendering" ? (
                <span className="text-sm text-muted-foreground">Rendering…</span>
              ) : null}
              {renderState === "done" ? (
                <span className="text-sm text-muted-foreground">Rendered</span>
              ) : null}
              {renderState === "failed" ? (
                <span className="text-sm text-destructive">Render failed</span>
              ) : null}
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Agents edit this timeline with the <code>video_edit</code> tool.
              The skill in <code>skills/video-editing</code> tells them how.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// The default export must be definePluginApp(...); BB interprets it after
// loading the bundle. navPanel adds a page to the left sidebar; register
// other UI under app.slots and composer actions, plus-menu rows, banners, or
// rich-text rules with app.composer.customize(...) (see the bb guide's
// plugins chapter).
export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "video-editor",
    title: "Video editor",
    icon: "Clapperboard",
    // Routed at /plugins/video-editor/video-editor; the component receives the
    // remainder as `subPath` for deep links within the page.
    path: "video-editor",
    component: VideoEditorPage,
  });
});
