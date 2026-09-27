const test = require("node:test");
const assert = require("node:assert/strict");
const { canPersistSiteDecision, profileFor, workspaceKey } = require("../lib/profiles");

test("default profile is persistent and global", () => {
  assert.deepEqual(profileFor("default"), {
    id: "web-browser/global",
    persistent: true,
    scope: "global",
  });
});

test("workspace profiles are stable across path order", () => {
  const first = workspaceKey(["C:/b", "C:/a"]);
  const second = workspaceKey(["C:/a", "C:/b"]);
  assert.equal(first, second);
  assert.match(profileFor("workspace", { projectPaths: ["C:/a"] }).id, /^web-browser\/workspace\//);
});

test("private profiles are unique per tab and cannot persist decisions", () => {
  const profile = profileFor("ephemeral", { tabId: "one" });
  assert.equal(profile.persistent, false);
  assert.equal(profile.id, "web-browser/tab/one");
  assert.equal(canPersistSiteDecision(profile), false);
});

test("workspace storage falls back to a private tab without project roots", () => {
  const profile = profileFor("workspace", { tabId: "empty", projectPaths: [] });
  assert.equal(profile.id, "web-browser/tab/empty");
  assert.equal(profile.persistent, false);
  assert.equal(profile.scope, "ephemeral");
});
