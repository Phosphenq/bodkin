#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "cli.js");
if (existsSync(dist)) {
  // ESM needs a file:// URL, a bare Windows path is refused.
  await import(pathToFileURL(dist).href);
} else {
  // Source checkout without a build: run through tsx.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["--import", "tsx", join(here, "..", "src", "cli.ts"), ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}
