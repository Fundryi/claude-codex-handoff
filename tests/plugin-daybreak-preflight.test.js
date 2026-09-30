const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

const codexHref = pathToFileURL(path.join(__dirname, "..", "plugin", "scripts", "lib", "codex.mjs")).href;

// Fake app-server client that answers model/list from a fixed catalog.
function catalogClient(response) {
  const calls = [];
  return {
    calls,
    async request(method) {
      calls.push(method);
      if (response instanceof Error) throw response;
      return response;
    }
  };
}

// Daybreak access is verification-gated per account: a model missing from the
// account's catalog must fail before any thread starts, not mid-run.
test("preflightModel rejects a model the account's catalog does not list", async () => {
  const { preflightModel } = await import(codexHref);
  const client = catalogClient({ data: [{ id: "gpt-6.1-sol" }], nextCursor: null });
  await assert.rejects(
    preflightModel(client, { model: "gpt-daybreak-blue-latest" }),
    /not available to this Codex account \(Daybreak access is verification-gated\)/
  );
  assert.deepEqual(client.calls, ["model/list"]);
});

test("preflightModel lets a listed model through and skips when unset or the catalog fails", async () => {
  const { preflightModel } = await import(codexHref);
  const listed = catalogClient({ data: [{ id: "gpt-daybreak-blue-latest" }] });
  assert.equal(await preflightModel(listed, { model: "gpt-daybreak-blue-latest" }), null);

  const unset = catalogClient({ data: [] });
  assert.equal(await preflightModel(unset, {}), null);
  assert.deepEqual(unset.calls, []);

  // Intentional fallback: a failing model/list must not block the run.
  assert.equal(await preflightModel(catalogClient(new Error("boom")), { model: "gpt-daybreak-blue-latest" }), null);
  // A paged catalog may hold the model on a later page; do not reject.
  assert.equal(await preflightModel(catalogClient({ data: [], nextCursor: "p2" }), { model: "gpt-daybreak-blue-latest" }), null);
});
