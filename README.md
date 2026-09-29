# web-browser

Browse the web without leaving the editor.

> [!WARNING]
> **This package is deprecated.** It is no longer distributed through the Lumine package catalog or maintained. The supporting WebContentsView API has also been removed from Lumine core. This repository is archived and no longer receives updates.

`web-browser` opens real Chromium pages as ordinary Lumine pane items. Tabs can be split, copied and restored while cookies, history, favorites and site permissions follow the selected storage profile.

## Features

- Navigate to HTTP, HTTPS and local web documents with a familiar address bar.
- Search with DuckDuckGo, Google, Bing or Yahoo when the address is not a URL.
- Use history, workspace favorites, find-in-page, zoom, printing and detached DevTools.
- Inspect responsive layouts with device presets, viewport dimensions, DPR, scale and touch emulation.
- Review every site permission, authentication request and download before it proceeds.
- Open `.html`, `.htm`, `.mht` and `.mhtml` files from an editor or the tree view and reload them when their source changes.

## Commands

Use `Alt+W` to focus the last browser tab or return focus to the previous editor. `Ctrl+L` focuses the address bar, `Ctrl+T` opens a tab, `Ctrl+F` searches the page and `F12` opens DevTools. On macOS, use Command in place of Ctrl for the bindings written as `cmdorctrl` in the package keymap.

The complete command surface is available under `Packages > Web Browser`.

## Storage profiles

`default` and `global` share a persistent browser profile across workspaces. `workspace` isolates a persistent profile by the sorted project roots, while `ephemeral` creates a memory-only profile for each tab and does not record history or permanent permission decisions.

## Service

The `web-browser@1.0.0` service lets another package open a URL or local web document without importing private implementation files. See [the service contract](docs/web-browser.md).

## Security

Pages run in a sandboxed `WebContentsView` owned by Lumine core. This package cannot enable Node.js integration, inject preload scripts, execute arbitrary JavaScript or access Electron `WebContents` objects.

## Contributing

Issues and pull requests are welcome. Run `npm run test:unit` for the environment-independent tests and `npm test` inside a Lumine development checkout for package integration specs.
