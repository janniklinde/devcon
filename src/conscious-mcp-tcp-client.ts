#!/usr/bin/env node
import * as net from 'net';

interface ClientConfig {
  host: string;
  port: number;
  connectTimeoutMs: number;
  maxRetryDelayMs: number;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(argv: string[]): ClientConfig {
  let host = process.env.DEVCON_CONSCIOUS_TCP_HOST ?? '';
  let port = Number.parseInt(process.env.DEVCON_CONSCIOUS_TCP_PORT ?? '', 10);
  let connectTimeoutMs = parsePositiveInt(process.env.DEVCON_CONSCIOUS_TCP_CONNECT_TIMEOUT_MS, 15_000);
  let maxRetryDelayMs = parsePositiveInt(process.env.DEVCON_CONSCIOUS_TCP_MAX_RETRY_DELAY_MS, 1_000);

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
      continue;
    }
    if (arg.startsWith('--connect-timeout-ms=')) {
      connectTimeoutMs = parsePositiveInt(arg.slice('--connect-timeout-ms='.length), connectTimeoutMs);
      continue;
    }
    if (arg === '--connect-timeout-ms') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--connect-timeout-ms requires a value.');
      }
      connectTimeoutMs = parsePositiveInt(next, connectTimeoutMs);
      i += 1;
      continue;
    }
    if (arg.startsWith('--max-retry-delay-ms=')) {
      maxRetryDelayMs = parsePositiveInt(arg.slice('--max-retry-delay-ms='.length), maxRetryDelayMs);
      continue;
    }
    if (arg === '--max-retry-delay-ms') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--max-retry-delay-ms requires a value.');
      }
      maxRetryDelayMs = parsePositiveInt(next, maxRetryDelayMs);
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
    connectTimeoutMs,
    maxRetryDelayMs,
  };
}

function main(): void {
  const config = parseArgs(process.argv.slice(2));
  const startTime = Date.now();
  let attempt = 0;
  let terminating = false;
  let connected = false;
  let stdinEnded = false;
  let activeSocket: net.Socket | undefined;
  const pendingChunks: Buffer[] = [];

  const shutdown = (): void => {
    terminating = true;
    if (activeSocket && !activeSocket.destroyed) {
      activeSocket.destroy();
    }
    process.exit(0);
  };

  const fail = (message: string): void => {
    process.stderr.write(`[devcon-conscious-tcp-client] ${message}\n`);
    process.exit(1);
  };

  const scheduleRetry = (reason: string): void => {
    if (terminating || connected) {
      return;
    }
    const elapsed = Date.now() - startTime;
    if (elapsed >= config.connectTimeoutMs) {
      fail(`unable to connect to ${config.host}:${config.port} within ${config.connectTimeoutMs}ms (${reason}).`);
      return;
    }
    const delay = Math.min(100 * (2 ** attempt), config.maxRetryDelayMs);
    attempt += 1;
    setTimeout(() => {
      attemptConnect();
    }, delay);
  };

  const onSocketConnected = (socket: net.Socket): void => {
    connected = true;
    activeSocket = socket;
    socket.setTimeout(0);

    socket.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
    });

    socket.on('error', (error) => {
      if (terminating) {
        return;
      }
      fail(error.message);
    });

    socket.on('close', (hadError) => {
      if (terminating) {
        return;
      }
      if (hadError) {
        process.exit(1);
        return;
      }
      process.exit(0);
    });

    for (const chunk of pendingChunks) {
      socket.write(chunk);
    }
    pendingChunks.length = 0;

    if (stdinEnded) {
      socket.end();
    }
  };

  const attemptConnect = (): void => {
    if (terminating || connected) {
      return;
    }

    let settled = false;
    const socket = net.createConnection({ host: config.host, port: config.port });
    socket.setTimeout(Math.max(1_000, config.connectTimeoutMs));

    const retry = (reason: string): void => {
      if (settled || terminating || connected) {
        return;
      }
      settled = true;
      socket.destroy();
      scheduleRetry(reason);
    };

    socket.once('connect', () => {
      if (settled || terminating || connected) {
        socket.destroy();
        return;
      }
      settled = true;
      onSocketConnected(socket);
    });

    socket.once('timeout', () => {
      retry('connect attempt timed out');
    });

    socket.once('error', (error) => {
      retry(error.message);
    });

    socket.once('close', (hadError) => {
      if (!settled && !hadError) {
        retry('connection closed before establishing session');
      }
    });
  };

  process.stdin.on('data', (chunk: Buffer | string) => {
    const payload = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (connected && activeSocket && !activeSocket.destroyed) {
      activeSocket.write(payload);
      return;
    }
    pendingChunks.push(payload);
  });

  process.stdin.on('end', () => {
    stdinEnded = true;
    if (connected && activeSocket && !activeSocket.destroyed) {
      activeSocket.end();
    }
  });

  process.stdin.resume();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  attemptConnect();
}

main();
