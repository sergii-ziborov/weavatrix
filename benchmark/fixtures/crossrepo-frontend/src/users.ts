import { get } from './http.js'

export const loadUser = (id: string) => get(`/api/users/${id}`)
