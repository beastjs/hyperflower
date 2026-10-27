import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { beastOctane } from "beast-tsrx/vite";
import { beastDevtools } from "@beastjs/devtools/vite";
import { beastPageBuilder } from "@beastjs/page-builder/vite";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { apiMiddleware } from "./src/server/api";

// Serves /api/* from the dev and preview servers.
const api = (): Plugin => ({
  name: "hyperflower-api",
  configureServer: (server) => void server.middlewares.use(apiMiddleware),
  configurePreviewServer: (server) => void server.middlewares.use(apiMiddleware),
});

export default defineConfig(({ mode }) => {
  // Server-only secrets (TRIGGER_*, CLOUDFLARE_*) for the API middleware; never exposed to the client bundle.
  // Vite re-runs this when .env changes, and loadEnv lets process.env win, so values we copied
  // in on a previous run are cleared first; real shell variables still take precedence.
  const prefixes = ["TRIGGER_", "CLOUDFLARE_"];
  const isServerKey = (key: string) => prefixes.some((prefix) => key.startsWith(prefix));
  const g = globalThis as { __shellServerEnv?: Set<string> };
  g.__shellServerEnv ??= new Set(Object.keys(process.env).filter(isServerKey));
  for (const key of Object.keys(process.env)) {
    if (isServerKey(key) && !g.__shellServerEnv.has(key)) delete process.env[key];
  }
  Object.assign(process.env, loadEnv(mode, process.cwd(), prefixes));

  return {
    resolve: {
      alias: {
        "@": fileURLToPath(new URL("./src", import.meta.url)),
      },
    },
    plugins: [tailwindcss(), beastOctane({ octane: { profile: "auto" } }), beastDevtools(), beastPageBuilder(), api()],
  };
});
