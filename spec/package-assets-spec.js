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

  it("owns Alt+W as its reveal-tier binding", () => {
    const keymap = require(path.join(root, "keymaps", "main.json"));
    expect(keymap["lumine-workspace"]["alt-w"]).toBe("web-browser:toggle-focus");
  });

  it("does not contribute a title-bar item or setting", () => {
    const main = fs.readFileSync(path.join(root, "lib", "main.js"), "utf8");
    expect(manifest.consumedServices["title-bar"]).toBeUndefined();
    expect(manifest.configSchema.showInTitleBar).toBeUndefined();
    expect(main).not.toContain("consumeTitleBar");
  });

  it("does not waste keywords already present in the package name", () => {
    expect(manifest.keywords).not.toContain("web");
    expect(manifest.keywords).not.toContain("browser");
    expect(manifest.keywords.length).toBeGreaterThanOrEqual(3);
    expect(manifest.keywords.length).toBeLessThanOrEqual(8);
  });

  it("passes touch emulation to the native surface", () => {
    const view = fs.readFileSync(path.join(root, "lib", "browser-view.js"), "utf8");
    expect(view).toContain("electronOptions.touch = normalized.touch");
    expect(view).not.toMatch(/const \{ scale: _scale, touch,/);
  });

  it("uses theme variables instead of fixed colors", () => {
    const styles = fs.readFileSync(path.join(root, "styles", "main.css"), "utf8");
    expect(styles).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(styles).toContain("var(--text-color)");
  });
});
