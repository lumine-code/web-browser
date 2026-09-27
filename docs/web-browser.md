# web-browser service

The service opens web content in a first-class Lumine pane item.

```ts
type WebBrowserService = {
  open(
    url?: string,
    options?: {
      placement?: "active-pane" | "side-pane" | "window";
      activate?: boolean;
      storageScope?: "default" | "global" | "workspace" | "ephemeral";
    },
  ): Promise<WebBrowserItem | null>;
  openFile(
    filePath: string,
    options?: {
      autoReload?: boolean;
      placement?: "active-pane" | "side-pane" | "window";
      activate?: boolean;
      storageScope?: "default" | "global" | "workspace" | "ephemeral";
    },
  ): Promise<WebBrowserItem | null>;
  getItems(): WebBrowserItem[];
  getActiveItem(): WebBrowserItem | null;
};
```

`open()` accepts an already-normalized URL. Omit it to open a blank tab with its address picker focused. `openFile()` accepts an absolute path to an HTML or web archive document and can watch that exact file for changes.

The returned item is a workspace model. Its `getURI()` identifies the tab rather than the current page, so two calls with the same URL always create two independent items. A `window` placement returns `null` because the item belongs to the new renderer rather than the caller.
