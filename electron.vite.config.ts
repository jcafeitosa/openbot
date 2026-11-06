import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import solidPlugin from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { normalizePath, type Plugin } from "vite";

const rendererPort = readRendererPort(process.env.OPENBOT_DEV_RENDERER_PORT);

export default defineConfig({
  main: {
    // Workspace sources ship as TypeScript and must be bundled for the packaged app.
    plugins: [
      lazyLanguageCatalogs(),
      externalizeDepsPlugin({
        exclude: [
          "@openbot/brand",
          "@openbot/contracts",
          "@openbot/i18n",
          "@openbot/logging",
          "@openbot/team-client",
          "@openbot/telemetry",
          "@openbot/user-errors",
          // Its vendored Baileys source is TypeScript too. Baileys' own dependencies stay external.
          "@openbot/whatsapp",
        ],
      }),
    ],
    build: {
      rollupOptions: {
        // Optional peers of the vendored Baileys that OpenBot does not install: Baileys imports them
        // when it runs and goes on without them (no thumbnails, link previews or audio waveforms).
        external: ["jimp", "sharp", "audio-decode", "link-preview-js"],
        input: {
          index: resolve("src/main/index.ts"),
          // The database host is its own process. Only node:* and the installed Effect package
          // are runtime imports; the unpacked host must not load the main process bundle.
          "agent-database-host": resolve("src/backend/agent-data/agent-database-host.ts"),
          // The voice hosts are their own processes too. They import only node:* and load the
          // sherpa-onnx addon by path.
          "voice-transcription-host": resolve("src/main/voice-transcription-host.ts"),
          "voice-speech-host": resolve("src/main/voice-speech-host.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ["@openbot/contracts"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          teamWebrtc: resolve("src/preload/team-webrtc.ts"),
        },
        output: {
          format: "cjs",
          entryFileNames: "[name].cjs",
        },
      },
    },
  },
  renderer: {
    plugins: [lazyLanguageCatalogs(), solidPlugin(), tailwindcss({ optimize: false })],
    optimizeDeps: {
      // bloub finds its plush images with `new URL(..., import.meta.url)`. A pre-bundle moves the
      // code away from the images, so Vite serves the package as it is.
      exclude: ["@norbert_bodziony/bloub", "@norbert_bodziony/bloub/plush"],
    },
    resolve: {
      dedupe: ["solid-js", "@solidjs/web"],
    },
    ...(rendererPort ? { server: { port: rendererPort, strictPort: true } } : {}),
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/renderer/index.html"),
          helper: resolve("src/renderer/helper.html"),
          browserPip: resolve("src/renderer/browser-pip.html"),
          browserPipControls: resolve("src/renderer/browser-pip-controls.html"),
          teamWebrtc: resolve("src/renderer/team-webrtc.html"),
        },
      },
    },
  },
});

const I18N_SOURCE = normalizePath(fileURLToPath(new URL("./packages/i18n/src/", import.meta.url)));
const EAGER_CATALOG_MODULES = new Set(["./app-catalogs", "./source-catalogs", "./format-catalogs", "./locale-loading"]);

/**
 * The desktop main process and the desktop renderer load English first. Each other language loads
 * on first use. The same replacement as `apps/auth-api/vite.config.ts`.
 */
function lazyLanguageCatalogs(): Plugin {
  return {
    name: "openbot-lazy-language-catalogs",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !EAGER_CATALOG_MODULES.has(source)) return null;
      const from = normalizePath(importer);
      if (!from.startsWith(I18N_SOURCE) || from.endsWith("/lazy-catalogs.ts")) return null;
      return `${I18N_SOURCE}lazy-catalogs.ts`;
    },
  };
}

function readRendererPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error("OPENBOT_DEV_RENDERER_PORT must be an integer from 1024 to 65535.");
  }
  return port;
}
