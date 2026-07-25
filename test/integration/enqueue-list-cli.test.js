import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, "../../bin/queuectl.js");

let cwd;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "queuectl-cli-"));
});

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true });
});

function runCli(args) {
  return spawnSync("node", [CLI_PATH, ...args], { cwd, encoding: "utf8" });
}

describe("enqueue + list (CLI, real process)", () => {
  it("enqueues a job and lists it back as pending", () => {
    expect(
      runCli(["enqueue", JSON.stringify({ id: "job1", command: "echo 'hi'" })])
        .status,
    ).toBe(0);

    const result = runCli(["list", "--state", "pending", "--json"]);
    expect(result.status).toBe(0);

    const jobs = JSON.parse(result.stdout);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: "job1", state: "pending" });
  });

  it("prints only a JSON array on stdout when --json is passed", () => {
    runCli(["enqueue", JSON.stringify({ id: "job1", command: "echo hi" })]);
    const result = runCli(["list", "--json"]);

    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(Array.isArray(JSON.parse(result.stdout))).toBe(true);
  });

  it("rejects enqueuing a duplicate id", () => {
    runCli(["enqueue", JSON.stringify({ id: "job1", command: "echo hi" })]);
    const dup = runCli([
      "enqueue",
      JSON.stringify({ id: "job1", command: "echo hi" }),
    ]);
    expect(dup.status).not.toBe(0);
  });

  it("rejects a job with no command", () => {
    expect(runCli(["enqueue", JSON.stringify({ id: "job1" })]).status).not.toBe(
      0,
    );
  });

  it("returns an empty JSON array when no jobs match the filter", () => {
    const result = runCli(["list", "--state", "dead", "--json"]);
    expect(JSON.parse(result.stdout)).toEqual([]);
  });
  it("enqueues a job from a file via --file", () => {
    const jobFile = path.join(cwd, "job.json");
    fs.writeFileSync(
      jobFile,
      JSON.stringify({ id: "job1", command: "echo hi" }),
    );

    expect(runCli(["enqueue", "--file", jobFile]).status).toBe(0);

    const jobs = JSON.parse(runCli(["list", "--json"]).stdout);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe("job1");
  });

  it("rejects enqueue with neither inline JSON nor --file", () => {
    expect(runCli(["enqueue"]).status).not.toBe(0);
  });

  it("rejects enqueue with both inline JSON and --file", () => {
    const jobFile = path.join(cwd, "job.json");
    fs.writeFileSync(
      jobFile,
      JSON.stringify({ id: "job1", command: "echo hi" }),
    );

    const result = runCli([
      "enqueue",
      JSON.stringify({ id: "job2", command: "echo hi" }),
      "--file",
      jobFile,
    ]);
    expect(result.status).not.toBe(0);
  });
});
