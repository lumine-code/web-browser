const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isLocalWebURL,
  parseAddressInput,
  safeSuggestedFilename,
  searchURL,
  webDocumentPath,
} = require("../lib/url-parser");

test("normalizes hosts, localhost and searches", () => {
  assert.equal(parseAddressInput("example.com").url, "https://example.com/");
  assert.equal(parseAddressInput("localhost:3000/path").url, "http://localhost:3000/path");
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

test("recognizes local links and web documents", () => {
  assert.equal(isLocalWebURL("http://127.0.0.1:3000"), true);
  assert.equal(isLocalWebURL("https://example.com"), false);
  assert.equal(webDocumentPath("C:/project/index.HTML"), true);
  assert.equal(webDocumentPath("C:/project/app.js"), false);
});

test("builds search URLs and safe filenames", () => {
  assert.equal(searchURL("a/b", "google"), "https://www.google.com/search?q=a%2Fb");
  assert.equal(safeSuggestedFilename("../../bad:name?.zip"), "bad_name_.zip");
});
