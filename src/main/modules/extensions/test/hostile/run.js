'use strict';
// Prueba real: abre el launcher en Electron con extensiones hostiles y anota qué logró cada intento.
// Uso: node src/main/modules/extensions/test/hostile/run.js <carpeta temporal>
// Nunca toca los datos reales: usa VENUS_DATA_DIR y VENUS_DEVSHOT. Unos detectores locales (HTTP, TCP y UDP) son la
// prueba de que no salió nada a la red. Deja resultados.json y las capturas en la carpeta temporal.
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const dgram = require('dgram');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');
const { readPackage } = require('../../package');

const ROOT = path.join(__dirname, '..', '..', '..', '..', '..', '..');
const BASE = path.resolve(process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), 'venus-hostile-')));
const DATA = path.join(BASE, 'data');
const SHOTS = path.join(BASE, 'shots');
const PKGS = path.join(BASE, 'pkgs');

const MANIFEST = (id, name, permissions, extra = {}) =>
  JSON.stringify({ manifestVersion: 1, id, name, version: '1.0.0', author: 'Prueba hostil', description: 'Extensión hostil de prueba', minLauncherVersion: '3.0.0', permissions, entry: 'index.html', ...extra });

const HTML = (script, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>x</title><link rel="stylesheet" href="s.css"></head><body><h1>hostil</h1>${extra}<script src="config.js"></script><script src="${script}"></script></body></html>`;

function pack(id, files) {
  const zip = new AdmZip();
  for (const [name, data] of Object.entries(files)) zip.addFile(name, Buffer.from(data));
  const buffer = zip.toBuffer();
  readPackage(buffer); // tiene que ser un paquete válido: lo hostil es lo que hace al correr
  const file = path.join(PKGS, `${id}.venusext`);
  fs.writeFileSync(file, buffer);
  return file.split(path.sep).join('/');
}

const VICTIM_SCRIPT = `window.__secret='de la víctima';parent.postMessage({venus:1,id:'victima-corrio',method:'storage.set',params:{key:'pwned',value:'corrió adentro de otro marco'}},'*');`;
const LOOP_SCRIPT = `setTimeout(function(){for(;;){}},300);`;
const FLOOD_SCRIPT = `window.addEventListener('message',function(){for(var i=0;i<6000;i++)parent.postMessage({venus:1,id:i,method:'game.state'},'*');});`;
const BIG_SCRIPT = `window.addEventListener('message',function(){var s=new Array(200*1024*1024).join('x');var n=0;var t=setInterval(function(){parent.postMessage({venus:1,id:n++,method:'notify.show',params:{title:s}},'*');if(n>5)clearInterval(t);},300);});`;
// Con todos los permisos: lo que pide y lo que hace con la respuesta
const ALL_SCRIPT = `(function(){var seq=0,w=new Map(),log=[];window.addEventListener('message',function(e){if(e.source!==parent)return;var m=e.data;if(m&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
function ask(method,params,to){return new Promise(function(res){var id=++seq;w.set(id,res);parent.postMessage({venus:1,id:id,method:method,params:params},'*');setTimeout(function(){if(w.delete(id))res({timeout:true});},to||1500);});}
window.addEventListener('message',async function once(e){if(!e.data||e.data.type!=='hello')return;window.removeEventListener('message',once);
var r=await ask('instances.list');log.push(['instances.list',r]);
r=await ask('game.state');log.push(['game.state',r]);
for(var route of ['settings','admin','messages','settings/cloud','extensions']){r=await ask('launcher.openPage',{route:route});log.push(['openPage '+route,r]);}
await ask('storage.set',{key:'phase1',value:log},3000);
var p3=await ask('launcher.launchInstance',{instanceId:'no-existe'},3000);log.push(['launch missing',p3]);
var p1=ask('launcher.launchInstance',{instanceId:'mi-instancia'},60000);var p2=await ask('launcher.launchInstance',{instanceId:'mi-instancia'},3000);log.push(['launch second while pending',p2]);
await ask('storage.set',{key:'phase2',value:log},3000);
var first=await p1;log.push(['launch first (la prueba responde No)',first]);
await ask('storage.set',{key:'phase3',value:log},3000);
})})();`;
// action.openPage: sin que la persona esté usando la extensión no navega; con el foco adentro, sí
const OPEN_SCRIPT = `(function(){var seq=0,w=new Map();window.addEventListener('message',function(e){if(e.source!==parent)return;var m=e.data;if(m&&w.has(m.id)){w.get(m.id)(m);w.delete(m.id);}});
function ask(method,params){return new Promise(function(res){var id=++seq;w.set(id,res);parent.postMessage({venus:1,id:id,method:method,params:params},'*');});}
window.addEventListener('message',async function once(e){if(!e.data||e.data.type!=='hello')return;window.removeEventListener('message',once);
var a=await ask('launcher.openPage',{route:'stats'});await ask('storage.set',{key:'nofocus',value:a});
await new Promise(function(r){setTimeout(r,6000)});
var b=await ask('launcher.openPage',{route:'stats'});await ask('storage.set',{key:'focus',value:b});
})})();`;
const CARD_SCRIPT = `document.documentElement.style.height='5000px';document.body.style.height='5000px';document.body.style.width='5000px';try{window.resizeTo(4000,4000)}catch(e){}`;

function build(ports) {
  fs.mkdirSync(PKGS, { recursive: true });
  const config = `window.__CFG=${JSON.stringify({ ...ports, stage: 0 })};`;
  const hostileJs = fs.readFileSync(path.join(__dirname, 'hostile.js'), 'utf8');
  const css = 'body{background:#311;color:#fee;font:13px sans-serif}';
  return {
    hostile: pack('hostile', { 'manifest.json': MANIFEST('hostile', 'Hostil', ['storage', 'notify']), 'index.html': HTML('hostile.js', '<script src="venus-ext://hostile-victim/secret.js"></script><link rel="preconnect" href="http://127.0.0.1:' + ports.tcp + '/"><link rel="dns-prefetch" href="http://hostile-dns.invalid/"><img src="http://127.0.0.1:' + ports.http + '/static-img">'), 'config.js': config, 'hostile.js': hostileJs, 'app.js': '1', 's.css': css }),
    victim: pack('hostile-victim', { 'manifest.json': MANIFEST('hostile-victim', 'Victima', ['storage']), 'index.html': HTML('secret.js'), 'config.js': config, 'secret.js': VICTIM_SCRIPT, 's.css': css }),
    all: pack('hostile-all', { 'manifest.json': MANIFEST('hostile-all', 'Con todos los permisos', ['storage', 'notify', 'read.instances', 'read.gameState', 'action.openPage', 'action.launchInstance'], { homeCard: 'card.html' }), 'index.html': HTML('all.js'), 'card.html': HTML('card.js'), 'config.js': config, 'all.js': ALL_SCRIPT, 'card.js': CARD_SCRIPT, 's.css': css }),
    loop: pack('hostile-loop', { 'manifest.json': MANIFEST('hostile-loop', 'Bucle', []), 'index.html': HTML('loop.js'), 'config.js': config, 'loop.js': LOOP_SCRIPT, 's.css': css }),
    flood: pack('hostile-flood', { 'manifest.json': MANIFEST('hostile-flood', 'Inundar', ['read.gameState']), 'index.html': HTML('flood.js'), 'config.js': config, 'flood.js': FLOOD_SCRIPT, 's.css': css }),
    open: pack('hostile-open', { 'manifest.json': MANIFEST('hostile-open', 'Abrir paginas', ['storage', 'action.openPage']), 'index.html': HTML('open.js'), 'config.js': config, 'open.js': OPEN_SCRIPT, 's.css': css }),
    big: pack('hostile-big', { 'manifest.json': MANIFEST('hostile-big', 'Mensajes enormes', ['notify']), 'index.html': HTML('big.js'), 'config.js': config, 'big.js': BIG_SCRIPT, 's.css': css }),
  };
}

// ---------- Lo que corre en la ventana ----------
const q = (s) => JSON.stringify(s);
function harness(pkgs) {
  const log = (label, value) => `console.warn('[HOSTIL] '+JSON.stringify({label:${q(label)},value:${value}}));`;
  const install = `(async()=>{const v=window.venus;for(const f of ${q(Object.values(pkgs))}){const s=await v.invoke('extensions:inspectFile',f);await v.invoke('extensions:install',s.stageId,{accepted:s.manifest.permissions,homeCard:Boolean(s.manifest.homeCard)});await v.invoke('extensions:setEnabled',s.manifest.id,true);}await v.invoke('extensions:storage','hostile','set','stage',0);window.__toastLog=[];new MutationObserver((ms)=>{for(const x of ms)for(const n of x.addedNodes)if(n.nodeType===1)window.__toastLog.push({text:n.textContent.slice(0,200),tags:n.querySelectorAll('img,script,b').length});}).observe(document.getElementById('toasts'),{childList:true});const m=await import('./js/features/extensions.js');await m.refreshExtensions();${log('instalado', 'true')}})();0`;
  const waitDone = (stage) => `(async()=>{const v=window.venus;for(let i=0;i<300;i++){const d=await v.invoke('extensions:storage','hostile','get','done${stage}');if(d)break;await new Promise(r=>setTimeout(r,200));}await new Promise(r=>setTimeout(r,1500));const res=await v.invoke('extensions:storage','hostile','get','results${stage}');${log(`results${stage}`, 'res')}${log(`parent${stage}`, `{hash:location.hash,pwned:window.__pwned===undefined?null:window.__pwned,venus:typeof window.venus,focus:document.activeElement&&document.activeElement.tagName,stopped:!!document.querySelector('.xt-stopped'),iframes:document.querySelectorAll('iframe').length,victimPwned:await v.invoke('extensions:storage','hostile','get','pwned'),toasts:window.__toastLog.splice(0)}`)}})()`;
  const setStage = (stage) => `window.venus.invoke('extensions:storage','hostile','set','stage',${stage});0`;
  const routes = [
    `extensions|${install}`,
    `ext-hostile|${waitDone(0)}`,
    `extensions|${setStage(1)}`,
    `ext-hostile|${waitDone(1)}`,
    `extensions|${setStage(2)}`,
    `ext-hostile|${waitDone(2)}`,
    `extensions|${setStage(3)}`,
    `ext-hostile|${waitDone(3)}`,
    `extensions|${setStage(4)}`,
    `ext-hostile|${waitDone(4)}`,
    `extensions|${setStage(5)}`,
    `ext-hostile|${waitDone(5)}`,
    // La guardia de foco: si el iframe recibe el foco sin clic ni Tab, se lo saca
    `ext-hostile|(async()=>{const f=document.querySelector('iframe');f.focus();await new Promise(r=>setTimeout(r,500));${log('focus-guard', 'document.activeElement.tagName')}})()`,
    ...[6, 7, 8, 9, 10, 11, 12].flatMap((n) => [`extensions|${setStage(n)}`, `ext-hostile|${waitDone(n)}`]),
    // Recargar desde la franja vuelve a abrir una extensión detenida
    `extensions|${setStage(2)}`,
    `ext-hostile|(async()=>{await new Promise(r=>setTimeout(r,2500));const st=!!document.querySelector('.xt-stopped');document.querySelector('.xt-bar button').click();await new Promise(r=>setTimeout(r,120));${log('reload-button', '{wasStopped:st,iframes:document.querySelectorAll("iframe").length}')}await window.venus.invoke('extensions:storage','hostile','set','stage',5);})()`,
    // El marco de la víctima nunca corrió en el de otra extensión
    `extensions|(async()=>{const v=window.venus;${log('victim-storage', "await v.invoke('extensions:storage','hostile-victim','keys')")}})()`,
    // Todos los permisos: lanzar pide confirmación, y la prueba contesta que no
    `ext-hostile-all|(async()=>{await new Promise(r=>setTimeout(r,4000));const v=window.venus;${log('all-phase2', "await v.invoke('extensions:storage','hostile-all','get','phase2')")}const dlg=document.querySelector('.modal');${log('all-dialog', "{open:!!dlg,text:dlg&&dlg.textContent.slice(0,200),running:Object.keys((await import('./js/store.js')).store.running)}")}const no=[...document.querySelectorAll('.modal .btn')].find(b=>/No abrir|Do not open/.test(b.textContent));no&&no.click();await new Promise(r=>setTimeout(r,800));${log('all-phase3', "await v.invoke('extensions:storage','hostile-all','get','phase3')")}${log('all-running', "Object.keys((await import('./js/store.js')).store.running)")}})()`,
    // action.openPage: sin foco no navega; con el foco adentro (como un clic) abre una página de la lista
    `ext-hostile-open|(async()=>{const v=window.venus;await new Promise(r=>setTimeout(r,300));${log('open-nofocus', "await v.invoke('extensions:storage','hostile-open','get','nofocus')")}window.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab'}));document.querySelector('iframe').focus();${log('open-active', 'document.activeElement.tagName')}await new Promise(r=>setTimeout(r,5500));${log('open-focus', "{reply:await v.invoke('extensions:storage','hostile-open','get','focus'),hash:location.hash}")}})()`,
    // Tarjeta en Inicio: tamaño fijo aunque la extensión pida otra cosa
    `home|(async()=>{await new Promise(r=>setTimeout(r,2500));const f=document.querySelector('.xt-card');const b=f&&f.querySelector('.xt-body').getBoundingClientRect();const i=f&&f.querySelector('iframe').getBoundingClientRect();${log('card', '{exists:!!f,width:f&&f.offsetWidth,bodyH:b&&b.height,iframeH:i&&i.height,count:document.querySelectorAll(".xt-card").length,tag:f&&f.querySelector(".xt-tag").textContent}')}f&&f.scrollIntoView();})()`,
    // Bucle infinito: el launcher sigue respondiendo
    `ext-hostile-loop|(async()=>{let worst=0;let last=performance.now();const end=last+4000;while(performance.now()<end){await new Promise(r=>setTimeout(r,50));const n=performance.now();worst=Math.max(worst,n-last-50);last=n;}${log('loop', '{worstDelayMs:Math.round(worst),iframes:document.querySelectorAll("iframe").length}')}})()`,
    // Inundación de mensajes
    `ext-hostile-flood|(async()=>{let worst=0;let last=performance.now();const end=last+4000;while(performance.now()<end){await new Promise(r=>setTimeout(r,50));const n=performance.now();worst=Math.max(worst,n-last-50);last=n;}${log('flood', '{worstDelayMs:Math.round(worst),stopped:!!document.querySelector(".xt-stopped"),iframes:document.querySelectorAll("iframe").length,text:document.querySelector(".xt-stopped")&&document.querySelector(".xt-stopped").textContent}')}})()`,
    // Mensajes enormes
    `ext-hostile-big|(async()=>{let worst=0;let last=performance.now();const end=last+8000;while(performance.now()<end){await new Promise(r=>setTimeout(r,50));const n=performance.now();worst=Math.max(worst,n-last-50);last=n;}${log('big', '{worstDelayMs:Math.round(worst),stopped:!!document.querySelector(".xt-stopped"),iframes:document.querySelectorAll("iframe").length}')}})()`,
    // Modo seguro: nada se sirve
    `extensions|(async()=>{const v=window.venus;await v.invoke('extensions:setSafeMode',true);const m=await import('./js/features/extensions.js');await m.refreshExtensions();location.hash='#/ext-hostile';await new Promise(r=>setTimeout(r,1200));${log('safe', '{hash:location.hash,iframes:document.querySelectorAll("iframe").length,nav:document.querySelectorAll(".xt-nav").length}')}let denied='';try{await v.invoke('extensions:openSession','hostile','page')}catch(e){denied=e.code}${log('safe-session', 'denied')}await v.invoke('extensions:setSafeMode',false);})()`,
    // Bloqueada: se apaga aunque esté prendida
    `extensions|(async()=>{const v=window.venus;const before=(await v.invoke('extensions:list')).items.find(x=>x.id==='hostile');const off=await v.invoke('extensions:applyBlocklist',{ids:['hostile'],hashes:[]});const after=(await v.invoke('extensions:list')).items.find(x=>x.id==='hostile');let again='';try{await v.invoke('extensions:setEnabled','hostile',true)}catch(e){again=e.code}${log('blocked', '{before:before.enabled,off,after:after.enabled,blocked:after.blocked,again}')}await v.invoke('extensions:applyBlocklist',{ids:[],hashes:[]});})()`,
    // Desinstalar borra los datos
    `extensions|(async()=>{const v=window.venus;await v.invoke('extensions:uninstall','hostile-victim');let code='';try{await v.invoke('extensions:storage','hostile-victim','keys')}catch(e){code=e.code}${log('uninstall', 'code')}})()`,
  ];
  return routes.join(';;');
}

// ---------- Detectores ----------
function detectors() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ kind: 'http', path: req.url });
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end('ok');
  });
  server.on('upgrade', (req, socket) => {
    hits.push({ kind: 'ws', path: req.url });
    socket.destroy();
  });
  const tcp = net.createServer((socket) => {
    hits.push({ kind: 'tcp', path: 'preconnect' });
    socket.destroy();
  });
  const udp = dgram.createSocket('udp4');
  udp.on('message', () => hits.push({ kind: 'udp', path: 'stun' }));
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      tcp.listen(0, '127.0.0.1', () => {
        udp.bind(0, '127.0.0.1', () => {
          resolve({
            hits,
            ports: { http: server.address().port, tcp: tcp.address().port, udp: udp.address().port },
            close() {
              server.close();
              tcp.close();
              udp.close();
            },
          });
        });
      });
    });
  });
}

