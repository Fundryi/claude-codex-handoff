# Contributing

Pull requests are welcome. For a bigger change, open an issue or a discussion first, so you don't build something that won't fit.

## Rules

- **No npm dependencies.** Use only the Node standard library (Node 22.13 or newer).
- **The server stays one file for now:** `codex-live-viewer.js`. The UI has markup in `ui/index.html`, six CSS files and 19 classic scripts in `ui/js/`. Keep their load order. Use no ES modules, bundler or build step. See the UI file map in `AGENTS.md`.
- **`plugin/` is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).** Keep its file layout, so `node scripts/upstream-diff.mjs` can still compare it with upstream.
- **After you change the server or the UI,** run `npm run sync:viewer` to copy the server, logo and complete `ui/` tree into `plugin/viewer/`. These copies are generated files.
- **Run `npm test` before you open a pull request.** Also try the change for real: run a handoff, or open the dashboard.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org), for example `fix(plugin): ...` or `feat(ui): ...`.

[`AGENTS.md`](AGENTS.md) has the full rules. AI coding agents read it too.

## License

By contributing, you agree that your work is licensed under the same terms as the project: Apache 2.0 with the Commons Clause. See [LICENSE](LICENSE).
