# Contributing

Pull requests are welcome. For a bigger change, open an issue or a discussion first, so you don't build something that won't fit.

## Rules

- **No npm dependencies.** Use only the Node standard library (Node 22.13 or newer).
- **The server uses CommonJS modules in `server/`.** `ai-live-viewer.js` is the CLI and startup entry. Keep server functions as top-level named declarations. The UI has markup in `ui/index.html`, six CSS files and 19 classic scripts in `ui/js/`. Keep their load order. The UI uses no ES modules or bundler. There is no build step. See the server and UI file maps in `AGENTS.md`.
- **`plugin/` is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).** Keep its file layout, so `node scripts/upstream-diff.mjs` can still compare it with upstream.
- **After you change the server or the UI,** run `npm run sync:viewer` to copy the entry, logo and complete `server/` and `ui/` trees into `plugin/viewer/`. These copies are generated files.
- **Releases are made by hand with `gh`.** They have no zip assets. The plugin installs from the marketplace.
- **Run `npm test` before you open a pull request.** Also try the change for real: run a handoff, or open the dashboard.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org), for example `fix(plugin): ...` or `feat(ui): ...`.

[`AGENTS.md`](AGENTS.md) has the full rules. AI coding agents read it too.

## License

By contributing, you agree that your work is licensed under the same terms as the project: Apache 2.0 with the Commons Clause. See [LICENSE](LICENSE).
