// Interim, until the server split (Phase 4): one config for the modules that still read it at import time.
import { loadConfig } from './config.ts'

const app = loadConfig(process.env)
const config = { ...app.current() }
app.onChange(next => Object.assign(config, next))

export const settings = app.settings
export default config
