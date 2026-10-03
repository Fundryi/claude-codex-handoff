// OpenCode 2 plugin. Setup copies this file only after the user chooses install.
export default {
  id: "ai-live-viewer.notify",
  setup(ctx) {
    const controller = new AbortController();
    const seen = new Set();
    void (async () => {
      try {
        for await (const e of ctx.event.subscribe({ signal: controller.signal })) {
          try {
            if (!["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
              "permission.asked", "question.asked"].includes(e.type)) continue;
            if (e.id && seen.has(e.id)) continue;
            if (e.id) {
              seen.add(e.id);
              if (seen.size > 1000) seen.delete(seen.values().next().value);
            }
            await fetch(`http://127.0.0.1:${Number(process.env.CODEX_VIEWER_PORT) || 8377}/notify`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ source: "opencode", event: e.type,
                sessionId: e.data?.sessionID, directory: e.location?.directory }),
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1500)])
            });
          } catch {}
        }
      } catch {}
    })().catch(() => {});
    return () => controller.abort();
  }
};
