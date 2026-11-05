import test from 'node:test';
import assert from 'node:assert/strict';
import { uiHarness, deferred, flush } from './ui-harness.js';

const rootTopic = {id:'topic',channelId:'forum',communityId:'community',title:'Proyecto',body:'Mensaje raíz',authorId:'other',at:'2026-11-01T12:00:00Z',author:{userId:'other',displayName:'Persona'}};
const c={id:'community',myRole:'member',name:'Prueba'};
const ch={id:'forum',kind:'forum',name:'ideas',canPost:true,slowmodeSeconds:30,postingRole:'members'};
function setup({rpc,topic=rootTopic,channel=ch,community=c}={}) {
  const ui=uiHarness(),calls=[];let watcher,stops=0;
  const b={userId:()=> 'me',isBlocked:()=>false,
    rpc:async(name,args)=>{calls.push({name,args});return rpc?rpc(name,args):[];},
    watchChannel:(_id,handlers)=>{watcher=handlers;return()=>stops++;}};
  const {chatView}=ui.load('chat.js',{},['chatView']);
  const chat=chatView(ui.root,{b,community,channel,people:new Map([['other',rootTopic.author]]),topic,onBack:()=>{}});
  return {...ui,calls,chat,watch:()=>watcher,stops:()=>stops,input:ui.find('cm-input'),send:ui.find('cm-send')};
}
test('responder un tema usa RPC de replies y no mezcla eventos de otro hilo', async () => {
  const ui=setup({rpc:async(name,args)=>name==='community_forum_reply'?{id:'reply',parentId:'topic',authorId:'me',at:new Date().toISOString(),body:args.p_body}:[]});
  await flush();
  assert.equal(ui.calls[0].name,'community_forum_replies');
  assert.equal(ui.calls[0].args.p_topic,'topic');
  ui.watch().onRow({id:'wrong',channel_id:'forum',parent_id:'another-topic',author:'other',created_at:'2026-11-01',body:'No corresponde'});
  assert.equal(ui.nodes.filter(n=>n.dataset.id==='wrong').length,0);
  ui.input.value='Respuesta local';
  await ui.send.fire('click');
  assert.equal(ui.calls.find(call=>call.name==='community_forum_reply').args.p_topic,'topic');
  assert.equal(ui.input.value,'');assert.equal(ui.send.disabled,true,'slowmode luego de publicar');
  ui.chat.destroy();assert.equal(ui.intervals.size,0);assert.equal(ui.stops(),1);
});
test('borrar raíz durante carga no revive respuestas y bloquea formulario', async () => {
  const pending=deferred(),ui=setup({rpc:()=>pending.promise});
  ui.watch().onRow({id:'topic',channel_id:'forum',author:'other',deleted:true});
  pending.resolve([{id:'late',parentId:'topic',body:'respuesta tardía',authorId:'other',at:'2026-11-01'}]);
  await flush();
  assert.equal(ui.input.disabled,true);assert.equal(ui.send.disabled,true);
  assert.equal(ui.nodes.filter(n=>n.dataset.id==='late'&&n.isConnected).length,0);
  assert.equal(ui.nodes.find(n=>n.hasClass('cm-chat-heading')&&n.isConnected).children[0].children[0],'communities.cmTopicDeleted');
  ui.chat.destroy();
});
test('thread_deleted al consultar deshabilita responder aunque Realtime esté activo', async () => {
  const ui=setup({rpc:async()=>{throw {code:'thread_deleted'};}});
  await flush();
  assert.equal(ui.input.disabled,true);assert.equal(ui.send.disabled,true);
  ui.input.value='tarde';await ui.send.fire('click');
  assert.equal(ui.calls.length,1);
  ui.chat.destroy();
});
test('anuncios y publicación staff no permiten enviar desde Enter a un miembro', async () => {
  const ui=setup({topic:null,channel:{...ch,kind:'announcement',postingRole:'staff',canPost:false}});
  await flush();
  ui.input.value='hola';await ui.input.fire('keydown',{key:'Enter'});
  assert.equal(ui.calls.filter(call=>call.name==='community_send').length,0);
  assert.equal(ui.input.disabled,true);
  ui.chat.setCommunity({...c,myRole:'moderator'},{...ch,kind:'announcement',postingRole:'staff',canPost:true});
  assert.equal(ui.input.disabled,false);
  ui.chat.destroy();
});
test('slowmode rechazado conserva borrador y adopta nextPostAt del servidor', async () => {
  const ui=setup({rpc:async(name)=>{if(name==='community_forum_reply')throw {code:'slowmode',nextPostAt:new Date(Date.now()+50000).toISOString()};return [];}});
  await flush();ui.input.value='Borrador';await ui.send.fire('click');
  assert.equal(ui.input.value,'Borrador');assert.equal(ui.send.disabled,true);assert.equal(ui.input.disabled,false);
  await ui.input.fire('keydown',{key:'Enter'});
  assert.equal(ui.calls.filter(call=>call.name==='community_forum_reply').length,1);
  ui.chat.destroy();
});
test('lista de foro pagina, abre hilos, publica una vez y limpia listeners al salir', async () => {
  const ui=uiHarness(),calls=[],chats=[],pending=deferred();let stops=0;
  const rows=Array.from({length:30},(_,i)=>({...rootTopic,id:'topic-'+i,at:new Date(Date.UTC(2026,10,1,12,i)).toISOString()}));
  const b={userId:()=> 'me',rpc:async(name,args)=>{calls.push({name,args});
    if(name==='community_forum_topic_create')return pending.promise;
    return args.p_before?[]:rows;
  },watchChannel:()=>()=>stops++};
  const {forumView}=ui.load('forum.js',{chatView:(_host,options)=>{const chat={options,destroy(){},setCommunity(){}};chats.push(chat);return chat;}},['forumView']);
  const view=forumView(ui.root,{b,community:c,channel:ch,people:new Map()});
  await flush();
  assert.equal(ui.find('cm-topics-more').hidden,false);
  await ui.find('cm-topics-more').fire('click');await flush();
  assert.equal(calls.at(-1).args.p_before,rows[0].at);
  await ui.find('cm-new-topic').fire('click');
  ui.nodes.find(n=>n.id==='cm-topic-title').value='Nueva construcción';
  ui.nodes.find(n=>n.id==='cm-topic-body').value='Mensaje del tema';
  const save=ui.find('cm-topic-publish');
  save.fire('click');save.fire('click');
  assert.equal(calls.filter(call=>call.name==='community_forum_topic_create').length,1);
  pending.resolve({...rootTopic,id:'created',title:'Nueva construcción'});await flush();
  assert.equal(chats.at(-1).options.topic.id,'created');
  view.destroy();assert.equal(ui.intervals.size,0);assert.equal(stops,1);
});
test('respuesta tardía de lista no reemplaza el hilo ya abierto', async () => {
  const ui=uiHarness(),pending=deferred();let calls=0,opened=0;
  const b={userId:()=> 'me',rpc:async()=>++calls===1?[rootTopic]:pending.promise,watchChannel:()=>()=>{}};
  const {forumView}=ui.load('forum.js',{chatView:()=>{opened++;return{destroy(){},setCommunity(){}};}},['forumView']);
  const view=forumView(ui.root,{b,community:c,channel:ch,people:new Map()});await flush();
  const first=ui.find('cm-topic-card');
  for(const fn of ui.intervals.values())fn();
  await first.fire('click');pending.resolve([]);await flush();
  assert.equal(opened,1);
  view.destroy();
});

test('respuesta enviada antes del borrado no repuebla el hilo al llegar tarde', async () => {
  const pending=deferred(),ui=setup({rpc:(name)=>name==='community_forum_reply'?pending.promise:Promise.resolve([])});
  await flush();ui.input.value='respuesta';ui.send.fire('click');
  ui.watch().onRow({id:'topic',channel_id:'forum',author:'other',deleted:true});
  pending.resolve({id:'late-send',parentId:'topic',authorId:'me',body:'respuesta',at:new Date().toISOString()});await flush();
  assert.equal(ui.nodes.filter(n=>n.dataset.id==='late-send'&&n.isConnected).length,0);
  assert.equal(ui.send.disabled,true);ui.chat.destroy();
});
