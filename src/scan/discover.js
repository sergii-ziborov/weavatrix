// Discover local git repos under a folder, browse child folders, and persist per-repo run results.
// Facade: implementation lives in discover.inventory.js (fs walking / git metadata),
// discover.stack.js (framework + badge detection) and discover.list.js (repo/folder listing).
export { cleanVersion, detectFramework, detectRepoStack } from "./discover.stack.js";
export { listGitRepos, repoBaseName, listChildFolders } from "./discover.list.js";
