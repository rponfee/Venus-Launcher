// Tarjeta del proyecto: carpeta, herramienta de build, jar de salida, datos del plugin y avisos.
import { h, icon, mount, fmtBytes, fmtAgo, copyText, modal, fail, ok, setBusy } from '../../ui.js';
import { api } from '../../store.js';
import { t } from '../../i18n.js';
import { fact, iconBtn, tile, ADOPTIUM_URL } from './common.js';

// Valores con variables del build sin procesar (${version}, @version@) no se muestran como datos reales.
const tpl = (v) => typeof v === 'string' && /\$\{[^}]*\}|@[\w.-]+@/.test(v);

function toolLabel(p) {
  const d = p.detect;
  if (!d.tool) return t('devmode.noTool');
  const name = d.tool === 'maven' ? 'Maven' : 'Gradle';
  const version = d.tool === 'gradle' && d.gradle?.version ? ` ${d.gradle.version}` : '';
  if (!d.runner) return t('devmode.toolNoRunner', { tool: `${name}${version}` });
  return t(d.runner.kind === 'wrapper' ? 'devmode.toolWrapper' : 'devmode.toolSystem', { tool: `${name}${version}`, runner: d.runner.display });
}

export function pluginDisplayName(p) {
  const plug = p.plugin;
  return plug?.name && !tpl(plug.name) ? plug.name : p.name;
}

async function pickJar(ctx) {
  const files = await api.app.selectFiles({ title: t('devmode.pickJarTitle'), filters: [{ name: 'Jar', extensions: ['jar'] }] }).catch(() => []);
  if (!files?.length) return;
  await ctx.update({ jar: { path: files[0] } });
}

export function openRemoveProject(ctx) {
  const p = ctx.p;
  const srv = p.server.info;
  const cb = h('input', { type: 'checkbox', id: 'dm-remove-server' });
  const btn = h('button', { class: 'btn danger', type: 'button' }, icon('trash'), t('devmode.removeConfirm'));
  const m = modal({
    title: t('devmode.removeTitle'),
    size: 'sm',
    body: h(
      'div',
      { class: 'stack' },
      h('p', { class: 'text-2 dm-dialog-text' }, t('devmode.removeText', { name: p.name })),
      srv ? h('label', { class: 'dm-check', for: 'dm-remove-server' }, cb, h('span', {}, t('devmode.removeServerToo', { name: srv.name }))) : null,
      srv ? h('div', { class: 'small muted' }, t('devmode.removeServerHint')) : null,
    ),
    footer: [h('button', { class: 'btn ghost', type: 'button', onclick: () => m.close() }, t('common.cancel')), btn],
  });
  btn.addEventListener('click', async () => {
    const done = setBusy(btn);
    try {
      await api.invoke('devmode:removeProject', p.id, { deleteServer: cb.checked });
      done();
      m.close();
      ok(t('devmode.removed', { name: p.name }));
      ctx.reload();
    } catch (err) {
      done();
      fail(t('devmode.errRemove'), err);
    }
  });
}

