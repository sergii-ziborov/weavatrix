import { compileQuery } from './query.js'

export function executeQuery(client, table) {
  return client.query(compileQuery(table, 100))
}
