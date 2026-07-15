// Ownership/nesting edges are useful for navigation, but are not evidence of code usage.
const STRUCTURAL_RELATIONS = new Set(["contains", "method"]);

export const isStructuralRelation = (relation) => STRUCTURAL_RELATIONS.has(String(relation || ""));
