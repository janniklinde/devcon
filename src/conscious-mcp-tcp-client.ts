#!/usr/bin/env node
import * as net from 'net';

interface ClientConfig {
  host: string;
  port: number;
}

function parseArgs(argv: string[]): ClientConfig {
  let host = process.env.DEVCON_CONSCIOUS_TCP_HOST ?? '';
  let port = Number.parseInt(process.env.DEVCON_CONSCIOUS_TCP_PORT ?? '', 10);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
      continue;
    }
    if (arg === '--host') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--host requires a value.');
      }
      host = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--port=')) {
      const parsed = Number.parseInt(arg.slice('--port='.length), 10);
      if (Number.isFinite(parsed)) {
        port = parsed;
      }
      continue;
    }
    if (arg === '--port') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--port requires a value.');
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed)) {
        throw new Error('--port must be an integer.');
      }
      port = parsed;
      i += 1;
    }
  }

  if (!host) {
    throw new Error('Missing --host (or DEVCON_CONSCIOUS_TCP_HOST).');
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('Missing/invalid --port (or DEVCON_CONSCIOUS_TCP_PORT).');
  }

  return {
    host,
    port,
  };
}

function main(): void {
  const config = parseArgs(process.argv.slice(2));
  const socket = net.createConnection({ host: config.host, port: config.port });

  socket.on('connect', () => {
    process.stdin.resume();
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);
  });

  socket.on('error', (error) => {
    process.stderr.write(`[devcon-conscious-tcp-client] ${error.message}\n`);
    process.exitCode = 1;
    process.exit(1);
  });

  socket.on('close', (hadError) => {
    if (!hadError) {
      process.exit(0);
    }
  });

  process.stdin.on('end', () => {
    socket.end();
  });

  process.on('SIGINT', () => {
    socket.destroy();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    socket.destroy();
    process.exit(0);
  });
}

main();
