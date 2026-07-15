// Stable folder territories used by module_map. Nested package source roots keep the first directory below
// `src`; otherwise a monorepo's entire crate/app would collapse into one module with no visible dependencies.
export function folderModuleOf(file) {
  const dirs = String(file || "").split(/[\\/]/).filter(Boolean).slice(0, -1);
  if (!dirs.length) return "(root)";
  const sourceRoot = dirs.lastIndexOf("src");
  if (sourceRoot >= 0 && dirs.length > sourceRoot + 1) return dirs.slice(0, sourceRoot + 2).join("/");
  return dirs.slice(0, 2).join("/");
}

export function edgeList(map) {
  return [...map.entries()]
    .map(([key, value]) => {
      const splitAt = key.indexOf(" ");
      const from = key.slice(0, splitAt), to = key.slice(splitAt + 1);
      if (typeof value === "number") return { from, to, count: value };
      const dominant = Object.entries(value.rels).sort((a, b) => b[1] - a[1])[0];
      return { from, to, count: value.count, relation: dominant ? dominant[0] : null };
    })
    .sort((a, b) => b.count - a.count);
}
