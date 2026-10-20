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

/** mm:ss:ff — the unit editors actually read a timeline in. */
function timecode(ms: number, fps: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const frames = Math.floor(((ms % 1000) / 1000) * fps);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(frames).padStart(2, "0")}`;
}

function useTimeline(scope: string | null) {
  const rpc = useRpc<typeof rpcContract>();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const refetch = useCallback(() => {
    if (scope === null) return;
    rpc
      .call("timeline_get", { scope })
      .then((result) => {
        setPlan(result.timeline as unknown as Plan);
        setError(null);
      }, report);
  }, [rpc, report, scope]);
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
  fps,
}: {
  track: Track;
  totalMs: number;
  fps: number;
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
            title={`${clip.label ?? clip.media.path}\n${timecode(clip.startMs, fps)} → ${timecode(clip.startMs + clip.durationMs, fps)}`}
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

/**
 * The timeline panel. It shows one plan, identified by its scope.
 *
 * A bb plugin page is not inside a thread, so `useBbContext` gives no
 * thread and no project there. The nav panel therefore shows the plugin's
 * project-less plan, and a thread panel shows that thread's plan.
 */
function TimelinePanel({ scope, heading }: { scope: string; heading: string }) {
  const { rpc, plan, error, report, refetch } = useTimeline(scope);
  const [renderState, setRenderState] = useState<string>("idle");

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const status = await rpc.call("render_status", { scope });
        if (cancelled) return;
        setRenderState(status.state);
        // Keep polling only while a render is in flight, so the badge does
        // not refresh forever after it has settled.
        if (status.state === "rendering") {
          timer = setTimeout(poll, 1500);
        }
      } catch {
        // The status endpoint is best-effort; a failed poll is not worth
        // surfacing next to the real error channel.
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [rpc, scope, plan]);

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
                {plan.width}×{plan.height} @ {plan.fps}fps · {timecode(totalMs, plan.fps)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{heading}</p>
            {error === null ? null : (
              <p role="alert" className="mt-3 text-sm text-destructive">
                {error}
              </p>
            )}
            <div className="mt-4 space-y-2">
              {plan.tracks.map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  totalMs={totalMs}
                  fps={plan.fps}
                />
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
                        {timecode(marker.atMs, plan.fps)}
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
                        {timecode(caption.atMs, plan.fps)}
                      </span>
                      <span className="truncate">{caption.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="mt-5 flex items-center gap-2">
              <Button
                onClick={() => {
                  rpc
                    .call("timeline_render", { scope })
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
    icon: "Layers",
    // Routed at /plugins/video-editor/video-editor; the component receives the
    // remainder as `subPath` for deep links within the page.
    path: "video-editor",
    // A plugin page is not inside a thread or a project, so this shows the
    // plugin's own plan. A thread's plan is in the thread panel below.
    component: () => (
      <TimelinePanel
        scope="default"
        heading="The plugin's own plan. A thread's plan is in that thread's Video editor tab."
      />
    ),
  });

  // The thread's own plan, beside the conversation the agent is editing it
  // in. This is where the agent and the person look at the same timeline.
  app.slots.threadPanelAction({
    id: "video-editor",
    title: "Video editor",
    component: ({ threadId }: { threadId: string }) => (
      <TimelinePanel
        scope={`thread:${threadId}`}
        heading="This thread's plan."
      />
    ),
    run: async ({ openPanel }) => {
      openPanel({ title: "Video editor" });
    },
  });
});
