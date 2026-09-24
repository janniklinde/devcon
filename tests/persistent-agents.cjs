const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devcon-agent-test-'));
const home = path.join(root, 'home');
const fakeBin = path.join(root, 'bin');
const log = path.join(root, 'docker-log.jsonl');
fs.mkdirSync(home);
fs.mkdirSync(fakeBin);

const fakeDocker = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'run' && args.includes('--entrypoint') && args[args.indexOf('--entrypoint') + 1] === 'npm') {
  const mount = args.find((arg) => arg.startsWith('type=bind,source=') && arg.endsWith(',target=/opt/devcon/agents'));
  const source = mount.slice('type=bind,source='.length, -',target=/opt/devcon/agents'.length);
  const packageName = args.at(-1);
  const binary = packageName.startsWith('@openai/') ? 'codex'
    : packageName.startsWith('@anthropic-ai/') ? 'claude'
    : packageName.startsWith('opencode-ai') ? 'opencode' : 'pi';
  const bin = path.join(source, 'npm', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, binary), '#!/bin/sh\\n', { mode: 0o755 });
}
`;
fs.writeFileSync(path.join(fakeBin, 'docker'), fakeDocker, { mode: 0o755 });

const env = {
  ...process.env,
  HOME: home,
  PATH: `${fakeBin}:${process.env.PATH}`,
  FAKE_DOCKER_LOG: log,
  DEVCON_BUILD_NETWORK: 'host',
};
delete env.DEVCON_TOOLS_FILE;

function devcon(args) {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'index.js'), ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result;
}

function loggedRuns() {
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((args) => args[0] === 'run');
}

try {
  devcon(['update', 'codex']);
  let runs = loggedRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].at(-1), '@openai/codex@latest');
  assert.ok(!runs[0].includes('build'));

  devcon(['--no-env', 'codex', '--', '--version']);
  runs = loggedRuns();
  assert.equal(runs.length, 2, 'a second install should be skipped');
  const launch = runs[1];
  assert.ok(launch.includes(`type=bind,source=${path.join(home, '.local/share/devcon/agents')},target=/opt/devcon/agents`));
  assert.ok(launch.includes('NPM_CONFIG_PREFIX=/opt/devcon/agents/npm'));
  assert.ok(launch.includes('PATH=/opt/devcon/agents/npm/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'));

  devcon(['update', 'claude']);
  runs = loggedRuns();
  assert.equal(runs.length, 3);
  assert.equal(runs[2].at(-1), '@anthropic-ai/claude-code@latest');
  assert.ok(fs.existsSync(path.join(home, '.local/share/devcon/agents/npm/bin/claude')));

  devcon(['--no-env', 'opencode', '--', '--version']);
  runs = loggedRuns();
  assert.equal(runs.length, 5, 'first launch should install only the selected agent');
  assert.equal(runs[3].at(-1), 'opencode-ai@latest');
  assert.ok(runs[4].includes('opencode'));
  console.log('persistent agents: targeted update, first-use install, shared mount, and launch reuse passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
