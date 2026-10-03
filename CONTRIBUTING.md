# Contributing

Pull requests are welcome. For a bigger change, open an issue or a discussion first, so you don't build something that won't fit.

## Rules

- **No npm dependencies.** Use only the Node standard library (Node 22.13 or newer).
- **The server is one file and the UI is one file.** `codex-live-viewer.js` and `viewer-ui.html` have no build step. Keep it that way.
- **`plugin/` is a fork of [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc).** Keep its file layout, so `node scripts/upstream-diff.mjs` can still compare it with upstream.
- **After you change the server or the UI,** run `npm run sync:viewer` to refresh the copies in `plugin/viewer/`.
- **Run `npm test` before you open a pull request.** Also try the change for real: run a handoff, or open the dashboard.
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org), for example `fix(plugin): ...` or `feat(ui): ...`.

[`AGENTS.md`](AGENTS.md) has the full rules. AI coding agents read it too.

## License

By contributing, you agree that your work is licensed under the same terms as the project: Apache 2.0 with the Commons Clause. See [LICENSE](LICENSE).
