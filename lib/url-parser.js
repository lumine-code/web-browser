const fs = require("fs");
const net = require("net");
const path = require("path");
const { pathToFileURL } = require("url");

const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "file:"]);
const WEB_DOCUMENT_EXTENSIONS = new Set([".html", ".htm", ".mht", ".mhtml"]);
const SEARCH_ENGINES = Object.freeze({
  duckduckgo: "https://duckduckgo.com/?q=%s",
  google: "https://www.google.com/search?q=%s",
  bing: "https://www.bing.com/search?q=%s",
  yahoo: "https://search.yahoo.com/search?p=%s",
});

function webDocumentPath(filePath) {
  return (
    typeof filePath === "string" &&
    WEB_DOCUMENT_EXTENSIONS.has(path.extname(filePath).toLowerCase())
  );
}

function hasExplicitScheme(value) {
  return /^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value);
}

function looksLikeDiskPath(value) {
  return path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}

function parseAllowedURL(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return null;
  if ((parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.hostname)
    return null;
  return parsed.toString();
}

function splitCandidateHost(value) {
  const slash = value.search(/[/?#]/);
  return slash === -1 ? value : value.slice(0, slash);
}

function looksLikeLocalhost(value) {
  let normalized;
  if (net.isIP(value)) {
    normalized = value.toLowerCase();
  } else {
    try {
      normalized = new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
      const host = splitCandidateHost(value)
        .replace(/^\[|\](:\d+)?$/g, "")
        .replace(/:\d+$/, "");
      normalized = host.toLowerCase();
    }
  }
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "::1" ||
    (net.isIP(normalized) > 0 && (normalized.startsWith("127.") || normalized === "0.0.0.0"))
  );
}

function looksLikeHost(value) {
  if (net.isIP(value)) return true;
  const candidate = splitCandidateHost(value);
  const withoutPort = candidate.replace(/:\d+$/, "");
  if (/^\[[0-9a-f:.]+\](?::\d+)?$/i.test(candidate)) return true;
  if (net.isIP(withoutPort)) return true;
  if (/^[a-z\d](?:[a-z\d-]*[a-z\d])?:\d+$/i.test(candidate)) return true;
  if (/^[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+(?::\d+)?$/i.test(candidate))
    return true;
  return looksLikeLocalhost(value);
}

function searchURL(query, engine) {
  const template = SEARCH_ENGINES[engine];
  return template ? template.replace("%s", encodeURIComponent(query)) : null;
}

function parseAddressInput(input, options = {}) {
  const value = String(input ?? "").trim();
  if (!value) return { kind: "blank", url: "about:blank" };

  const exists = options.fileExists || fs.existsSync;
  const expandPath = options.resolvePath || ((candidate) => path.resolve(candidate));
  // A local document may be typed as `index.html` or `docs/index.html`, not
  // only as an absolute path. Resolve every scheme-less value before treating
  // it as a host or search query; an existing path is unambiguous and should
  // win over a coincidentally host-shaped name.
  if (!hasExplicitScheme(value) || looksLikeDiskPath(value)) {
    const filePath = expandPath(value);
    if (exists(filePath))
      return { kind: "url", source: "file", url: pathToFileURL(filePath).toString() };
  }

  if (looksLikeHost(value)) {
    const host = net.isIP(value) === 6 ? `[${value}]` : value;
    const url = parseAllowedURL(`${looksLikeLocalhost(value) ? "http" : "https"}://${host}`);
    if (url) return { kind: "url", source: "host", url };
  }

  if (hasExplicitScheme(value)) {
    const url = parseAllowedURL(value);
    return url
      ? { kind: "url", source: "explicit", url }
      : { kind: "invalid", reason: "Only HTTP, HTTPS and file URLs can be opened." };
  }

  const engine = options.searchEngine || "duckduckgo";
  const url = searchURL(value, engine);
  return url
    ? { kind: "search", source: engine, query: value, url }
    : { kind: "invalid", reason: "The address is not a URL and web search is disabled." };
}

function isLocalWebURL(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "0.0.0.0" ||
      hostname === "::" ||
      hostname === "::1" ||
      (net.isIP(hostname) === 4 && hostname.startsWith("127."))
    );
  } catch {
    return false;
  }
}

function safeSuggestedFilename(value, fallback = "download") {
  const basename = Array.from(path.basename(String(value || fallback)), (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || '<>:"/\\|?*'.includes(character) ? "_" : character;
  }).join("");
  const trimmed = basename.replace(/[. ]+$/g, "").slice(0, 180);
  if (!trimmed || trimmed === "." || trimmed === "..") return fallback;
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(trimmed) ? `_${trimmed}` : trimmed;
}

module.exports = {
  ALLOWED_PROTOCOLS,
  SEARCH_ENGINES,
  WEB_DOCUMENT_EXTENSIONS,
  isLocalWebURL,
  parseAddressInput,
  parseAllowedURL,
  safeSuggestedFilename,
  searchURL,
  webDocumentPath,
};
