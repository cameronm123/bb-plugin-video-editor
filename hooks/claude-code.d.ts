// The slice of Claude Code's plugin API this mod uses.
//
// Claude Code writes full declarations for the running version into
// `.claude-plugin/types/` when it loads a mod interactively. This file is the
// hand-written subset that keeps `tsc` honest in a normal checkout, where
// that generated file does not exist yet.
//
// Only what hooks/register.ts and hooks/video.ts call is declared. Add to it
// when you use more of the API, and delete it once Claude Code generates the
// real declarations for your version.
declare module "claude-code" {
  export type HookFailure = {
    kind: "throw" | "timeout" | "re-entry";
    message: string;
    cause?: unknown;
  };

  export type CommandSpec = {
    name: string;
    description: string;
    argumentHint?: string;
    immediate?: true;
  };

  export type ToolSpec = {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
  };

  export type ProcessRunResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
  };

  export type ProcessRunInit = {
    cwd?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeoutMs?: number;
  };

  export type Store = {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<unknown>;
    delete(key: string): Promise<unknown>;
    keys(): Promise<string[]>;
  };

  export type Process = {
    run(
      argv: readonly string[],
      init?: ProcessRunInit,
    ): Promise<ProcessRunResult>;
  };

  export type Fs = {
    write(path: string, content: string): Promise<unknown>;
    read(path: string): Promise<string>;
    exists(path: string): Promise<boolean>;
  };

  export type Tool = {
    register(spec: ToolSpec): Promise<unknown>;
    list(): Promise<{ name: string }[]>;
  };

  export type Command = {
    register(spec: CommandSpec): Promise<unknown>;
    list(): Promise<{ name: string }[]>;
  };

  export type Ui = {
    invalidate(site: string): void;
    toast(message: string, options?: { timeoutMs?: number }): void;
  };

  export type EngineInterface = {
    store: Store;
    process: Process;
    fs: Fs;
    tool: Tool;
    command: Command;
    ui: Ui;
  };

  export type Next = {
    signal: AbortSignal;
    (event: unknown): Promise<unknown>;
    error?: HookFailure;
    called?: boolean;
  };

  export type EventInput = {
    input?: Record<string, unknown>;
    command?: string;
    args?: string;
  };

  export type Hook = (
    $: EngineInterface,
    event: EventInput,
    next: Next,
  ) => unknown;

  export type Registration = {
    catch(handler: Hook): void;
  };

  export type On = {
    (event: string, hook: Hook): Registration;
    (event: string, matcher: { tool?: string; command?: string }, hook: Hook): Registration;
  };

  export type Register = (on: On, options?: unknown) => unknown;
}

// The test kit `claude plugin test` runs a *.test.ts file against. Its `$` is
// the engine's own mods API, and the mod's hooks are live beneath it.
declare module "claude-code/testing" {
  import type { EngineInterface } from "claude-code";

  export type TestApi = EngineInterface & {
    command: {
      run(input: { command: string; args?: string }): Promise<{
        text: string;
      }>;
    };
    tool: {
      call(input: {
        tool: string;
        [key: string]: unknown;
      }): Promise<{ result: unknown; text?: string }>;
    };
  };

  export function test(
    name: string,
    fn: ($: TestApi) => void | Promise<void>,
  ): void;

  export function expect(actual: unknown): {
    toContain(expected: string): void;
    toBe(expected: unknown): void;
    not: { toContain(expected: string): void };
  };
}
