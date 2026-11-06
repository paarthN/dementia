import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// React refresh injects an inline module. script-src 'self' blocks that, so serve
// the same virtual preamble from a local file instead.
function externalizeReactPreamble(): Plugin {
  return {
    name: 'externalize-react-preamble',
    apply: 'serve',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return html.replace(
          /<script type="module">import \{ injectIntoGlobalHook \}[\s\S]*?<\/script>/,
          '<script type="module" src="/refresh-preamble.js"></script>'
        )
      }
    }
  }
}

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ['playwright', 'playwright-core']
      }
    }
  },
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        input: {
          mascot: resolve(__dirname, 'src/renderer/mascot.html'),
          panel: resolve(__dirname, 'src/renderer/panel.html'),
          overlay: resolve(__dirname, 'src/renderer/overlay.html')
        }
      }
    },
    plugins: [react(), externalizeReactPreamble()]
  }
})
