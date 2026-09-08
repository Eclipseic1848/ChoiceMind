import assert from 'node:assert/strict';
import { existsSync, readFileSync, statfsSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

assert.notEqual(process.getuid(), 0);
assert.equal(process.env.CHOICEMIND_SANDBOX_HOST_CANARY, undefined);
for (const name of Object.keys(process.env)) {
  assert.equal(/API_KEY|COOKIE|TOKEN|PASSWORD|CREDENTIAL/.test(name), false);
}
for (const location of ['/workspace', '/app', '/var/run/docker.sock', '/run/docker.sock']) {
  assert.equal(existsSync(location), false);
}
assert.throws(() => writeFileSync('/root-write-canary', 'denied'));
writeFileSync('/work/canary', 'synthetic-only');
assert.equal(readFileSync('/work/canary', 'utf8'), 'synthetic-only');
const status = readFileSync('/proc/self/status', 'utf8');
assert.match(status, /^NoNewPrivs:\s+1$/m);
assert.match(status, /^CapEff:\s+0+$/m);
assert.equal(readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim(), '2147483648');
assert.equal(readFileSync('/sys/fs/cgroup/memory.swap.max', 'utf8').trim(), '0');
assert.equal(readFileSync('/sys/fs/cgroup/pids.max', 'utf8').trim(), '64');
const [quota, period] = readFileSync('/sys/fs/cgroup/cpu.max', 'utf8').trim().split(' ').map(Number);
assert.equal(quota / period, 2);
const work = statfsSync('/work');
assert.ok(work.blocks * work.bsize <= 512 * 1024 * 1024);
assert.ok(Object.values(networkInterfaces()).flat().every((address) => address.internal));
process.stdout.write('LOCAL_SANDBOX_CANARY_PASSED\n');
