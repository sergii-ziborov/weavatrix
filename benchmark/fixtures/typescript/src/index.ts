import { loadUser } from './users.js'

export function bootstrap(): Promise<unknown> {
  return loadUser('benchmark')
}
