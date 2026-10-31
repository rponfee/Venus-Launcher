// Ajustes > General (idioma y que hace el launcher al jugar), Privacidad (actividad, Discord Rich Presence y que se
// guarda en la PC o en la nube) y Acerca de.
import { h, icon, mount, fail, copyText } from '../../ui.js';
import { store, api } from '../../store.js';
import { t, LANGUAGES, getLanguage, setLanguage, locale } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { social } from '../../social.js';
import { navigate } from '../../app.js';
import { discordButton } from '../../community.js';
import { sectionHead, card, toggleRow, note, iconList, arrowFocus, extLink, embedPanel } from './shared.js';

const AFTER_LAUNCH = [
  ['keep', 'monitor'],
  ['minimize', 'chevronDown'],
  ['hide', 'eyeOff'],
];

// Nombre del idioma en el idioma actual de la interfaz ("portugués (Brasil)", "Brazilian Portuguese").
function localName(l) {
  try {
    const dn = new Intl.DisplayNames([locale()], { type: 'language' });
    const name = dn.of(l.code === 'zh' ? 'zh-Hans' : l.locale);
    return name ? name.charAt(0).toLocaleUpperCase(locale()) + name.slice(1) : l.english;
  } catch {
    return l.english;
  }
}

async function saveSettings(patch) {
  try {
    await store.setSettings(patch);
    return true;
  } catch (err) {
    fail(t('settings.saveError'), err);
    return false;
  }
}

// ---------------- General ----------------

export function renderGeneral(body, ctx) {
  // Idioma: se aplica al instante (app.js vuelve a dibujar la pagina en el idioma nuevo)
  const langGrid = arrowFocus(h('div', { class: 'cfg-langs', role: 'radiogroup', 'aria-label': t('settings.languageTitle') }));
  let busy = null;
  const drawLangs = () => {
    const cur = getLanguage();
    mount(
      langGrid,
      LANGUAGES.map((l) => {
        const active = l.code === cur;
        const local = localName(l);
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(active),
            class: ['cfg-lang', active && 'active', busy === l.code && 'busy'],
            disabled: Boolean(busy) && busy !== l.code,
            title: local,
            onclick: () => pick(l.code),
          },
          h('span', { class: 'cfg-lang-code', 'aria-hidden': 'true' }, busy === l.code ? h('span', { class: 'spinner' }) : l.code.toUpperCase()),
          h(
            'span',
            { class: 'cfg-lang-text' },
            h('span', { class: 'cfg-lang-name', lang: l.locale }, l.name),
            local.toLocaleLowerCase() !== l.name.toLocaleLowerCase() ? h('span', { class: 'cfg-lang-local' }, local) : null,
          ),
          active ? icon('check', 'cfg-lang-check') : null,
        );
      }),
    );
  };
  const pick = async (code) => {
    if (busy) return;
    if (code === getLanguage() && store.settings?.language === code) return;
    busy = code;
    drawLangs();
    try {
      await store.setSettings({ language: code });
      await setLanguage(code);
    } catch (err) {
      fail(t('settings.saveError'), err);
    } finally {
      busy = null;
      if (ctx.alive()) drawLangs();
    }
  };
  drawLangs();

  // Al iniciar el juego
  const afterBox = arrowFocus(h('div', { class: 'cfg-options', role: 'radiogroup', 'aria-labelledby': 'cfg-after-label' }));
  const drawAfter = () => {
    const v = store.settings?.afterLaunch;
    const cur = AFTER_LAUNCH.some(([k]) => k === v) ? v : 'minimize';
    mount(
      afterBox,
      AFTER_LAUNCH.map(([key, ic]) => {
        const on = key === cur;
        return h(
          'button',
          {
            type: 'button',
            role: 'radio',
            'aria-checked': String(on),
            class: ['cfg-option', on && 'active'],
            onclick: async () => {
              if (on) return;
              await saveSettings({ afterLaunch: key });
              if (ctx.alive()) drawAfter();
            },
          },
          h('span', { class: 'cfg-option-icon', 'aria-hidden': 'true' }, icon(ic)),
          h('span', { class: 'cfg-option-text' }, h('span', { class: 'cfg-option-title' }, t(`settings.after_${key}`)), h('span', { class: 'cfg-option-sub' }, t(`settings.after_${key}_sub`))),
          on ? icon('check', 'cfg-option-check') : null,
        );
      }),
    );
  };
  drawAfter();

  mount(
    body,
    sectionHead('general', 'sliders'),
    card({ title: t('settings.languageTitle'), iconName: 'languages', sub: t('settings.languageSub'), anchor: 'language' }, langGrid),
    card(
      { title: t('settings.playTitle'), iconName: 'rocket', sub: t('settings.playSub'), anchor: 'play' },
      h('div', { class: 'cfg-label', id: 'cfg-after-label' }, t('settings.afterLaunchTitle')),
      afterBox,
      toggleRow({
        title: t('settings.consoleTitle'),
        sub: t('settings.consoleSub'),
        checked: Boolean(store.settings?.openConsoleOnLaunch),
        onChange: (v) => saveSettings({ openConsoleOnLaunch: v }),
      }),
      h(
        'div',
        { class: 'cfg-crosslink' },
        icon('memory'),
        h('span', {}, t('settings.perfHint')),
        h('button', { type: 'button', class: 'btn sm ghost', onclick: () => navigate('performance') }, t('settings.perfGo'), icon('arrowRight')),
      ),
    ),
  );
}

