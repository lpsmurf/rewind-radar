import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Serves /api/*.ts (Vercel-style handlers) during `vite` dev so we can test locally.
function apiDev(): Plugin {
  return {
    name: 'api-dev',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) return next();
        const url = new URL(req.url, 'http://localhost');
        const parts = url.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
        const query: Record<string, string> = Object.fromEntries(url.searchParams);
        let file = `/api/${parts.join('/')}.ts`;
        if (parts[0] === 'tape' && parts[1]) { file = '/api/tape/[slug].ts'; query.slug = decodeURIComponent(parts[1]); }
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body: unknown = undefined;
        try { body = raw ? JSON.parse(raw) : undefined; } catch { body = raw; }
        const vreq: any = Object.assign(req, { query, body });
        const vres: any = Object.assign(res, {
          status(code: number) { res.statusCode = code; return vres; },
          json(obj: unknown) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); return vres; },
          send(s: string) { res.end(s); return vres; },
        });
        try {
          const mod = await server.ssrLoadModule(file);
          await mod.default(vreq, vres);
        } catch (e) {
          console.error('[api-dev]', e);
          if (!res.headersSent) { res.statusCode = 500; res.end(String(e)); }
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ''));
  return { plugins: [react(), apiDev()] };
});
