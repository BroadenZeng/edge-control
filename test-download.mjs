import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {extraCall} from './browser-tools.mjs';
const c=async()=>({});c.persistent=true;const ctx={withBrowser:async f=>f(c),resolveTab:async()=> 'tab'};const d=mkdtempSync(join(tmpdir(),'edge-watch-'));
try {await extraCall('tab_download_watch',{tab:'test',action:'start',directory:d},ctx);writeFileSync(join(d,'new.crdownload'),'x');const r=await extraCall('tab_download_watch',{tab:'test',action:'read'},ctx);assert.equal(r.candidates[0].incomplete,true);await extraCall('tab_download_watch',{tab:'test',action:'stop'},ctx);console.log('Download candidate monitoring check passed');}finally{rmSync(d,{recursive:true,force:true})}