// ---------------- Privacidad ----------------

function shareActivityPref() {
  return store.settings?.social?.shareActivity !== false;
}

export function renderPrivacy(body, ctx) {
  const info = ctx.info || {};
  const accountNote = h('div', { class: 'cfg-note-slot' });
  const drawAccountNote = () =>
    mount(
      accountNote,
      cloud.isSignedIn()
        ? null
        : note(
            'info',
            'info',
            h('div', {}, t('settings.privNeedsSignIn')),
            h('button', { type: 'button', class: 'btn sm cfg-note-btn', onclick: () => ctx.go('cloud', 'venus') }, icon('cloud'), t('settings.privGoAccount')),
          ),
    );
  drawAccountNote();
  ctx.onCleanup(cloud.on('auth', () => ctx.alive() && drawAccountNote()));
  ctx.onCleanup(cloud.on('config', () => ctx.alive() && drawAccountNote()));

  const setShare = async (v) => {
    try {
      // social.setPrefs ademas avisa enseguida a los amigos; si no esta, se guarda el ajuste directo.
      if (typeof social?.setPrefs === 'function') await social.setPrefs({ shareActivity: v });
      else await store.setSettings({ social: { shareActivity: v } });
    } catch (err) {
      fail(t('settings.saveError'), err);
    }
  };

  const local = card(
    { title: t('settings.privLocalTitle'), iconName: 'monitor', sub: t('settings.privLocalSub') },
    iconList([
      ['layers', t('settings.privLocalGame'), t('settings.privLocalGameSub')],
      ['sliders', t('settings.privLocalSettings'), t('settings.privLocalSettingsSub')],
      ['lock', t('settings.privLocalSecrets'), t('settings.privLocalSecretsText')],
    ]),
    info.dataDir
      ? h('div', { class: 'cfg-where' }, h('span', { class: 'cfg-where-label' }, t('settings.privLocalWhere')), h('span', { class: 'cfg-path-chip selectable', title: info.dataDir }, info.dataDir))
      : null,
  );
  const remote = card(
    { title: t('settings.privCloudTitle'), iconName: 'cloud', sub: t('settings.privCloudSub') },
    iconList([
      ['user', t('settings.privCloudProfile'), t('settings.privCloudProfileSub')],
      ['message', t('settings.privCloudSocial'), t('settings.privCloudSocialSub')],
      ['activity', t('settings.privCloudActivity'), t('settings.privCloudActivitySub')],
      ['mic', t('settings.privCloudVoice'), t('settings.privCloudVoiceSub')],
      ['cloudUpload', t('settings.privCloudFiles'), t('settings.privCloudFilesSub')],
      ['sparkles', t('settings.privCloudAi'), t('settings.privCloudAiSub')],
      ['crown', t('settings.privCloudPlan'), t('settings.privCloudPlanSub')],
    ]),
    h('div', { class: 'cfg-where' }, icon('shieldCheck'), h('span', {}, cloud.isConfigured() ? t('settings.privCloudWhere') : t('settings.privCloudOff'))),
  );

  // Conexiones opcionales (features/netprefs.js): apagadas hasta que el usuario las active.
  const setNet = (key) => async (v) => {
    try {
      await store.setSettings({ privacy: { [key]: v, decided: true } });
    } catch (err) {
      fail(t('settings.saveError'), err);
    }
  };
  const optional = card(
    { title: t('common.net_cardTitle'), iconName: 'wifi', sub: t('common.net_cardSub'), anchor: 'connections' },
    ['autoUpdates', 'news', 'featuredServers', 'playerHeads'].map((key) =>
      toggleRow({ title: t(`common.net_${key}Title`), sub: t(`common.net_${key}Text`), checked: store.settings?.privacy?.[key] === true, onChange: setNet(key) })),
  );

  // Discord Rich Presence (panel del módulo discord): qué se muestra en tu perfil de Discord
  const discordHost = h('div', { class: 'cfg-embed-host', dataset: { anchor: 'discord' } });

  mount(
    body,
    sectionHead('privacy', 'shieldCheck'),
    optional,
    card(
      { title: t('settings.privActivityTitle'), iconName: 'activity', anchor: 'activity' },
      toggleRow({ title: t('settings.privShareActivity'), sub: t('settings.privShareActivitySub'), checked: shareActivityPref(), onChange: setShare }),
      accountNote,
    ),
    discordHost,
    h('div', { class: 'cfg-cols' }, local, remote),
    card(
      { title: t('settings.privAiTitle'), iconName: 'sparkles' },
      h('p', { class: 'cfg-text' }, t('settings.privAiText')),
      h('button', { type: 'button', class: 'btn sm', onclick: () => ctx.go('ai', 'privacy') }, icon('sparkles'), t('settings.privAiGo')),
    ),
  );
  embedPanel(discordHost, { load: () => import('../../features/discord.js'), fn: 'discordPanel', ns: ['discord'] }, ctx);
}

