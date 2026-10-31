import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const apiPort = Number(env.PORT || 3001);
  const webPort = Number(env.VITE_PORT || 5173);
  if (![apiPort, webPort].every((value) => Number.isInteger(value) && value >= 1 && value <= 65535)) {
    throw new Error('PORT and VITE_PORT must be integers from 1 to 65535.');
  }
  const target = `http://127.0.0.1:${apiPort}`;
  return {
    plugins: [react()],
    server: { host: '127.0.0.1', port: webPort, strictPort: true,
      // Python tests replace temporary directories and Windows junctions while
      // running. Skip these trees before traversal, along with mutable stores.
      watch: { ignored: /(?:^|[\\/])(?:\.venv|\.uv-python|\.uv-cache|\.python-deps|__pycache__|\.pytest_cache|\.pytest-tmp[^\\/]*|\.tmp|runtime|data|test-results)(?:[\\/]|$)/ },
      proxy: { '/api': target, '/sales': target, '/static': target } },
  };
});
