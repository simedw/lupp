#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const packageRoot = new URL("../../", import.meta.url);
const args = process.argv.slice(2);

try {
  if (args[0] === "--version") {
    const { version } = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8"));
    console.log(`Lupp ${version}`);
  } else if (args[0] === "--help" || args[0] === "-h") {
    console.log("Usage: lupp [Electron options]\nRun inside the Git checkout you want to review.\nUpdate: npm install -g @simedw/lupp@latest");
  } else {
    const electronPath: string = createRequire(import.meta.url)("electron");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electronPath, [fileURLToPath(new URL("dist/desktop/main.js", packageRoot)), ...args], {
      stdio: "inherit",
      env
      // Inherit cwd: the launch directory is the repository being reviewed.
    });
    const forwardInterrupt = () => { child.kill("SIGINT"); };
    const forwardTerminate = () => { child.kill("SIGTERM"); };
    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);
    child.once("error", (error) => {
      console.error(`Lupp failed to start: ${error.message}`);
      process.exitCode = 1;
    });
    child.once("close", (code, signal) => {
      process.removeListener("SIGINT", forwardInterrupt);
      process.removeListener("SIGTERM", forwardTerminate);
      process.exitCode = process.exitCode || code || (signal === "SIGINT" ? 130 : signal ? 143 : 0);
    });
  }
} catch (error) {
  console.error(`Lupp failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
