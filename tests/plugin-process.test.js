const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const moduleHref = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "process.mjs")).href;

test("terminateProcessTree runs taskkill without a shell (Git Bash mangles /PID into a path)", async () => {
  const { terminateProcessTree } = await import(moduleHref);
  const calls = [];
  const result = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return { command, args, status: 0, signal: null, stdout: "", stderr: "", error: null };
    }
  });
  assert.equal(result.delivered, true);
  assert.equal(calls[0].command, "taskkill");
  assert.deepEqual(calls[0].args, ["/PID", "1234", "/T", "/F"]);
  assert.equal(calls[0].options.shell, false);
});
