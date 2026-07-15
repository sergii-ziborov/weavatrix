// Deterministic community territories. Most languages keep the historical top-two-folder bucket. Java
// Maven/Gradle trees need package depth: otherwise every class under application/src becomes one giant blob.
export function communityTerritoryOf(file) {
  const normalized = String(file || "").replace(/\\/g, "/");
  if (/\.java$/i.test(normalized)) {
    const marker = /(?:^|\/)src\/(?:main|test)\/java\//.exec(normalized);
    if (marker) {
      const end = marker.index + marker[0].length;
      const prefix = normalized.slice(0, end).replace(/\/$/, "");
      const packageDirs = normalized.slice(end).split("/").filter(Boolean).slice(0, -1);
      if (packageDirs.length) return `${prefix}/${packageDirs.slice(0, 5).join("/")}`;
      return prefix;
    }
  }
  const dirs = normalized.split("/").filter(Boolean).slice(0, -1);
  return dirs.length ? dirs.slice(0, 2).join("/") : "(root)";
}
