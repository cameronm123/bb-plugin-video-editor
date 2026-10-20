import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeFor } from "../core/types.ts";

// Every surface names a plan's scope the same way, or the agent and the
// person look at different timelines. These are the names the plugin's
// frontend, its agent tool and its CLI all use.
test("a thread's plan is scoped to the thread", () => {
  assert.equal(scopeFor({ threadId: "thr_123" }), "thread:thr_123");
});

test("a shell call outside a thread is scoped to the working directory", () => {
  assert.equal(scopeFor({ cwd: "/work/project" }), "cwd:/work/project");
});

test("a plugin page in a project is scoped to the project", () => {
  assert.equal(scopeFor({ projectId: "proj_1" }), "project:proj_1");
});

test("a thread wins over a directory and a project", () => {
  assert.equal(
    scopeFor({ threadId: "thr_1", cwd: "/work", projectId: "proj_1" }),
    "thread:thr_1",
  );
});

test("a directory wins over a project", () => {
  assert.equal(scopeFor({ cwd: "/work", projectId: "proj_1" }), "cwd:/work");
});

test("an empty context falls back to the plugin's own plan", () => {
  assert.equal(scopeFor({}), "default");
  assert.equal(scopeFor({ threadId: "" }), "default");
  assert.equal(scopeFor({ threadId: null, cwd: "" }), "default");
});
