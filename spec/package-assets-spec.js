const fs = require("fs");
const path = require("path");

describe("web-browser package assets", () => {
  const root = path.resolve(__dirname, "..");
  const manifest = require(path.join(root, "package.json"));

  it("uses the canonical description and Lumine engine", () => {
    const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
    expect(manifest.description).toBe("Browse the web without leaving the editor.");
    expect(readme.split(/\r?\n/)[2]).toBe(manifest.description);
    expect(manifest.engines.lumine).toBe("^1.0.0");
    expect(manifest.dependencies).toBeUndefined();
  });

  it("uses one main asset per scanned directory", () => {
    for (const [directory, file] of [
      ["keymaps", "main.json"],
      ["menus", "main.json"],
      ["styles", "main.css"],
    ]) {
      expect(fs.readdirSync(path.join(root, directory))).toEqual([file]);
    }
  });

  it("does not waste keywords already present in the package name", () => {
    expect(manifest.keywords).not.toContain("web");
    expect(manifest.keywords).not.toContain("browser");
    expect(manifest.keywords.length).toBeGreaterThanOrEqual(3);
    expect(manifest.keywords.length).toBeLessThanOrEqual(8);
  });
});