// ---------- Correr ----------
async function main() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'instances', 'mi-instancia'), { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'instances', 'mi-instancia', 'venus-instance.json'), JSON.stringify({ name: 'Instancia de prueba', mcVersion: '1.21.4', loader: 'fabric', loaderVersion: '0.16.0' }));
  const det = await detectors();
  const pkgs = build(det.ports);
  const electron = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  const env = { ...process.env, VENUS_DATA_DIR: DATA, VENUS_DEVSHOT: SHOTS, VENUS_SKIP_ONBOARDING: '1', VENUS_DEVSHOT_WAIT: '2500', VENUS_DEVSHOT_ROUTES: harness(pkgs) };
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise((resolve) => {
    const child = spawn(`"${electron}" .`, { cwd: ROOT, env, shell: true, stdio: 'ignore', windowsHide: false });
    const timer = setTimeout(() => {
      console.error('La prueba tardó demasiado: el launcher pudo haberse colgado.');
      child.kill();
      resolve(99);
    }, 420000);
    child.on('exit', (c) => {
      clearTimeout(timer);
      resolve(c);
    });
  });
  await new Promise((r) => setTimeout(r, 1500));
  det.close();

  const logFile = path.join(SHOTS, 'console.log');
  const lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n') : [];
  const out = {};
  for (const line of lines) {
    const m = /\[HOSTIL\] (\{.*\}) \(/.exec(line);
    if (!m) continue;
    try {
      const { label, value } = JSON.parse(m[1]);
      out[label] = value;
    } catch {
      /* línea cortada */
    }
  }
  const refused = lines.filter((l) => !l.includes('[HOSTIL]') && /Framing|Not allowed to load local|Unsafe attempt to initiate navigation|Running the JavaScript URL/i.test(l)).map((l) => l.slice(0, 170));
  const report = { exit: code, ports: det.ports, networkHits: det.hits, out, refused, otherErrors: lines.filter((l) => /\[error\]|\[js-error\]/.test(l) && !/Content Security Policy|Content-Security-Policy|Trusted Type|sandbox|Blocked|blocked|ERR_|net::/i.test(l)).slice(0, 40) };
  fs.writeFileSync(path.join(BASE, 'resultados.json'), JSON.stringify(report, null, 2));

  console.log(`exit ${code}. Carpeta: ${BASE}`);
  console.log(`\nPedidos que llegaron a los detectores de red: ${det.hits.length}`);
  for (const h of det.hits) console.log(`  ${h.kind} ${h.path}`);
  for (const key of Object.keys(out).filter((k) => /^results/.test(k))) {
    console.log(`\n== ${key}`);
    // Etapas 1 a 4: la página navega y se muere. Lo que importa es que el launcher cortó el marco.
    const stage = Number(key.slice(7));
    const died = stage >= 1 && stage !== 5 ? out[`parent${stage}`]?.stopped === true : false;
    for (const r of out[key] || []) {
      const blocked = r.blocked || died;
      console.log(`  ${blocked ? 'BLOQUEADO' : 'LOGRADO  '} ${r.name}${died ? ' -> el launcher detuvo el marco' : r.detail ? ` -> ${r.detail}` : ''}`);
    }
  }
  for (const key of Object.keys(out).filter((k) => !/^results/.test(k))) console.log(`\n${key}: ${JSON.stringify(out[key])}`);
  console.log(`\nNavegaciones que frenó la política de la ventana o el navegador (${refused.length}):`);
  for (const l of [...new Set(refused)].slice(0, 20)) console.log(`  ${l}`);
  if (report.otherErrors.length) console.log(`\nOtros errores de la consola:\n${report.otherErrors.join('\n')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
