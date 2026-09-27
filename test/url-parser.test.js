const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isLocalWebURL,
  parseAddressInput,
  safeSuggestedFilename,
  searchURL,
  webDocumentPath,
} = require("../lib/url-parser");
const path = require("path");
const { fileURLToPath } = require("url");

test("normalizes hosts, localhost and searches", () => {
  assert.equal(parseAddressInput("example.com").url, "https://example.com/");
  assert.equal(parseAddressInput("localhost:3000/path").url, "http://localhost:3000/path");
  assert.equal(parseAddressInput("::1").url, "http://[::1]/");
  assert.equal(parseAddressInput("2001:db8::1").url, "https://[2001:db8::1]/");
  assert.equal(parseAddressInput("devserver:3000").url, "https://devserver:3000/");
  assert.equal(parseAddressInput("[::1]:8080").url, "http://[::1]:8080/");
  assert.equal(
    parseAddressInput("two words", { searchEngine: "duckduckgo" }).url,
    "https://duckduckgo.com/?q=two%20words",
  );
});

test("rejects active-content and unsupported schemes", () => {
  assert.equal(parseAddressInput("javascript:alert(1)").kind, "invalid");
  assert.equal(parseAddressInput("data:text/html,hello").kind, "invalid");
  assert.equal(parseAddressInput("mailto:a@example.com").kind, "invalid");
});

test("prefers existing relative and bare local paths over search", () => {
  const root = path.resolve("C:/workspace");
  const existing = new Set([path.join(root, "index.html"), path.join(root, "docs", "guide.html")]);
  const options = {
    searchEngine: "duckduckgo",
    resolvePath: (candidate) => path.resolve(root, candidate),
    fileExists: (candidate) => existing.has(candidate),
  };

  const bare = parseAddressInput("index.html", options);
  const relative = parseAddressInput("docs/guide.html", options);
  assert.equal(bare.kind, "url");
  assert.equal(bare.source, "file");
  assert.equal(fileURLToPath(bare.url), path.join(root, "index.html"));
  assert.equal(fileURLToPath(relative.url), path.join(root, "docs", "guide.html"));
});

test("recognizes local links and web documents", () => {
  assert.equal(isLocalWebURL("http://127.0.0.1:3000"), true);
  assert.equal(isLocalWebURL("http://[::]:3000"), true);
  assert.equal(isLocalWebURL("http://[::1]:3000"), true);
  assert.equal(isLocalWebURL("http://127.attacker.example"), false);
  assert.equal(isLocalWebURL("https://example.com"), false);
  assert.equal(webDocumentPath("C:/project/index.HTML"), true);
  assert.equal(webDocumentPath("C:/project/app.js"), false);
});

test("builds search URLs and safe filenames", () => {
  assert.equal(searchURL("a/b", "google"), "https://www.google.com/search?q=a%2Fb");
  assert.equal(safeSuggestedFilename("../../bad:name?.zip"), "bad_name_.zip");
  assert.equal(safeSuggestedFilename("CON.txt"), "_CON.txt");
});
