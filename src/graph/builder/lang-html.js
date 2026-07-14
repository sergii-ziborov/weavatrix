// HTML extractor (web reference graph, not a call graph — orchestrator skips pass 2 for it).
// Edges: `<link href>` / `<script src>` / `<img src>` → the referenced file (imports). Usage: class="…" / id="…"
// → recorded in htmlUsages, resolved (after all CSS parsed) to the CSS file(s) defining that selector.
export default {
  family: "html",
  grammars: ["html"],
  exts: { ".html": "html", ".htm": "html" },
  isWeb: true,
  calls: "",
  heritage: [],

  pass1(ctx) {
    const { grammar, tree, fileRel, caps, addImportEdge, resolveHref, htmlUsages } = ctx;
    for (const cap of caps(grammar, `(attribute) @attr`, tree.rootNode)) {
      const attr = cap.node;
      const nameNode = attr.namedChildren.find((c) => c.type === "attribute_name"); if (!nameNode) continue;
      const qv = attr.namedChildren.find((c) => c.type === "quoted_attribute_value");
      const valNode = (qv && qv.namedChildren.find((c) => c.type === "attribute_value")) || attr.namedChildren.find((c) => c.type === "attribute_value");
      const name = nameNode.text.toLowerCase(); const value = valNode ? valNode.text : "";
      if (!value) continue;
      const tagNode = attr.parent && attr.parent.namedChildren.find((c) => c.type === "tag_name");
      const tag = tagNode ? tagNode.text.toLowerCase() : "";
      if (name === "href" && tag === "link") { const t = resolveHref(fileRel, value); if (t) addImportEdge(t); }
      else if (name === "src" && (tag === "script" || tag === "img")) { const t = resolveHref(fileRel, value); if (t) addImportEdge(t); }
      else if (name === "class") { for (const cls of value.split(/\s+/).filter(Boolean)) htmlUsages.push({ htmlFile: fileRel, label: "." + cls }); }
      else if (name === "id") { htmlUsages.push({ htmlFile: fileRel, label: "#" + value }); }
    }
  },
};
