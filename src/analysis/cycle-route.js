export const MAX_REPRESENTATIVE_CYCLE_FILES = 64;

// Keep the complete closed route for normal cycles. Very large SCCs still get a closed, deterministic
// head/tail route without letting one finding consume the whole audit response.
export function formatRepresentativeCycle(cycle, maxFiles = MAX_REPRESENTATIVE_CYCLE_FILES) {
  const raw = Array.isArray(cycle) ? cycle.map(String).filter(Boolean) : [];
  if (!raw.length) return "";
  const closed = raw.length > 1 && raw[0] === raw[raw.length - 1] ? raw : [...raw, raw[0]];
  const cap = Math.max(4, Number(maxFiles) || MAX_REPRESENTATIVE_CYCLE_FILES);
  if (closed.length <= cap + 1) return closed.join(" → ");
  const side = Math.max(2, Math.floor(cap / 2));
  const omitted = closed.length - side * 2;
  return `${closed.slice(0, side).join(" → ")} → … ${omitted} file(s) omitted … → ${closed.slice(-side).join(" → ")}`;
}
