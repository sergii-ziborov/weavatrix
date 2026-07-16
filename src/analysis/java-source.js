// Replace Java comments and string/char literal contents with spaces while preserving length and
// newlines. Regex-based signal extractors can then trust match positions without accepting examples
// from comments, docs, or string constants as executable annotations.
export function maskJavaNonCode(source) {
  const text = String(source || "");
  const chars = [...text];
  let state = "code";
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (ch === "/" && next === "/") { chars[i] = chars[i + 1] = " "; i++; state = "line"; }
      else if (ch === "/" && next === "*") { chars[i] = chars[i + 1] = " "; i++; state = "block"; }
      else if (ch === '"') { chars[i] = " "; state = "string"; escaped = false; }
      else if (ch === "'") { chars[i] = " "; state = "char"; escaped = false; }
      continue;
    }
    if (state === "line") {
      if (ch === "\n" || ch === "\r") state = "code";
      else chars[i] = " ";
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") { chars[i] = chars[i + 1] = " "; i++; state = "code"; }
      else if (ch !== "\n" && ch !== "\r") chars[i] = " ";
      continue;
    }
    if (ch === "\n" || ch === "\r") { escaped = false; continue; }
    chars[i] = " ";
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if ((state === "string" && ch === '"') || (state === "char" && ch === "'")) state = "code";
  }
  return chars.join("");
}
