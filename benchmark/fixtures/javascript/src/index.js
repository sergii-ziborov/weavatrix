import { executeQuery } from './service.js'

export const run = (client) => executeQuery(client, 'events')
