#!/usr/bin/env node
// Weavatrix MCP stdio entry — thin launcher so npm/npx get a shebang'd bin
// while the server itself stays a plain module. Positional args pass through
// untouched: weavatrix-mcp <graph.json> <repoRoot>
import('../src/mcp-server.mjs')
