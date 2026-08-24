import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const SIMULATION_ASSETS = [
  "simulation-worker.js",
  "simulation_core.py",
  "scenario-contract.json",
  "vendor/jos3-0.5.0-py3-none-any.whl",
] as const;

function simulationAssetVersion(): string {
  const hash = createHash("sha256");
  for (const asset of SIMULATION_ASSETS) {
    hash.update(asset);
    hash.update(readFileSync(resolve(ROOT, asset)));
  }
  return hash.digest("hex").slice(0, 16);
}

function copySimulationAssets(): Plugin {
  return {
    name: "copy-simulation-assets",
    closeBundle() {
      const output = resolve(ROOT, "dist");
      mkdirSync(resolve(output, "vendor"), { recursive: true });
      cpSync(resolve(ROOT, "simulation-worker.js"), resolve(output, "simulation-worker.js"));
      cpSync(resolve(ROOT, "simulation_core.py"), resolve(output, "simulation_core.py"));
      cpSync(resolve(ROOT, "scenario-contract.json"), resolve(output, "scenario-contract.json"));
      cpSync(
        resolve(ROOT, "vendor/jos3-0.5.0-py3-none-any.whl"),
        resolve(output, "vendor/jos3-0.5.0-py3-none-any.whl"),
      );
    },
  };
}

export default defineConfig({
  base: "./",
  define: {
    __SIMULATION_ASSET_VERSION__: JSON.stringify(simulationAssetVersion()),
  },
  plugins: [react(), copySimulationAssets()],
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: true,
  },
});
