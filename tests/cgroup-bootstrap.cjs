const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const compiled = fs.readFileSync(path.join(__dirname, '../dist/index.js'), 'utf8');
const start = compiled.indexOf('function buildCgroupBootstrapScript(');
const end = compiled.indexOf('function ensureHostGitAvailable', start);
const context = { CGROUP_CONTROLLERS: ['memory', 'io', 'pids', 'cpu'] };
vm.createContext(context);
vm.runInContext(compiled.slice(start, end), context);
const script = context.buildCgroupBootstrapScript(1000, 1000);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'devcon-cgroup-test-'));
try {
  const scriptFile = path.join(temp, 'bootstrap.sh');
  fs.writeFileSync(scriptFile, script);
  assert.equal(spawnSync('/bin/sh', ['-n', scriptFile]).status, 0);
  // A denied mount must abort before launching user code; never mount during this test.
  fs.writeFileSync(path.join(temp, 'mount'), '#!/bin/sh\nprintf "%s\\n" "$*" > "$MOUNT_ARGS_FILE"\nexit 1\n', { mode: 0o755 });
  fs.writeFileSync(path.join(temp, 'cat'), '#!/bin/sh\nif [ "$1" = /proc/self/cgroup ]; then echo "0::/"; else exec /bin/cat "$@"; fi\n', { mode: 0o755 });
  fs.writeFileSync(path.join(temp, 'awk'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const mountArgs = path.join(temp, 'mount-args');
  const marker = path.join(temp, 'agent-started');
  const result = spawnSync('/bin/sh', [scriptFile, '/usr/bin/touch', marker], {
    env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, MOUNT_ARGS_FILE: mountArgs }, encoding: 'utf8',
  });
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /DELEGATION FAILED: cannot make private cgroup2 mount writable/);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(mountArgs, 'utf8').trim(), '-o remount,bind,rw,nosuid,nodev,noexec /sys/fs/cgroup');
  // An unexpected mount root must fail before even attempting a remount.
  fs.writeFileSync(path.join(temp, 'awk'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  fs.rmSync(mountArgs);
  const badRoot = spawnSync('/bin/sh', [scriptFile, '/usr/bin/touch', marker], {
    env: { ...process.env, PATH: `${temp}:${process.env.PATH}`, MOUNT_ARGS_FILE: mountArgs }, encoding: 'utf8',
  });
  assert.equal(badRoot.status, 78);
  assert.match(badRoot.stderr, /unexpected cgroup2 mount root/);
  assert.equal(fs.existsSync(mountArgs), false);
  assert.equal(fs.existsSync(marker), false);
  // Verify the documented subshell PID expression rather than silently moving its parent.
  const pidCheck = spawnSync('/bin/bash', ['-c', '( test "$BASHPID" != "$$" )']);
  assert.equal(pidCheck.status, 0);
  console.log('cgroup bootstrap: shell syntax, fail-closed mount, and subshell PID checks passed');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
