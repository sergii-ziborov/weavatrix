export function compileQuery(table, limit) {
  return `SELECT * FROM ${table} LIMIT ${limit}`
}
