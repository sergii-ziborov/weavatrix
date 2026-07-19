export const graphEndpointId = (value) => String(value && typeof value === "object" ? value.id : value);

export const fileOfId = (value) => {
  const id = String(value || "");
  const hash = id.indexOf("#");
  return hash < 0 ? id : id.slice(0, hash);
};
