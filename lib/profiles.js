const crypto = require("crypto");
const path = require("path");

const STORAGE_SCOPES = new Set(["default", "global", "workspace", "ephemeral"]);

function normalizeStorageScope(scope) {
  return STORAGE_SCOPES.has(scope) ? scope : "default";
}

function workspaceKey(projectPaths = []) {
  const normalized = projectPaths
    .filter((item) => typeof item === "string" && item.length > 0)
    .map((item) => path.resolve(item).replace(/\\/g, "/").toLowerCase())
    .sort();
  const source = normalized.length > 0 ? normalized.join("\0") : "empty-workspace";
  return crypto.createHash("sha256").update(source).digest("hex").slice(0, 24);
}

function safeId(value) {
  return (
    String(value || "tab")
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .slice(0, 80) || "tab"
  );
}

function profileFor(scope, options = {}) {
  const requestedScope = normalizeStorageScope(scope);
  const resolvedScope = requestedScope === "default" ? "global" : requestedScope;
  if (resolvedScope === "ephemeral") {
    return {
      id: `web-browser/tab/${safeId(options.tabId)}`,
      persistent: false,
      scope: resolvedScope,
    };
  }
  if (resolvedScope === "workspace") {
    if (!options.projectPaths?.length) {
      return {
        id: `web-browser/tab/${safeId(options.tabId)}`,
        persistent: false,
        scope: "ephemeral",
      };
    }
    return {
      id: `web-browser/workspace/${workspaceKey(options.projectPaths)}`,
      persistent: true,
      scope: resolvedScope,
    };
  }
  return { id: "web-browser/global", persistent: true, scope: "global" };
}

function canPersistSiteDecision(profile) {
  return Boolean(profile?.persistent && ["global", "workspace"].includes(profile.scope));
}

module.exports = {
  STORAGE_SCOPES,
  canPersistSiteDecision,
  normalizeStorageScope,
  profileFor,
  workspaceKey,
};
