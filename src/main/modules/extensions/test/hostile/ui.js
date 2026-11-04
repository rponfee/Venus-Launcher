'use strict';
// Prueba de la interfaz en la ventana real, con un cliente de Supabase falso (no toca ningún servidor): catálogo, resumen
// de instalación, verificación del sha-256, permisos nuevos al actualizar, lista de bloqueadas, envío y panel de admin.
// Uso: node src/main/modules/extensions/test/hostile/ui.js <carpeta temporal>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { readPackage } = require('../../package');
const { packFolder } = require('../../../../../../scripts/pack-extension');

const ROOT = path.join(__dirname, '..', '..', '..', '..', '..', '..');
const BASE = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'venus-ui-')));
const DATA = path.join(BASE, 'data');
const SHOTS = path.join(BASE, 'shots');

function pkgFile(name, over) {
  const zip = new AdmZip();
  const manifest = { manifestVersion: 1, id: 'demo-ext', name: 'Demo', version: '1.0.0', author: 'Alguien', description: 'Una extensión de demostración', minLauncherVersion: '3.0.0', permissions: ['storage'], entry: 'index.html', ...over };
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.addFile('index.html', Buffer.from('<!doctype html><title>x</title><p>demo</p>'));
  const buffer = zip.toBuffer();
  const parsed = readPackage(buffer);
  const file = path.join(BASE, name);
  fs.writeFileSync(file, buffer);
  return { file: file.split(path.sep).join('/'), sha256: parsed.sha256, size: buffer.length, manifest };
}

const log = (label, value) => `console.warn('[UI] '+JSON.stringify({label:${JSON.stringify(label)},value:${value}}));`;

