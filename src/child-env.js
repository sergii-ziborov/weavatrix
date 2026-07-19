// Child processes and worker threads never need credentials owned by a composing connector.
// Keep connector secrets in the parent MCP process and out of Git/LSP/test subprocesses.
export function childProcessEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.WEAVATRIX_SYNC_TOKEN;
  return env;
}