// ---------------- Acerca de ----------------

const CREDITS = [
  ['Minecraft', 'credMinecraft', 'https://www.minecraft.net'],
  ['Modrinth', 'credModrinth', 'https://modrinth.com'],
  ['CurseForge', 'credCurseForgeText', 'https://www.curseforge.com'],
  ['Fabric · Quilt · Forge · NeoForge', 'credLoaders', null],
  ['OptiFine · Iris', 'credShaders', null],
  ['Eclipse Adoptium', 'credAdoptium', 'https://adoptium.net'],
  ['Supabase', 'credSupabase', 'https://supabase.com'],
  ['Claude · Anthropic', 'credClaude', 'https://www.anthropic.com'],
  ['Electron', 'credElectron', 'https://www.electronjs.org'],
  ['Pixelify Sans · Outfit', 'credFonts', null],
  ['Lucide', 'credIcons', 'https://lucide.dev'],
  ['mc-heads.net', 'credHeads', 'https://mc-heads.net'],
];

const LINKS = [
  ['modrinth', 'https://modrinth.com', 'package'],
  ['optifine', 'https://optifine.net/donate', 'heart'],
  ['eula', 'https://aka.ms/MinecraftEULA', 'fileText'],
];

const OS_NAMES = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export function renderAbout(body, ctx) {
  const info = ctx.info || {};
  const osName = OS_NAMES[info.platform] || info.platform || '?';
  const summary = [`Venus Launcher ${info.version || '?'}`, `Electron ${info.electron || '?'}`, `${info.platform || '?'}-${info.arch || '?'}`, info.locale || null, info.portable ? 'portable' : null].filter(Boolean).join(' · ');

  const hero = card(
    { cls: 'cfg-about-hero' },
    h('img', { class: 'cfg-about-logo', src: 'assets/logo-256.png', alt: '' }),
    h(
      'div',
      { class: 'cfg-about-main' },
      h('div', { class: 'cfg-about-name' }, t('settings.appName')),
      h('div', { class: 'cfg-about-ver' }, t('settings.aboutVersion', { version: info.version || '?' })),
      h(
        'div',
        { class: 'cfg-about-badges' },
        h('span', { class: 'badge' }, icon('zap'), t('settings.aboutElectron', { version: info.electron || '?' })),
        h('span', { class: 'badge' }, icon('monitor'), t('settings.aboutPlatform', { os: osName, arch: info.arch || '?' })),
        info.portable ? h('span', { class: 'badge accent' }, icon('drive'), t('settings.aboutPortable')) : null,
        info.packaged === false ? h('span', { class: 'badge warn' }, icon('code'), t('settings.aboutDev')) : null,
      ),
      h(
        'div',
        { class: 'row wrap cfg-about-actions' },
        h('button', { type: 'button', class: 'btn sm', onclick: () => copyText(summary, t('settings.aboutCopied')) }, icon('copy'), t('settings.aboutCopy')),
        LINKS.map(([key, url, ic]) => h('button', { type: 'button', class: 'btn sm ghost', title: url, onclick: () => api.app.openExternal(url).catch(() => {}) }, icon(ic), t(`settings.link_${key}`))),
      ),
    ),
  );

  const credits = card(
    { title: t('settings.creditsTitle'), iconName: 'heart', sub: t('settings.creditsSub') },
    h(
      'div',
      { class: 'cfg-credits' },
      CREDITS.map(([name, key, url]) => h('div', { class: 'cfg-credit' }, h('div', { class: 'cfg-credit-name' }, url ? extLink(url, name) : name), h('div', { class: 'cfg-credit-desc' }, t(`settings.${key}`)))),
    ),
  );

  const community = card(
    { title: t('common.discordCommunity'), iconName: 'users', sub: t('common.discordCommunityText'), anchor: 'community' },
    discordButton({ className: 'btn primary' }),
  );

  mount(body, sectionHead('about', 'info'), hero, community, credits, h('p', { class: 'cfg-legal' }, t('settings.aboutLegal')));
}
