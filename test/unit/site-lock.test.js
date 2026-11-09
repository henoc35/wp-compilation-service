import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync, spawn } from 'node:child_process';
import net from 'node:net';
import { createSiteLock } from '../../src/site-lock.js';

const hasRedis = (() => { try { execSync('redis-server --version', { stdio: 'ignore' }); return true; } catch { return false; } })();

test('verrou de site : court, prolongé tant que la compilation tourne, libéré par son seul propriétaire', { skip: !hasRedis && 'redis-server absent', timeout: 20000 }, async () => {
  const port = await new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
  const proc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i += 1) {
      const ok = await new Promise((r) => { const c = net.connect(port, '127.0.0.1', () => { c.end(); r(true); }); c.on('error', () => r(false)); });
      if (ok) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const lock = createSiteLock(`redis://127.0.0.1:${port}`, { ttlMs: 600 });
    assert.equal(await lock.acquire('s1', 'job-1'), true);
    assert.equal(await lock.acquire('s1', 'job-2'), false, 'une seule compilation par site');
    const stop = lock.keepAlive('s1', 'job-1', 150);
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(await lock.holder('s1'), 'job-1', 'prolongé au-delà de sa durée');
    stop();
    await lock.release('s1', 'job-2');
    assert.equal(await lock.holder('s1'), 'job-1', 'un autre propriétaire ne peut pas le libérer');
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(await lock.holder('s1'), null, 'expire seul si le worker s\'arrête');
    await lock.close();
  } finally {
    proc.kill();
  }
});
