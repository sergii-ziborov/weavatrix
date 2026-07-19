import {join, resolve} from 'node:path'

export function privateSyncGraphHome({configuredHome, userHome}) {
    return resolve(configuredHome || join(userHome, '.weavatrix', 'graphs'))
}
