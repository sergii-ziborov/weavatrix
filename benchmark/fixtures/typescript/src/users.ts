import { get } from './http.js'

export interface User {
  id: string
  name: string
}

export function loadUser(id: string): Promise<User> {
  return get<User>(`/api/users/${id}`)
}
