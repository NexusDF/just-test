import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/** Совпадает с <meta name="theme-color"> в index.html. */
const THEME_COLOR = '#1a1030'

/** PAGES_BASE приходит из actions/configure-pages без обязательного слэша на конце. */
function resolveBase(): string {
  const raw = process.env.PAGES_BASE
  if (!raw) return '/'
  const withSlash = raw.endsWith('/') ? raw : `${raw}/`
  return withSlash.startsWith('/') ? withSlash : `/${withSlash}`
}

export default defineConfig({
  base: resolveBase(),
  plugins: [
    vue(),
    VitePWA({
      registerType: 'autoUpdate',
      strategies: 'generateSW',
      includeManifestIcons: false,
      manifest: {
        name: 'Три в ряд',
        short_name: '3 в ряд',
        lang: 'ru',
        display: 'standalone',
        background_color: THEME_COLOR,
        theme_color: THEME_COLOR,
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'pwa-512x512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
      },
    }),
  ],
})
