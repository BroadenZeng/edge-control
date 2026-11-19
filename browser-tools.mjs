import { readdirSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
const str = { type: 'string' };
const tab = { type: 'string', description: 'Unique URL/title substring' };
const spec = (name, description, properties, required) => ({ name, description, inputSchema: { type: 'object', properties: { tab, ...properties }, required: ['tab', ...required], additionalProperties: false } });
export const extraTools = [
  spec('tab_snapshot','Read visible page elements and text without input values',{limit:{type:'number'}},[]),
  spec('tab_action','Click, fill, select or check one unique CSS selector',{selector:str,name:str,action:{type:'string',enum:['click','fill','select','check','uncheck']},value:str},['action']),
  spec('tab_wait','Wait for a selector or page text',{selector:str,text:str,timeoutMs:{type:'number'}},[]),
  spec('tab_scroll','Scroll page by x and y pixels',{x:{type:'number'},y:{type:'number'}},[]),
  spec('tab_key','Send a named key to the focused element',{key:{type:'string',enum:['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Backspace','Delete','Home','End','PageDown','PageUp']}},['key']),
  spec('tab_upload','Set local files on a unique file input',{selector:str,files:{type:'array',items:str}},['selector','files']),
  spec('tab_activate','Activate a specified browser tab',{},[]),
  spec('tab_monitor','Start, read or stop recording console messages and dialogs for a tab',{action:{type:'string',enum:['start','read','stop']}},['action']),
  spec('tab_dialog','Respond to a previously monitored browser dialog',{accept:{type:'boolean'},promptText:str},['accept']),
  spec('tab_download_watch','Watch an explicitly chosen downloads folder for new files; candidates are not attributed to any tab',{action:{type:'string',enum:['start','read','stop']},directory:str},['action']),
  spec('tab_hover','Move pointer over a uniquely selected element',{selector:str},['selector']),
];
const monitors = new Map();
const downloadWatches = new Map();
function fileList(dir){return new Set(readdirSync(dir,{withFileTypes:true}).filter(e=>e.isFile()).map(e=>e.name));}
async function evaluate(call, sid, fn, arg) {
  const r = await call('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg)})`, returnByValue: true, awaitPromise: true, userGesture: true }, sid);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  if (r.result.subtype === 'error') throw new Error(r.result.description || 'Page evaluation failed');
  return r.result.value;
}
const snapshot = (a) => {
  const visible = (e) => { const r=e.getBoundingClientRect(), s=getComputedStyle(e); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
  const els=[...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[contenteditable="true"]')].filter(visible);
  const limit=Math.max(1,Math.min(200,Number(a.limit)||100));
  const selector = e => { if(e.id && document.querySelectorAll('#'+CSS.escape(e.id)).length===1) return '#'+CSS.escape(e.id); const parts=[]; for(let n=e;n && n.nodeType===1;n=n.parentElement){let i=1; for(let x=n.previousElementSibling;x;x=x.previousElementSibling) if(x.localName===n.localName)i++;parts.unshift(n.localName+':nth-of-type('+i+')');} return parts.join(' > '); }; 
  return {url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,8000),total:els.length,elements:els.slice(0,limit).map(e=>({selector:selector(e),tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),name:(e.getAttribute('aria-label')||e.labels?.[0]?.innerText||e.getAttribute('placeholder')||e.innerText||e.getAttribute('title')||'').trim().slice(0,180),id:e.id||null,type:e.getAttribute('type'),disabled:!!e.disabled,rect:(()=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()}))};
};
const act = (a) => {
  if (!!a.selector === !!a.name) throw Error('Specify exactly one of selector or name');
  const list=a.selector ? [...document.querySelectorAll(a.selector)] : [...document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox]')].filter(e=>(e.getAttribute('aria-label')||e.labels?.[0]?.innerText||e.getAttribute('placeholder')||e.innerText||e.getAttribute('title')||'').trim()===a.name);
  if(list.length!==1) throw Error(`Selector must match exactly one element; matched ${list.length}`);
  const e=list[0]; if(e.disabled) throw Error('Element is disabled');
  if(e.type==='password') throw Error('Password inputs must be handled by the user');
  e.scrollIntoView({block:'center',inline:'center'});
  if(a.action==='click') { const r=e.getBoundingClientRect(); if(!r.width||!r.height)throw Error('Element is not visible'); const x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y); if(!hit||!(e===hit||e.contains(hit)))throw Error('Element center is obscured or outside viewport'); return {x,y}; }
  if(a.action==='fill') { if(typeof a.value!=='string') throw Error('value is required'); if(!('value' in e)) throw Error('Element is not an input'); const proto=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set; if(!setter || !['INPUT','TEXTAREA'].includes(e.tagName)) throw Error('Unsupported input'); setter.call(e,a.value); e.dispatchEvent(new Event('input',{bubbles:true})); e.dispatchEvent(new Event('change',{bubbles:true})); return {dispatched:true,valueMatches:e.value===a.value}; }
  if(a.action==='select') {if(e.tagName!=='SELECT') throw Error('Not a select'); e.value=a.value; e.dispatchEvent(new Event('change',{bubbles:true}));return {dispatched:true,valueMatches:e.value===a.value};}
  if(!['checkbox','radio'].includes(e.type)) throw Error('Not a checkbox or radio'); const want=a.action==='check'; if(e.checked!==want)e.click(); return {dispatched:true,checked:e.checked,matches:e.checked===want};
};
const waitCheck = a => { if(a.selector && !document.querySelector(a.selector)) return false; if(a.text && !(document.body?.innerText||'').includes(a.text)) return false; return true; };
export async function extraCall(name, args, {withBrowser,resolveTab}) {
  if(!args.tab || typeof args.tab !== 'string') throw new Error('A unique tab is required');
  return withBrowser(async call=>{
    const targetId=await resolveTab(call,args.tab);
    if(name==='tab_activate'){await call('Target.activateTarget',{targetId});return {ok:true,targetId};}
    if(name==='tab_download_watch') {
      if(!['start','read','stop'].includes(args.action))throw Error('Invalid watch action');
      if(!call.persistent)throw Error('Download watch requires a persistent bridge (-Ensure)');
      if(args.action==='start') {if(!args.directory)throw Error('Explicit directory required');const dir=resolve(args.directory);if(!statSync(dir).isDirectory())throw Error('Not a directory');downloadWatches.set(targetId,{dir,baseline:fileList(dir)});return {watching:true,directory:dir,note:'Watch begins now; results are candidates, not proof of a browser download.'};}
      const w=downloadWatches.get(targetId);if(!w)throw Error('No active download watch for this tab');
      if(args.action==='stop'){downloadWatches.delete(targetId);return {watching:false};}
      const names=[...fileList(w.dir)].filter(n=>!w.baseline.has(n)).slice(0,100);return {watching:true,directory:w.dir,candidates:names.map(name=>({name,incomplete:name.toLowerCase().endsWith('.crdownload')})),note:'New files may belong to other downloads or programs; verify before use.'};
    }

    if(name==='tab_monitor') {
      if(!['start','read','stop'].includes(args.action))throw Error('Invalid monitor action');
      let m=monitors.get(targetId);
      if(m&&!m.call.isOpen()){monitors.delete(targetId);m=null;}
      if(args.action==='start'){
        if(!call.persistent)throw Error('Monitoring requires a persistent bridge (-Ensure)');
        if(m)return {monitoring:true,alreadyStarted:true};
        const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
        m={call,sessionId,events:[],dialog:null};
        m.unsubscribe=call.subscribe(msg=>{if(msg.sessionId!==sessionId)return;let e;if(msg.method==='Page.javascriptDialogOpening'){m.dialog={type:msg.params.type,message:msg.params.message};e={type:'dialog',dialogType:m.dialog.type,message:m.dialog.message};}else if(msg.method==='Runtime.consoleAPICalled')e={type:'console',level:msg.params.type,text:msg.params.args.map(x=>String(x.value??x.description??'')).join(' ').slice(0,3000)};else if(msg.method==='Runtime.exceptionThrown')e={type:'exception',text:String(msg.params.exceptionDetails?.text||'').slice(0,3000)};if(e){m.events.push(e);if(m.events.length>200)m.events.shift();}});
        try {await call('Runtime.enable',{},sessionId);await call('Page.enable',{},sessionId);}catch(e){m.unsubscribe();try{await call('Target.detachFromTarget',{sessionId});}catch{}throw e;}
        monitors.set(targetId,m);return {monitoring:true,note:'Console messages may contain sensitive information and the browser may return buffered earlier messages.'};
      }
      if(!m)throw Error('Monitor is not running for this tab');
      if(args.action==='read')return {monitoring:true,events:m.events,dialog:m.dialog};
      m.unsubscribe();monitors.delete(targetId);try{await m.call('Target.detachFromTarget',{sessionId:m.sessionId});}catch{}return {monitoring:false};
    }
    if(name==='tab_dialog') {const m=monitors.get(targetId);if(!m||!m.call.isOpen()||!m.dialog)throw Error('No monitored dialog');if(typeof args.accept!=='boolean')throw Error('Explicit accept boolean required');await m.call('Page.handleJavaScriptDialog',{accept:args.accept,...(typeof args.promptText==='string'?{promptText:args.promptText}:{})},m.sessionId);m.dialog=null;return {handled:true,accepted:args.accept};}

    const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
    try {
      if(name==='tab_snapshot') return await evaluate(call,sessionId,snapshot,args);
      if(name==='tab_action') {if((!args.selector && !args.name) || !args.action)throw Error('selector or name and action required'); const result=await evaluate(call,sessionId,act,args); if(args.action==='click'){await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:result.x,y:result.y},sessionId);await call('Input.dispatchMouseEvent',{type:'mousePressed',x:result.x,y:result.y,button:'left',clickCount:1},sessionId);await call('Input.dispatchMouseEvent',{type:'mouseReleased',x:result.x,y:result.y,button:'left',clickCount:1},sessionId);return {dispatched:true,note:'Verify page state separately'};} return result;}
      if(name==='tab_wait') {if(!args.selector&&!args.text)throw Error('selector or text required');const timeout=Math.max(0,Math.min(30000,Number(args.timeoutMs ?? 10000))),end=Date.now()+timeout; do {if(await evaluate(call,sessionId,waitCheck,args))return {matched:true};await new Promise(r=>setTimeout(r,250));} while(Date.now()<end);return {matched:false,timeoutMs:timeout};}
      if(name==='tab_hover') { if(!args.selector)throw Error('selector required'); const point=await evaluate(call,sessionId,a=>{const nodes=document.querySelectorAll(a.selector);if(nodes.length!==1)throw Error('Selector must match exactly one element');const e=nodes[0];e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Element is not visible');return {x:r.x+r.width/2,y:r.y+r.height/2}},args);await call('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y},sessionId);return {dispatched:true};}
      if(name==='tab_scroll') return await evaluate(call,sessionId,a=>{window.scrollBy(Number(a.x)||0,Number(a.y)||0);return {x:scrollX,y:scrollY}},args);
      if(name==='tab_key') {const allowed=['Enter','Tab','Escape','ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Backspace','Delete','Home','End','PageDown','PageUp'];if(!allowed.includes(args.key))throw Error('Unsupported key');const codes={Enter:13,Tab:9,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Backspace:8,Delete:46,Home:36,End:35,PageUp:33,PageDown:34};const event={key:args.key,code:args.key,windowsVirtualKeyCode:codes[args.key],nativeVirtualKeyCode:codes[args.key]};await call('Input.dispatchKeyEvent',{type:'keyDown',...event},sessionId);await call('Input.dispatchKeyEvent',{type:'keyUp',...event},sessionId);return {dispatched:true,key:args.key};}
      if(name==='tab_upload') {if(!args.selector||!Array.isArray(args.files)||!args.files.length)throw Error('selector and files required');for(const file of args.files){if(typeof file!=='string'||!isAbsolute(file)||!statSync(file).isFile())throw Error('Every upload file must be an existing absolute file path');}const doc=await call('DOM.getDocument',{},sessionId);const nodes=await call('DOM.querySelectorAll',{nodeId:doc.root.nodeId,selector:args.selector},sessionId);if(nodes.nodeIds.length!==1)throw Error(`Selector must match exactly one element; matched ${nodes.nodeIds.length}`);await call('DOM.setFileInputFiles',{nodeId:nodes.nodeIds[0],files:args.files},sessionId);return {dispatched:true,count:args.files.length};}
      throw Error('Unknown tool');
    } finally {try {await call('Target.detachFromTarget',{sessionId});}catch{}}
  });
}

