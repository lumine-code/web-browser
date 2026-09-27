const DEVICE_PRESETS = Object.freeze({
  "iPhone 15 Pro": {
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "iPhone SE": {
    width: 375,
    height: 667,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
  "Pixel 8": {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
  },
  "iPad Mini": {
    width: 768,
    height: 1024,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
    userAgent:
      "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  },
});

const SCALES = Object.freeze(["auto", 0.5, 0.75, 1, 1.25, 1.5, 2]);

function normalizeEmulation(input = {}) {
  const width = Math.max(200, Math.min(9999, Math.round(Number(input.width) || 1280)));
  const height = Math.max(200, Math.min(9999, Math.round(Number(input.height) || 720)));
  const deviceScaleFactor = Math.max(0.5, Math.min(5, Number(input.deviceScaleFactor) || 1));
  const scale =
    input.scale === "auto" ? "auto" : Math.max(0.25, Math.min(2, Number(input.scale) || 1));
  return {
    width,
    height,
    deviceScaleFactor,
    scale,
    mobile: Boolean(input.mobile),
    touch: Boolean(input.touch),
    userAgent: typeof input.userAgent === "string" ? input.userAgent : undefined,
  };
}

module.exports = { DEVICE_PRESETS, SCALES, normalizeEmulation };
