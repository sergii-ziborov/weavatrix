// weavatrix config (Node).
import { fileURLToPath } from "node:url";

const MAIN_DIR = fileURLToPath(new URL(".", import.meta.url));
export const ROOT_DIR = MAIN_DIR; // fallback cwd for repo-list helpers when a call passes none
