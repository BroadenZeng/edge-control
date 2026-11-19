import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { extraTools,extraCall } from './browser-tools.mjs';
const events=[];
const ctx={resolveTab:async(_call,tab)=>{assert.equal(tab,'test');return 'id'},withBrowser:async f=>f(async(method,params,sid)=>{events.push({method,params,sid});if(method==='Target.attachToTarget')return {sessionId:'s'};if(method==='Runtime.evaluate')return {result:{value:{ok:true}}};if(method==='DOM.getDocument')return {root:{nodeId:1}};if(method==='DOM.querySelectorAll')return {nodeIds:[2]};return {}})};
assert.equal(extraTools.length,11);
await assert.rejects(()=>extraCall('tab_snapshot',{},ctx),/unique tab/);
const a=await extraCall('tab_upload',{tab:'test',selector:'input',files:[fileURLToPath(new URL('./README.md', import.meta.url))]},ctx);assert.equal(a.count,1);assert.ok(events.some(x=>x.method==='DOM.setFileInputFiles'));assert.ok(events.some(x=>x.method==='Target.detachFromTarget'));
await assert.rejects(()=>extraCall('tab_key',{tab:'test',key:'bad'},ctx),/Unsupported key/);
const b=await extraCall('tab_snapshot',{tab:'test'},ctx);assert.equal(b.ok,true);
console.log('Mock CDP checks passed');

