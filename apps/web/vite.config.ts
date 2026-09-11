import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the SPA runs on 5173 and the API on 3000. Proxying keeps the
// browser on one origin, so the session cookie behaves exactly as it will in
// production, where the API serves the built SPA itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
