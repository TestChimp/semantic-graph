import net from 'net';

const DEFAULT_PORT = 3859;
const SCAN_MAX = 100;

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

/** Resolve listen port: explicit --port, else default 3859, else scan upward. */
export async function resolveListenPort(explicitPort?: number): Promise<number> {
  if (explicitPort !== undefined) {
    if (!Number.isFinite(explicitPort) || explicitPort < 1 || explicitPort > 65535) {
      throw new Error(`Invalid port: ${explicitPort}`);
    }
    if (!(await isPortFree(explicitPort))) {
      throw new Error(`Port ${explicitPort} is already in use`);
    }
    return explicitPort;
  }

  if (await isPortFree(DEFAULT_PORT)) return DEFAULT_PORT;

  for (let p = DEFAULT_PORT + 1; p < DEFAULT_PORT + SCAN_MAX; p++) {
    if (await isPortFree(p)) return p;
  }

  throw new Error(`No free port found in range ${DEFAULT_PORT}–${DEFAULT_PORT + SCAN_MAX - 1}`);
}
