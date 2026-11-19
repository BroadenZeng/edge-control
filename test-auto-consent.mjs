import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {createConsentController} from './auto-consent.mjs';
const root=mkdtempSync(join(tmpdir(),'edge-consent-test-'));
try {
 const watcher=join(root,'watcher.ps1');writeFileSync(watcher,'');let count=0,killed=0,args;
 const controller=createConsentController({stateRoot:root,kitDir:root,profileDir:join(root,'profile'),watcherPath:watcher,spawnProcess:(...a)=>{count++;args=a;const c=new EventEmitter();c.kill=()=>{killed++};return c;}});
 assert.equal(controller.enabled(),false);controller.start()();assert.equal(count,0,'first connection must not auto-click');
 assert.equal(controller.markConnected(),true);assert.equal(controller.enabled(),true);
 const stop=controller.start();assert.equal(count,1);assert.ok(args[1].includes('-Strict'));assert.ok(args[1].includes('-StopAfterFirst'));assert.equal(args[2].windowsHide,true);stop();assert.equal(killed,1);
 assert.equal(controller.reset(),true);assert.equal(controller.enabled(),false);controller.start()();assert.equal(count,1);
 const other=createConsentController({stateRoot:root,kitDir:root,profileDir:join(root,'other'),watcherPath:watcher});assert.equal(other.enabled(),false);
 console.log('First-connection, reconnect, isolation and reset checks passed');
} finally {rmSync(root,{recursive:true,force:true});}

