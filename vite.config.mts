import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import ws from 'ws';

// Node < 22 has no global WebSocket; supabase-js needs one.
if (!(globalThis as any).WebSocket) (globalThis as any).WebSocket = ws;

// Serve /api/* locally with the same Web-standard router the Supabase Edge Function uses.
function apiDev(): Plugin {
  return {
    name: 'api-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const headers = Object.entries(req.headers).filter((e): e is [string, string] => typeof e[1] === 'string');
        const request = new Request(new URL(req.url, 'http://localhost'), {
          method: req.method,
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw,
        });
        try {
          const { handle } = await server.ssrLoadModule('/lib/routes.ts');
          const r: Response = await handle(request);
          res.statusCode = r.status;
          r.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await r.arrayBuffer()));
        } catch (e) {
          console.error('[api-dev]', e);
          if (!res.headersSent) { res.statusCode = 500; res.end(String(e)); }
        }
      });
    },
  };
}

export default defineConfig(({ mode, command }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return {
    base: command === 'build' ? '/rewind-radar/' : '/', // GitHub Pages project site
    plugins: [react(), apiDev()],
  };
});
