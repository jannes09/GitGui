import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handlers = require('./electron/handlers.cjs') as {
  call: (method: string, args: unknown) => Promise<unknown>;
};

// Dev only: exposes the same git backend over /rpc so the UI can also run in a
// normal browser. Same-origin + localhost-only checks stop other websites
// from driving git through this endpoint.
function rpcPlugin(): Plugin {
  return {
    name: 'git-rpc',
    configureServer(server) {
      server.middlewares.use('/rpc', (req, res) => {
        const host = req.headers.host ?? '';
        const origin = req.headers.origin;
        const trusted =
          /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) &&
          (!origin || new URL(origin).host === host) &&
          (req.headers['content-type'] ?? '').startsWith('application/json');
        if (req.method !== 'POST' || !trusted) {
          res.statusCode = 403;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (c) => {
          body += c;
          if (body.length > 5_000_000) req.destroy();
        });
        req.on('end', async () => {
          res.setHeader('content-type', 'application/json');
          try {
            const { method, args } = JSON.parse(body);
            res.end(JSON.stringify(await handlers.call(method, args)));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String((e as Error).message) }));
          }
        });
      });
    },
  };
}

// Production builds run from file:// inside Electron, so lock the CSP down.
function cspPlugin(): Plugin {
  const csp =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://github.com https://avatars.githubusercontent.com; connect-src 'self'";
  return {
    name: 'csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const tag = ctx.server ? '' : `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;
        return html.replace('<!--csp-->', tag);
      },
    },
  };
}

const pkg = require('./package.json') as { version: string };

export default defineConfig({
  base: './',
  // the app's version number, shown in Settings (see src/version.ts)
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), rpcPlugin(), cspPlugin()],
  server: { host: '127.0.0.1', port: 5173 },
  build: { outDir: 'dist', emptyOutDir: true },
});