function routes(v1, v2, example) {
  // Cliente falso: guarda lo que le piden en window.__calls
  const fake = `
    window.__calls=[];
    const {cloud}=await import('./js/cloud.js');
    const fb=(async f=>{const r=await window.venus.invoke('extensions:readForSubmit',f);return new Blob([r.bytes]);});
    window.__catalog=[];
    window.__admin=[];
    const client={
      rpc:async(name,args)=>{window.__calls.push({name,args});
        if(name==='extension_catalog')return{data:window.__catalog,error:null};
        if(name==='extension_blocklist')return{data:window.__blocklist||{ids:[],hashes:[]},error:null};
        if(name==='extension_my_submissions')return{data:[{name:'Demo',version:'0.9.0',status:'rejected',note:'Falta un permiso',at:new Date().toISOString()}],error:null};
        if(name==='extension_submit')return window.__submitError?{data:null,error:{message:window.__submitError}}:{data:{id:'x',path:'u/x/1.venusext',bucket:'extension-packages'},error:null};
        if(name==='admin_extensions')return{data:window.__admin,error:null};
        if(name==='admin_extension_review'||name==='admin_extension_block')return{data:{ok:true},error:null};
        return{data:null,error:{message:'desconocida'}};},
      storage:{from:(bucket)=>({
        download:async(p)=>{window.__calls.push({name:'download',bucket,path:p});return{data:await fb(window.__downloadFile),error:null};},
        upload:async(p,blob,o)=>{window.__calls.push({name:'upload',bucket,path:p,size:blob.size,upsert:o&&o.upsert,type:o&&o.contentType});return{data:{},error:null};},
      })},
    };
    Object.defineProperty(cloud,'client',{configurable:true,get:()=>client});
    cloud.isConfigured=()=>true;cloud.isSignedIn=()=>true;
    window.__fakeReady=true;`;
  const row = (p) => `{id:${JSON.stringify(p.manifest.id)},name:${JSON.stringify(p.manifest.name)},author:'Alguien',description:'Desc',version:${JSON.stringify(p.manifest.version)},permissions:${JSON.stringify(p.manifest.permissions)},sizeBytes:${p.size},sha256:${JSON.stringify(p.sha256)},path:'u/demo/1.venusext'}`;
  const wait = (ms) => `await new Promise(r=>setTimeout(r,${ms}));`;
  const clickBtn = (re, scope = 'document') => `(()=>{const b=[...${scope}.querySelectorAll('button')].find(x=>${re}.test(x.textContent));if(b)b.click();return !!b})()`;
  return [
    // Sin activar: ningún pedido
    `extensions/catalog|(async()=>{${log('optin', `{blocked:!!document.querySelector('.empty'),text:document.querySelector('.empty-title')&&document.querySelector('.empty-title').textContent}`)}})()`,
    // Con cliente falso y catálogo activado: la lista
    `extensions/installed|(async()=>{${fake}window.__downloadFile=${JSON.stringify(v1.file)};window.__catalog=[${row(v1)}];await window.venus.invoke('settings:set',{extensions:{catalog:true}});const {store}=await import('./js/store.js');await store.refreshSettings();location.hash='#/extensions/catalog';})()`,
    `extensions/catalog|(async()=>{${wait(600)}${log('catalog', `{rows:document.querySelectorAll('.xt-item').length,name:document.querySelector('.xt-item strong')&&document.querySelector('.xt-item strong').textContent,sub:document.querySelectorAll('.xt-sub').length}`)}${clickBtn('/^Instalar$/')};${wait(900)}${log('install-dialog', `{open:!!document.querySelector('.modal'),text:document.querySelector('.modal')&&document.querySelector('.modal').textContent.slice(0,260),noWarning:!document.querySelector('.modal .notice.bad')}`)}})()`,
    // Instalar desde el diálogo: queda apagada
    `extensions/catalog|(async()=>{${clickBtn('/^Instalar$/', "document.querySelector('.modal-foot')")};${wait(900)}const l=await window.venus.invoke('extensions:list');${log('installed', '{count:l.items.length,enabled:l.items[0]&&l.items[0].enabled,source:l.items[0]&&l.items[0].source,sha:l.items[0]&&l.items[0].sha256}')}})()`,
    // sha-256 que no coincide: no se instala
    `extensions/catalog|(async()=>{let code='';try{const r=await window.venus.invoke('extensions:readForSubmit',${JSON.stringify(v2.file)});await window.venus.invoke('extensions:inspectBytes',r.bytes,{sha256:'${'0'.repeat(64)}'});}catch(e){code=e.code}${log('sha-mismatch', 'code')}let code2='';try{const r=await window.venus.invoke('extensions:readForSubmit',${JSON.stringify(v2.file)});await window.venus.invoke('extensions:inspectBytes',r.bytes,{id:'otra-cosa'});}catch(e){code2=e.code}${log('id-mismatch', 'code2')}})()`,
    // Actualización con más permisos: el diálogo lo marca y el proceso principal exige aceptarlos
    `extensions/installed|(async()=>{const s=await window.venus.invoke('extensions:inspectFile',${JSON.stringify(v2.file)});const m=await import('./js/features/extensions/install-dialog.js');window.__dlg=m.openInstallDialog(s);window.__stage=s;${wait(500)}${log('update-dialog', `{added:s.addedPermissions,newPills:document.querySelectorAll('.modal .xt-perm.new').length,warn:!!document.querySelector('.modal .notice.bad'),disabled:document.querySelector('.modal-foot .btn.primary').disabled}`)}})()`,
    // Sin la casilla de riesgo no se puede. Con menos permisos aceptados, el proceso principal dice que no.
    `extensions/installed|(async()=>{let code='';try{await window.venus.invoke('extensions:install',window.__stage.stageId,{accepted:['storage']})}catch(e){code=e.code}${log('update-without-accept', 'code')}const c=document.querySelector('.modal .xt-check input');c.click();${wait(100)}${log('update-check', "document.querySelector('.modal-foot .btn.primary').disabled")}${clickBtn('/^Actualizar$/', "document.querySelector('.modal-foot')")};${wait(900)}const l=await window.venus.invoke('extensions:list');${log('updated', '{version:l.items[0].version,permissions:l.items[0].permissions}')}})()`,
    // Lista de bloqueadas por el cliente falso: se apaga
    `extensions/installed|(async()=>{await window.venus.invoke('extensions:setEnabled','demo-ext',true);window.__blocklist={ids:['demo-ext'],hashes:[]};const m=await import('./js/features/extensions.js');await m.checkCatalog();${wait(500)}const l=await window.venus.invoke('extensions:list');${log('blocklist', `{enabled:l.items[0].enabled,blocked:l.items[0].blocked,toast:!!document.querySelector('.toast.bad'),calls:window.__calls.filter(c=>c.name==='extension_blocklist').length}`)}window.__blocklist={ids:[],hashes:[]};await m.checkCatalog();})()`,
    // Envío: valida, llama a la RPC y sube sin reemplazar
    `extensions/catalog|(async()=>{${wait(500)}const c=await import('./js/pages/extensions/catalog.js');const btn=document.createElement('button');document.body.append(btn);const p=c.submitPackage(btn,null,${JSON.stringify(example)});${wait(500)}${clickBtn('/^Mandar$/', "document.querySelector('.modal-foot')")};await p;const calls=window.__calls.filter(x=>x.name==='extension_submit'||x.name==='upload');${log('submit', `calls.map(x=>({name:x.name,upsert:x.upsert,type:x.type,bucket:x.bucket,hasManifest:!!(x.args&&x.args.p_manifest),id:x.args&&x.args.p_id,sha:x.args&&x.args.p_sha256&&x.args.p_sha256.length}))`)}btn.remove();window.__submitError='too_many_today';const b2=document.createElement('button');document.body.append(b2);const p2=c.submitPackage(b2,null,${JSON.stringify(example)});${wait(500)}${clickBtn('/^Mandar$/', "document.querySelector('.modal-foot')")};await p2;${wait(200)}${log('submit-error', `[...document.querySelectorAll('.toast.bad')].map(t=>t.textContent).pop()`)}b2.remove();window.__submitError=null;})()`,
    // Panel de administración con el cliente falso: lista, contenido como texto y aprobar
    `admin/extensions|(async()=>{window.__downloadFile=${JSON.stringify(example)};const s=await window.venus.invoke('extensions:readForSubmit',${JSON.stringify(example)});window.__admin=[{versionId:'v1',id:s.manifest.id,name:s.manifest.name,author:s.manifest.author,description:s.manifest.description,version:s.manifest.version,status:'pending',extensionStatus:'pending',permissions:s.manifest.permissions,manifest:s.manifest,sha256:s.sha256,sizeBytes:s.size,path:'u/x/1.venusext',uploaded:true,at:new Date().toISOString(),submitter:{id:'u',username:'alguien',displayName:'Alguien'}}];location.hash='#/home';${wait(300)}location.hash='#/admin/extensions';})()`,
    `admin/extensions|(async()=>{${wait(1200)}${log('admin-list', `{rows:document.querySelectorAll('.xt-item').length,title:document.querySelector('.adm-panel:not([hidden]) .page-title')&&document.querySelector('.adm-panel:not([hidden]) .page-title').textContent}`)}${clickBtn('/Ver contenido/')};${wait(1000)}const pre=document.querySelector('.xt-rev-code');${log('admin-review', `{open:!!pre,files:document.querySelectorAll('.xt-rev-file').length,iframes:document.querySelectorAll('.modal iframe').length,scripts:document.querySelectorAll('.modal script').length,hasManifest:pre&&pre.textContent.includes('notas-de-partida')}`)}[...document.querySelectorAll('.xt-rev-file')].find(b=>/index\\.html/.test(b.textContent)).click();${wait(100)}${log('admin-html-as-text', `{tags:document.querySelectorAll('.modal .xt-rev-code')[1].children.length,text:document.querySelectorAll('.modal .xt-rev-code')[1].textContent.slice(0,40)}`)}})()`,
    `admin/extensions|(async()=>{${clickBtn('/^Aprobar$/', "document.querySelector('.modal-foot')")};${wait(400)}const boxes=[...document.querySelectorAll('.modal-foot')];const b=[...boxes[boxes.length-1].querySelectorAll('button')].find(x=>/^Aprobar$/.test(x.textContent));b&&b.click();${wait(600)}${log('admin-approve', `window.__calls.filter(c=>c.name==='admin_extension_review').map(c=>c.args)`)}})()`,
  ].join(';;');
}

