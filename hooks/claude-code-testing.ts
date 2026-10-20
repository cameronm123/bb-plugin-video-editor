// A type-only stub for `claude-code/testing`, the kit `claude plugin test`
// provides at run time; tsc resolves the import through the "paths" mapping
// in tsconfig.mod.json and tsconfig.json. Only the members the mod's tests
// use are declared. This file is never imported at run time.
//
// In the kit, `$` is the test's own: each method fires the event of the same
// name (it is not the mods API a hook receives). `on` registers stubs that
// answer in Claude Code's place; a stub for a mods API call returns
// `{ value }`.
//
// shortcut: if the real kit's signatures drift from these, tsc will not
// catch it; recheck against mods/types/claude-code.d.ts when updating tests.

export interface SessionKit {
  session: {
    start(input: Record<string, unknown>): Promise<unknown>;
  };
  tool: {
    call(input: Record<string, unknown>): Promise<{
      result?: unknown;
      text?: string;
      deny?: string;
    }>;
  };
  command: {
    run(input: { command: string; args?: string }): Promise<{ text?: string }>;
  };
}

/** Registers a stub: `name` is the event or mods API call it answers. */
export type StubFn = (
  name: string,
  hook: (...args: any[]) => unknown,
) => void;

export interface Expectation {
  readonly not: Expectation;
  toBe(expected: unknown): void;
  toContain(expected: string): void;
  toBeDefined(): void;
}

/** Ready-made answers for `$.store`, from an in-memory store. */
export const mock: {
  store(on: StubFn, initial?: Record<string, unknown>): void;
  env(on: StubFn, vars: Record<string, string>): void;
} = {
  store: () => {
    throw new Error("claude-code/testing is provided by `claude plugin test`");
  },
  env: () => {
    throw new Error("claude-code/testing is provided by `claude plugin test`");
  },
};

export function test(
  name: string,
  fn: ($: SessionKit, on: StubFn) => unknown | Promise<unknown>,
  timeoutMs?: number,
): void {
  // Never called: the real kit replaces this module at run time.
  throw new Error("claude-code/testing is provided by `claude plugin test`");
}

export function expect(actual: unknown): Expectation {
  throw new Error("claude-code/testing is provided by `claude plugin test`");
}
