// Starts the Vite dev server, then launches Electron pointed at it.
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer({ server: { host: '127.0.0.1', port: 5173 } });
await server.listen();
const url = server.resolvedUrls.local[0];

const env = { ...process.env, VITE_DEV_SERVER_URL: url };
if (process.argv.includes('--smoke')) env.GITGUI_SMOKE = '1';
delete env.ELECTRON_RUN_AS_NODE; // would make Electron behave like plain Node

const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
