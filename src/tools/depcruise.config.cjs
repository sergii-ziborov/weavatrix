// Default dependency-cruiser ruleset, used ONLY when a repo has no config of its own.
// Focuses on the two universally-useful architecture checks: circular dependencies and true
// orphan modules. Repos that ship their own .dependency-cruiser config (with custom module
// boundary rules) are run against that instead — see depcruise.js.
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "Circular dependency — refactor to break the cycle.",
      severity: "warn",
      from: {},
      to: { circular: true }
    },
    {
      name: "no-orphans",
      comment: "Orphan module — imported by nothing (possible dead code).",
      severity: "info",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|cts|mts)$", // dotfiles like .eslintrc.js
          "\\.d\\.ts$",
          "(^|/)(babel|webpack|vite|rollup|jest|vitest|tsup|tsconfig)\\.[^/]+$",
          "(^|/)(index|main)\\.(js|cjs|mjs|ts|tsx|jsx)$" // common entry points
        ]
      },
      to: {}
    }
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(node_modules|dist|build|coverage|out|\\.next|vendor)(/|$)" }
  }
};
