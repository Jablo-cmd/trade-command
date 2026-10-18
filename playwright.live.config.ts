import { defineConfig, devices } from '@playwright/test';

// Live test against a real Supabase project. Run with: npm run test:live
// Needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (publishable key only) in the environment,
// and email confirmation switched off on the project so throwaway users can sign in.
export default defineConfig({
  testDir: './e2e-live',
  timeout: 90_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4174',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'android-chromium', use: { ...devices['Pixel 7'] } }],
  webServer: {
    command: 'npm run build && npx vite preview --port 4174 --strictPort',
    url: 'http://localhost:4174',
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
