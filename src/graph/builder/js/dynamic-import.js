// Resolve only the bounded local-file portion of URL-based dynamic imports.
// Runtime substitutions remain uncertain; this candidate exists solely so a
// statically named module is not mislabeled as an orphan.
export function boundedUrlImportTarget(arg, {field, fileRel, resolveJsImport}) {
  if (!arg || arg.type !== "member_expression" || field(arg, "property")?.text !== "href") return null;
  const created = field(arg, "object");
  if (!created || created.type !== "new_expression" || field(created, "constructor")?.text !== "URL") return null;
  const urlArgs = field(created, "arguments")?.namedChildren || [];
  if (urlArgs.length !== 2 || urlArgs[1].text !== "import.meta.url") return null;

  const source = urlArgs[0];
  let rawSpec = "";
  if (source.type === "string") {
    rawSpec = source.text.replace(/^['"`]|['"`]$/g, "");
  } else if (source.type === "template_string") {
    const parts = source.namedChildren || [];
    if (parts.length !== 2 || parts[0].type !== "string_fragment" || parts[1].type !== "template_substitution") return null;
    rawSpec = parts[0].text;
  } else return null;

  if (!/^\.\.?\//.test(rawSpec)) return null;
  const staticPath = rawSpec.split(/[?#]/)[0];
  if (!/\.[cm]?[jt]sx?$/i.test(staticPath)) return null;
  const target = resolveJsImport(fileRel, staticPath);
  return target ? {rawSpec: staticPath, target} : null;
}
