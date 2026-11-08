import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/** Dev-only: lets the in-game editor write public/intersection.json (no page reload: public/ is not in the module graph). */
function saveConfigPlugin(): Plugin {
  return {
    name: 'save-intersection-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__save-config', (req, res) => {
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? 'intersection';
        if (!['intersection', 'driver-eye', 'side-mirror'].includes(name)) {
          res.statusCode = 400;
          res.end('bad name');
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          try {
            const json = JSON.parse(body);
            fs.writeFileSync(path.resolve(`public/${name}.json`), JSON.stringify(json, null, 2) + '\n', 'utf8');
            res.statusCode = 200;
            res.end('ok');
          } catch (e) {
            res.statusCode = 400;
            res.end(String(e));
          }
        });
      });
    },
  };
}

export default defineConfig({ plugins: [saveConfigPlugin()] });