export function projectCard(ctx) {
  const el = h('section', { class: 'card dm-card dm-project', 'aria-label': t('devmode.projectCard') });

  const draw = () => {
    const p = ctx.p;
    const d = p.detect;
    const plug = p.plugin;
    const name = pluginDisplayName(p);
    const jar = p.jar;
    const badges = [];
    if (plug?.version && !tpl(plug.version)) badges.push(h('span', { class: 'badge accent' }, `v${plug.version}`));
    if (plug?.apiVersion && !tpl(plug.apiVersion)) badges.push(h('span', { class: 'badge', title: t('devmode.apiVersionHint') }, t('devmode.apiBadge', { version: plug.apiVersion })));
    if (plug?.paper) badges.push(h('span', { class: 'badge', title: t('devmode.paperPluginHint') }, 'paper-plugin.yml'));
    if (plug?.foliaSupported) badges.push(h('span', { class: 'badge good', title: t('devmode.foliaHint') }, icon('check'), 'Folia'));

    const notices = [];
    if (!d.exists) notices.push(h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, t('devmode.projectMissing'))));
    else {
      if (!d.tool && !jar) notices.push(h('div', { class: 'notice' }, icon('info'), h('div', {}, t('devmode.noToolHint'))));
      if (d.tool && !d.runner) notices.push(h('div', { class: 'notice' }, icon('alert'), h('div', {}, t(d.tool === 'maven' ? 'devmode.noMavenRunner' : 'devmode.noGradleRunner'))));
      if (d.tool && !p.jdk) {
        notices.push(
          h(
            'div',
            { class: 'notice' },
            icon('alert'),
            h('div', { class: 'spacer' }, t('devmode.noJdk')),
            h('button', { class: 'btn sm', type: 'button', onclick: () => api.app.openExternal(ADOPTIUM_URL) }, icon('external'), t('devmode.getJdk')),
          ),
        );
      }
    }
    if (jar?.missing) notices.push(h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, t('devmode.jarMissing', { file: jar.file }))));
    else if (jar?.plugin && jar.plugin.kind !== 'plugin') {
      const kind = jar.plugin.kind;
      notices.push(h('div', { class: 'notice bad' }, icon('alert'), h('div', {}, kind ? t('devmode.jarNotPluginKind', { file: jar.file, kind: t(`devmode.kind_${kind}`) }) : t('devmode.jarNotPlugin', { file: jar.file }))));
    }
    if (plug?.warnings?.includes('apiVersionUnquoted')) notices.push(h('div', { class: 'notice' }, icon('alert'), h('div', {}, t('devmode.warnApiUnquoted', { value: plug.apiVersion }))));
    if (plug && !p.pluginFromJar && plug.templated) notices.push(h('div', { class: 'notice info' }, icon('info'), h('div', {}, t('devmode.fromSources'))));

    const jarValue = jar && !jar.missing
      ? [
          h('span', { class: 'mono dm-file', title: jar.path }, jar.file),
          h('span', { class: 'muted small' }, ` · ${fmtBytes(jar.size)} · ${fmtAgo(jar.mtime)}`),
          jar.manual ? h('span', { class: 'badge dm-jar-badge' }, t('devmode.jarManual')) : null,
        ]
      : [h('span', { class: 'muted' }, d.tool ? t('devmode.noJarYet') : t('devmode.noJarPick'))];
    const jarActions = h(
      'div',
      { class: 'dm-fact-actions' },
      h('button', { class: 'btn sm ghost', type: 'button', onclick: () => pickJar(ctx).catch((e) => fail(t('devmode.errPickJar'), e)) }, icon('folderOpen'), t('devmode.pickJar')),
      jar?.manual ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => ctx.update({ jar: { path: null } }) }, icon('refresh'), t('devmode.jarAutoBtn')) : null,
      jar && !jar.missing ? iconBtn('external', t('devmode.showJar'), () => api.invoke('devmode:open', p.id, 'jar').catch((e) => fail(t('devmode.errOpen'), e))) : null,
    );

    const target = d.mcHint ? t('devmode.targetBuild', { version: d.mcHint }) : plug?.apiVersion && !tpl(plug.apiVersion) ? t('devmode.targetApi', { version: plug.apiVersion }) : t('devmode.targetUnknown');
    const jdkText = p.jdk ? t(p.jdk.auto ? 'devmode.jdkAuto' : 'devmode.jdkFixed', { major: p.jdk.major || '?', vendor: p.jdk.vendor || 'JDK' }) : t('devmode.jdkNone');
    const cmds = plug?.commands || [];

    mount(
      el,
      h(
        'div',
        { class: 'dm-proj-head' },
        tile((name || '?').charAt(0).toUpperCase(), 'var(--accent)', 'lg'),
        h(
          'div',
          { class: 'dm-proj-main' },
          h('h2', { class: 'dm-proj-name ellipsis', title: name }, name),
          badges.length || !plug ? h('div', { class: 'row wrap dm-badges' }, badges.length ? badges : h('span', { class: 'small muted' }, t('devmode.noPluginInfo'))) : null,
        ),
        h(
          'div',
          { class: 'dm-head-actions' },
          iconBtn('folderOpen', t('devmode.openFolder'), () => api.invoke('devmode:open', p.id, 'project').catch((e) => fail(t('devmode.errOpen'), e))),
          iconBtn('refresh', t('devmode.redetect'), async (e) => {
            const done = setBusy(e.currentTarget);
            try {
              await api.invoke('devmode:detect', p.id);
              await ctx.refresh();
              ok(t('devmode.redetected'));
            } catch (err) {
              fail(t('devmode.errDetect'), err);
            } finally {
              done();
            }
          }),
          iconBtn('trash', t('devmode.removeProject'), () => openRemoveProject(ctx), 'danger'),
        ),
      ),
      h(
        'div',
        { class: 'dm-path' },
        icon('folder'),
        h('span', { class: 'mono ellipsis selectable', title: p.dir }, p.dir),
        h('button', { class: 'icon-btn sm dm-path-copy', type: 'button', title: t('devmode.copyPath'), 'aria-label': t('devmode.copyPath'), onclick: () => copyText(p.dir) }, icon('copy')),
      ),
      plug?.description && !tpl(plug.description) ? h('p', { class: 'dm-desc' }, plug.description) : null,
      h(
        'div',
        { class: 'dm-facts' },
        fact(t('devmode.factBuild'), h('span', {}, toolLabel(p))),
        fact(t('devmode.factJdk'), h('span', { class: p.jdk ? '' : 'dm-warn-text' }, jdkText)),
        fact(t('devmode.factJar'), h('div', { class: 'dm-jar-line' }, ...jarValue), jarActions),
        fact(t('devmode.factTarget'), h('span', {}, target)),
        plug?.main && !tpl(plug.main) ? fact(t('devmode.factMain'), h('span', { class: 'mono small ellipsis', title: plug.main }, plug.main)) : null,
        cmds.length
          ? fact(
              t('devmode.factCommands'),
              h('div', { class: 'dm-cmds' }, cmds.slice(0, 8).map((c) => h('span', { class: 'kbd' }, `/${c}`)), cmds.length > 8 ? h('span', { class: 'small muted' }, t('devmode.moreCount', { count: cmds.length - 8 })) : null),
            )
          : null,
      ),
      notices.length ? h('div', { class: 'stack dm-notices' }, notices) : null,
    );
  };

  const off = ctx.on('project', draw);
  draw();
  return { el, destroy: off };
}