async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(path.join(DATA, 'instances', 'mi-instancia'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'instances', 'mi-instancia', 'venus-instance.json'), JSON.stringify({ name: 'Instancia de prueba', mcVersion: '1.21.4', loader: 'fabric', loaderVersion: '0.16.0' }));
  const v1 = pkgFile('v1.venusext', {});
  const v2 = pkgFile('v2.venusext', { version: '1.1.0', permissions: ['storage', 'read.instances', 'action.launchInstance'] });
  const exampleFile = path.join(BASE, 'ejemplo.venusext');
  fs.writeFileSync(exampleFile, packFolder(path.join(ROOT, 'docs', 'extensiones-ejemplo')).buffer);
  const env = { ...process.env, VENUS_DATA_DIR: DATA, VENUS_DEVSHOT: SHOTS, VENUS_SKIP_ONBOARDING: '1', VENUS_DEVSHOT_WAIT: '1500', VENUS_ADMIN_FAKE: '1', VENUS_DEVSHOT_ROUTES: `home|import('./js/features/admin.js').then((m) => m.startup());0;;${routes(v1, v2, exampleFile.split(path.sep).join('/'))}` };
  delete env.ELECTRON_RUN_AS_NODE;
  const electron = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const code = await new Promise((resolve) => {
    const child = spawn(`"${electron}" .`, { cwd: ROOT, env, shell: true, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill();
      resolve(99);
    }, 300000);
    child.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  const lines = fs.existsSync(path.join(SHOTS, 'console.log')) ? fs.readFileSync(path.join(SHOTS, 'console.log'), 'utf8').split('\n') : [];
  console.log(`exit ${code}. Carpeta: ${BASE}`);
  for (const line of lines) {
    const m = /\[UI\] (\{.*\}) \(/.exec(line);
    if (m) console.log(m[1]);
    else if (/\[error\]|\[js-error\]|\[warning\]/.test(line)) console.log(`  CONSOLA: ${line.slice(0, 220)}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
