import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

export function createConsentController({ stateRoot, kitDir, profileDir, watcherPath, spawnProcess = spawn }) {
  if (!stateRoot) return { enabled: () => false, start: () => () => {}, markConnected: () => false, reset: () => false };
  const norm = p => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  const key = createHash('sha256').update(norm(kitDir) + '\0' + norm(profileDir)).digest('hex');
  const dir = join(stateRoot, 'EdgeControl', 'approvals');
  const file = join(dir, key + '.json');
  const enabled = () => { try { return JSON.parse(readFileSync(file, 'utf8')).version === 1; } catch { return false; } };
  return {
    enabled,
    start() {
      if (!enabled() || !existsSync(watcherPath)) return () => {};
      let child;
      try {
        child = spawnProcess('powershell.exe', ['-NoProfile', '-File', watcherPath, '-WindowSeconds', '20', '-Strict', '-StopAfterFirst'], { windowsHide: true, stdio: 'ignore' });
        child.on('error', () => {});
      } catch { return () => {}; }
      return () => { try { child.kill(); } catch {} };
    },
    markConnected() { try { mkdirSync(dir, { recursive: true }); writeFileSync(file, JSON.stringify({ version: 1 }), { flag: 'wx' }); return true; } catch (e) { return e.code === 'EEXIST' && enabled(); } },
    reset() { try { unlinkSync(file); return true; } catch(e) { if(e.code === 'ENOENT') return false; throw e; } },
  };
}

