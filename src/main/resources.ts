import { join } from 'node:path'

/**
 * Absolute path to the bundled monitor hook, loadable via `pi -e <path>`.
 * Electron is lazily required so pure modules importing this file stay
 * testable in plain Node (the require runs only when this is called).
 */
export function monitorHookPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { app } = require('electron')
  return app.isPackaged
    ? join(process.resourcesPath, 'monitor.ts')
    : join(app.getAppPath(), 'resources', 'monitor.ts')
}
