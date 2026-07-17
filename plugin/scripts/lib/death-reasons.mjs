// Map raw codex failure text to a human-readable cause + fix hint.
const SIGNATURES = [
  [/CreateProcessAsUserW failed: 1312|CreateProcessWithLogonW|windows sandbox:.*(SpawnChild|helper_unknown_error)/i,
    "Windows sandbox cannot spawn processes (Store PowerShell stub, error 1312 cluster). Keep sandbox at danger-full-access (the default) or install MSI PowerShell and disable the pwsh app-execution alias."],
  [/\b401\b|unauthorized|not.?logged.?in|token.+expired/i,
    "Codex auth expired or missing - run `codex login`."],
  [/\b429\b|rate.?limit/i,
    "Rate limited by OpenAI - wait a bit, then resume the thread."],
  [/ENOENT.*codex|codex.*(?:ENOENT|not found)|not recognized as.*codex/i,
    "Codex CLI not found on PATH - `npm install -g @openai/codex`."],
];

export function mapDeathReason(text) {
  const t = String(text ?? "");
  if (!t) return null;
  for (const [re, reason] of SIGNATURES) {
    if (re.test(t)) return reason;
  }
  return null;
}
