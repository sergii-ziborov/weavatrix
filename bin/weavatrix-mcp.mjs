#!/usr/bin/env node
// Weavatrix MCP stdio entry — thin launcher so npm/npx get a shebang'd bin
// while the server itself stays a plain module. Positional args pass through:
//   weavatrix-mcp <repoRoot> [caps]               — graph path derived automatically
//   weavatrix-mcp <graph.json> <repoRoot> [caps]  — explicit graph file
import('../src/mcp-server.mjs')
