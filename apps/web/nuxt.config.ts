import { defineNuxtConfig } from 'nuxt/config';

export default defineNuxtConfig({
  compatibilityDate: '2026-11-06',
  devtools: { enabled: false },
  telemetry: false,
  runtimeConfig: {
    apiBase: 'http://127.0.0.1:3101',
    public: { socketBase: 'http://127.0.0.1:3101' },
  },
  devServer: { host: '127.0.0.1', port: 3100 },
  typescript: { strict: true },
});
