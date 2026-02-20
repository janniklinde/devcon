#!/usr/bin/env node
import { spawn } from 'child_process';
import * as net from 'net';

interface ServerConfig {
  stateDir: string;
  repo?: string;
  projectId?: string;
  projectName?: string;
  debugLogPath?: string;
  serverScript: string;
  host: string;
  port: number;
}

function parseArgs(argv: string[]): ServerConfig {
  let stateDir = process.env.DEVCON_CONSCIOUS_STATE_DIR;
  let repo = process.env.DEVCON_CONSCIOUS_REPO;
  let projectId = process.env.DEVCON_CONSCIOUS_PROJECT_ID;
  let projectName = process.env.DEVCON_CONSCIOUS_PROJECT_NAME;
  let debugLogPath = process.env.DEVCON_CONSCIOUS_DEBUG_LOG;
  let serverScript = process.env.DEVCON_CONSCIOUS_SERVER_SCRIPT ?? '/opt/devcon/conscious-mcp-server.js';
  let host = process.env.DEVCON_CONSCIOUS_TCP_BIND_HOST ?? '0.0.0.0';
  let port = Number.parseInt(process.env.DEVCON_CONSCIOUS_TCP_BIND_PORT ?? '8765', 10);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--state-dir=')) {
      stateDir = arg.slice('--state-dir='.length);
      continue;
    }
    if (arg === '--state-dir') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--state-dir requires a path.');
      }
      stateDir = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--repo=')) {
      repo = arg.slice('--repo='.length);
      continue;
    }
    if (arg === '--repo') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--repo requires a value.');
      }
      repo = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--project-id=')) {
      projectId = arg.slice('--project-id='.length);
      continue;
    }
    if (arg === '--project-id') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--project-id requires a value.');
      }
      projectId = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--project-name=')) {
      projectName = arg.slice('--project-name='.length);
      continue;
    }
    if (arg === '--project-name') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--project-name requires a value.');
      }
      projectName = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--debug-log=')) {
      debugLogPath = arg.slice('--debug-log='.length);
      continue;
    }
    if (arg === '--debug-log') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--debug-log requires a path.');
      }
      debugLogPath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--server-script=')) {
      serverScript = arg.slice('--server-script='.length);
      continue;
    }
    if (arg === '--server-script') {
      const next = argv[i + 1];
      if (!next) {
        throw new Error('--server-script requires a path.');
      }
      serverScript = next;
      i += 1;
      continue;
    }
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

  if (!stateDir) {
    throw new Error('Missing --state-dir (or DEVCON_CONSCIOUS_STATE_DIR).');
  }
  if (!serverScript) {
    throw new Error('Missing --server-script.');
  }
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid port for TCP MCP server.');
  }

  return {
    stateDir,
    repo,
    projectId,
    projectName,
    debugLogPath,
    serverScript,
    host,
    port,
  };
}

function main(): void {
  const config = parseArgs(process.argv.slice(2));

  const server = net.createServer((socket) => {
    const args = [
      config.serverScript,
      '--state-dir', config.stateDir,
    ];
    if (config.repo) {
      args.push('--repo', config.repo);
    }
    if (config.projectId) {
      args.push('--project-id', config.projectId);
    }
    if (config.projectName) {
      args.push('--project-name', config.projectName);
    }
    if (config.debugLogPath) {
      args.push('--debug-log', config.debugLogPath);
    }

    const child = spawn('node', args, { stdio: ['pipe', 'pipe', 'pipe'] });

    socket.pipe(child.stdin);
    child.stdout.pipe(socket);

    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    socket.on('error', () => {
      child.kill('SIGTERM');
    });

    socket.on('close', () => {
      child.kill('SIGTERM');
    });

    child.on('error', (error) => {
      process.stderr.write(`[devcon-conscious-tcp-server] child error: ${error.message}\n`);
      socket.destroy();
    });

    child.on('exit', () => {
      socket.end();
    });
  });

  server.on('error', (error) => {
    process.stderr.write(`[devcon-conscious-tcp-server] ${error.message}\n`);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    process.stderr.write(`[devcon-conscious-tcp-server] listening on ${config.host}:${config.port}\n`);
  });

  const shutdown = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
