// Child processes and worker threads do not need the hosted-sync bearer token.
// Keep it in the MCP process so only sync_graph can attach it to an HTTP request.
export function childProcessEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.WEAVATRIX_SYNC_TOKEN;
  return env;
}
