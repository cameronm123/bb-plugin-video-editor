// ffprobe runner — bb host only. This file uses node builtins, so the Claude
// Code mod must not import it (the mod runs ffprobe itself via $.process.run
// and parses the JSON with the pure parser below).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MediaRef } from "./types.ts";
import { parseFfprobeJson } from "./probe-parse.ts";

export { parseFfprobeJson } from "./probe-parse.ts";

const execFileAsync = promisify(execFile);

export interface ProbeOptions {
  ffprobePath?: string;
}

/** Run ffprobe on a media file and return a filled MediaRef. */
export async function probeMedia(
  path: string,
  options: ProbeOptions = {},
): Promise<MediaRef> {
  const { stdout } = await execFileAsync(
    options.ffprobePath ?? "ffprobe",
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  ).catch((cause: unknown) => {
    // Keep ffprobe's complaint in the message; it usually names the file issue.
    let detail: string | undefined;
    if (cause instanceof Error && "stderr" in cause) {
      detail = String(cause.stderr).trim();
    }
    throw new Error(
      `ffprobe failed for ${path}${detail !== undefined && detail !== "" ? `: ${detail}` : ""}`,
      { cause },
    );
  });
  return parseFfprobeJson(stdout, path);
}
