import { defineConfig } from 'vinext'
import cloudflare from '@cloudflare/vite-plugin'

export default defineConfig({ plugins: [cloudflare()] })
