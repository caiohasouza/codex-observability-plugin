import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hookConfigFile = path.join(repoRoot, "plugins/tracing/hooks/hooks.json");
const bundleFile = path.join(repoRoot, "plugins/tracing/dist/index.mjs");
const pluginManifestFile = path.join(repoRoot, "plugins/tracing/.codex-plugin/plugin.json");

const tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

type HookConfig = {
  hooks: Record<string, Array<{ hooks: Array<{ command: string }> }> | undefined>;
};

function readHookCommand(event: "Stop" | "SessionEnd" = "Stop"): string {
  const config = JSON.parse(fs.readFileSync(hookConfigFile, "utf-8")) as HookConfig;
  const group = config.hooks[event];
  if (!group?.[0]?.hooks?.[0]?.command) {
    throw new Error(`hooks.json has no ${event} hook command`);
  }
  return group[0].hooks[0].command;
}

function readPluginVersion(): string {
  const manifest = JSON.parse(fs.readFileSync(pluginManifestFile, "utf-8")) as { version: string };
  return manifest.version;
}

function stageInstalledPlugin(codexHome: string): void {
  const installedBundle = path.join(
    codexHome,
    `plugins/cache/codex-observability-plugin/tracing/${readPluginVersion()}/dist/index.mjs`,
  );
  fs.mkdirSync(path.dirname(installedBundle), { recursive: true });
  fs.copyFileSync(bundleFile, installedBundle);
}

function runShellCommand(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; input: string },
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("hook command timed out"));
    }, 10_000);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(options.input);
  });
}

afterEach(() => {
  while (tmpDirs.length) {
    fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe("bundled Stop hook command", () => {
  it("runs from an arbitrary session cwd via CODEX_HOME instead of a relative repo path", async () => {
    const codexHome = makeTempDir("lf-codex-home-");
    const sessionCwd = makeTempDir("lf-codex-cwd-");
    stageInstalledPlugin(codexHome);

    const { code, stderr, stdout } = await runShellCommand(readHookCommand(), {
      cwd: sessionCwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        HOME: codexHome,
      },
      input: JSON.stringify({
        hook_event_name: "Stop",
        transcript_path: path.join(sessionCwd, "rollout.jsonl"),
      }),
    });

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });

  it("does not depend on the old marketplace-root relative path", () => {
    expect(readHookCommand()).not.toContain("./plugins/tracing/dist/index.mjs");
  });

  it("points at the installed cache path for this plugin version", () => {
    expect(readHookCommand()).toContain(
      `/plugins/cache/codex-observability-plugin/tracing/${readPluginVersion()}/dist/index.mjs`,
    );
  });
});

describe("bundled SessionEnd hook command", () => {
  // The Stop hook fires after every turn, but Codex appends `task_complete` for
  // that turn *after* the hook reads the rollout, so the trailing turn is
  // deferred (see `convertRollout`). Nothing re-runs after the last turn, so
  // without a SessionEnd hook the final turn of every session is never
  // exported — and a single-turn session produces no trace at all.
  //
  // Codex flushes the transcript before dispatching SessionEnd ("failed to
  // flush transcript before SessionEnd hook"), so the trailing turn is complete
  // by the time this hook runs. The sidecar ledger keeps it exactly-once.
  it("is declared so the deferred trailing turn still gets exported", () => {
    expect(() => readHookCommand("SessionEnd")).not.toThrow();
  });

  it("runs the same bundle as the Stop hook", () => {
    expect(readHookCommand("SessionEnd")).toBe(readHookCommand("Stop"));
  });

  it("runs from an arbitrary session cwd", async () => {
    const codexHome = makeTempDir("lf-codex-home-");
    const sessionCwd = makeTempDir("lf-codex-cwd-");
    stageInstalledPlugin(codexHome);

    const { code, stderr, stdout } = await runShellCommand(readHookCommand("SessionEnd"), {
      cwd: sessionCwd,
      env: {
        ...process.env,
        CODEX_HOME: codexHome,
        HOME: codexHome,
      },
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        transcript_path: path.join(sessionCwd, "rollout.jsonl"),
      }),
    });

    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  });
});
