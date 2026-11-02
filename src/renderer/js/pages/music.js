// Música: lo que suena en Spotify o en cualquier reproductor de Windows (portada, canción, progreso, controles y
// volumen de la app en el mezclador) y, debajo, la tarjeta de ajustes (fuente, overlay y atajos).
// Ruta: #/music. Usa el cliente compartido de features/nowplaying.js.
import { h, icon, mount, emptyState, skeleton, fail, setBusy } from '../ui.js';
import { t } from '../i18n.js';
import { nowPlaying, nowPlayingPanel, runAction, fmtClock, positionNow, paintArt, safeArt, appLabel, titleOf, prepare } from '../features/nowplaying.js';

export default {
  ns: ['nowplaying'],
  css: ['pages/music', 'features/nowplaying'],
  async render(root) {
    await prepare();
    let disposed = false;
    let view = null;
    let mode = '';
    let hero = null; // controles armados (se actualizan en el lugar para no perder el foco)

    const openBtn = h('button', { class: 'btn', type: 'button', hidden: true, title: t('nowplaying.openSpotifyTitle'), onclick: (e) => openSpotify(e.currentTarget) }, icon('external'), t('nowplaying.openSpotify'));
    const host = h('div', { class: 'mu-host' }, skeleton('block', { height: 280, label: t('nowplaying.loading') }));
    const panel = nowPlayingPanel();
    mount(
      root,
      h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h1', { class: 'page-title' }, t('nowplaying.title')), h('p', { class: 'page-sub' }, t('nowplaying.subtitle'))), h('div', { class: 'page-actions' }, openBtn)),
      host,
      h('div', { class: 'mu-settings' }, panel),
    );

    async function openSpotify(btn) {
      const done = setBusy(btn);
      try {
        await nowPlaying.openSpotify();
      } catch (err) {
        fail(t('nowplaying.openSpotifyFailed'), err);
      } finally {
        done();
      }
    }

    function card(...children) {
      return h('section', { class: 'card mu-empty' }, ...children);
    }

    function showMode(next, build) {
      if (mode === next) return false;
      mode = next;
      hero?.destroy();
      hero = null;
      mount(host, build());
      return true;
    }

    function draw(v) {
      if (disposed) return;
      view = v;
      const installed = Boolean(v?.spotify?.installed);
      if (!v) return;
      if (v.available === false) {
        openBtn.hidden = true;
        const key = v.reason === 'platform' ? 'platform' : v.reason === 'unsupported' ? 'unsupported' : 'unavailable';
        showMode(`na-${key}`, () => card(emptyState(key === 'platform' ? 'monitor' : 'alert', t(`nowplaying.${key}Title`), t(`nowplaying.${key}Text`))));
        return;
      }
      if (!v.state) {
        if (v.status === 'retrying') {
          openBtn.hidden = !installed;
          showMode('retrying', () => card(emptyState('alert', t('nowplaying.retryingTitle'), t('nowplaying.retryingText'), h('button', { class: 'btn', type: 'button', onclick: () => nowPlaying.refresh({ retry: true }) }, icon('refresh'), t('nowplaying.retry')))));
          return;
        }
        if (!v.loaded) {
          openBtn.hidden = !installed;
          showMode('loading', () => skeleton('block', { height: 280, label: t('nowplaying.loading') }));
          return;
        }
        // Nada sonando: el botón de Spotify va en el estado vacío (único botón principal de la vista)
        openBtn.hidden = true;
        showMode(`empty-${installed}`, () =>
          card(emptyState('music', t('nowplaying.nothingTitle'), t('nowplaying.nothingText'), installed ? h('button', { class: 'btn primary', type: 'button', title: t('nowplaying.openSpotifyTitle'), onclick: (e) => openSpotify(e.currentTarget) }, icon('external'), t('nowplaying.openSpotify')) : null)),
        );
        return;
      }
      openBtn.hidden = !installed || v.state.source === 'spotify';
      if (showMode('playing', buildHero) || hero) updateHero(v);
    }

    // ---------- Reproductor ----------
    function buildHero() {
      const art = h('div', { class: 'mu-art', 'aria-hidden': 'true' });
      const appBadge = h('span', { class: 'badge mu-app' });
      const statePill = h('span', { class: 'pill mu-state' });
      const title = h('h2', { class: 'mu-title' });
      const sub = h('p', { class: 'mu-sub' });
      const seek = h('input', { type: 'range', class: 'range mu-seek', min: 0, max: 1000, step: 1000, value: 0, 'aria-label': t('nowplaying.seekLabel') });
      const pos = h('span', { class: 'mu-time num' }, '0:00');
      const dur = h('span', { class: 'mu-time num' }, '0:00');
      const seekNote = h('p', { class: 'field-help mu-note', hidden: true });
      const btn = (iconName, label, action) => h('button', { class: 'icon-btn mu-ctl', type: 'button', title: label, 'aria-label': label, onclick: () => runAction(action) }, icon(iconName));
      const prev = btn('npSkipBack', t('nowplaying.prev'), 'prev');
      const back = btn('npBack', t('nowplaying.back'), 'back');
      const play = h('button', { class: 'mu-play', type: 'button', onclick: () => runAction('toggle') });
      const fwd = btn('npForward', t('nowplaying.forward'), 'forward');
      const next = btn('skipForward', t('nowplaying.next'), 'next');
      const mute = h('button', { class: 'icon-btn mu-mute', type: 'button', onclick: () => runAction('mute') });
      const vol = h('input', { type: 'range', class: 'range mu-vol', min: 0, max: 100, step: 1, value: 0 });
      const volVal = h('span', { class: 'mu-vol-val num' });
      const volHelp = h('p', { class: 'field-help mu-note' });

      // Saltar: mientras se arrastra no se pisa el valor; se manda al soltar (o un rato después de usar el teclado)
      let seeking = false;
      let seekTimer = null;
      const fillPct = (input, pct) => input.style.setProperty('--mu-pct', `${Math.max(0, Math.min(100, pct)).toFixed(2)}%`);
      seek.addEventListener('input', () => {
        seeking = true;
        pos.textContent = fmtClock(Number(seek.value));
        fillPct(seek, (Number(seek.value) / Number(seek.max || 1)) * 100);
        clearTimeout(seekTimer);
      });
      seek.addEventListener('change', () => {
        clearTimeout(seekTimer);
        seekTimer = setTimeout(async () => {
          await runAction('seek', Number(seek.value));
          seeking = false;
        }, 200);
      });

      // Volumen: se manda con una pausa corta mientras se arrastra; un rato no se pisa con lo que llega
      let volTimer = null;
      let volLockUntil = 0;
      vol.addEventListener('input', () => {
        volLockUntil = Date.now() + 1500;
        volVal.textContent = t('nowplaying.volumePercent', { value: vol.value });
        fillPct(vol, Number(vol.value));
        clearTimeout(volTimer);
        volTimer = setTimeout(async () => {
          try {
            await nowPlaying.setVolume(Number(vol.value) / 100);
          } catch (err) {
            fail(t('nowplaying.actionFailed'), err);
          }
          volLockUntil = Date.now() + 600;
        }, 150);
      });

      const el = h(
        'section',
        { class: 'card mu-hero' },
        art,
        h(
          'div',
          { class: 'mu-main' },
          h('div', { class: 'mu-top' }, appBadge, statePill),
          title,
          sub,
          h('div', { class: 'mu-progress' }, pos, seek, dur),
          seekNote,
          h('div', { class: 'mu-controls' }, prev, back, play, fwd, next),
          h('div', { class: 'mu-volume' }, mute, vol, volVal),
          volHelp,
        ),
      );
      let playIcon = '';
      let muteIcon = '';
      hero = {
        el,
        tick() {
          const st = view?.state;
          if (!st || seeking) return;
          const p = positionNow(st);
          seek.value = String(Math.round(p));
          pos.textContent = fmtClock(p);
          fillPct(seek, st.duration > 0 ? (p / st.duration) * 100 : 0);
          seek.setAttribute('aria-valuetext', t('nowplaying.seekValue', { position: fmtClock(p), duration: fmtClock(st.duration) }));
        },
        update(v) {
          const st = v.state;
          const app = appLabel(st);
          paintArt(art, st.art);
          const src = safeArt(st.art);
          if (src) el.style.setProperty('--mu-art', `url("${src}")`);
          else el.style.removeProperty('--mu-art');
          mount(appBadge, icon(st.source === 'browser' ? 'globe' : 'music'), t('nowplaying.fromApp', { app }));
          const status = st.playing ? 'Playing' : st.status === 'stopped' ? 'Stopped' : 'Paused';
          statePill.className = `pill mu-state ${st.playing ? 'good' : ''}`;
          statePill.textContent = t(`nowplaying.status${status}`);
          title.textContent = titleOf(st);
          title.title = titleOf(st);
          const subText = [st.artist, st.album].filter(Boolean).join(' · ');
          sub.textContent = subText;
          sub.title = subText;
          sub.hidden = !subText;
          // Progreso
          seek.max = String(Math.max(1000, st.duration || 0));
          seek.disabled = !v.can?.seek;
          dur.textContent = st.duration > 0 ? fmtClock(st.duration) : '--:--';
          seekNote.hidden = Boolean(v.can?.seek) || !(st.duration > 0);
          seekNote.textContent = t('nowplaying.seekUnavailable', { app });
          back.disabled = fwd.disabled = !v.can?.seek;
          prev.disabled = !v.can?.prev;
          next.disabled = !v.can?.next;
          // Reproducir / pausar
          const want = st.playing ? 'pause' : 'play';
          if (playIcon !== want) {
            playIcon = want;
            mount(play, icon(want));
          }
          play.title = t(st.playing ? 'nowplaying.pause' : 'nowplaying.play');
          play.setAttribute('aria-label', play.title);
          play.disabled = !v.can?.toggle;
          // Volumen de la app
          const vo = v.volume || {};
          const level = Math.round((vo.level || 0) * 100);
          vol.disabled = mute.disabled = !vo.available;
          vol.setAttribute('aria-label', t('nowplaying.volumeLabel', { app }));
          if (Date.now() > volLockUntil) {
            vol.value = String(vo.available ? level : 0);
            volVal.textContent = vo.available ? t('nowplaying.volumePercent', { value: level }) : '';
            fillPct(vol, vo.available ? level : 0);
          }
          const mi = vo.muted ? 'volumeX' : level < 50 ? 'npVolumeLow' : 'volume';
          if (muteIcon !== mi) {
            muteIcon = mi;
            mount(mute, icon(mi));
          }
          mute.title = t(vo.muted ? 'nowplaying.unmute' : 'nowplaying.mute', { app });
          mute.setAttribute('aria-label', mute.title);
          mute.setAttribute('aria-pressed', String(Boolean(vo.muted)));
          volHelp.textContent = vo.available ? t('nowplaying.volumeHelp', { app }) : t('nowplaying.volumeUnavailable', { app });
          this.tick();
        },
        destroy() {
          clearTimeout(seekTimer);
          clearTimeout(volTimer);
        },
      };
      return el;
    }

    function updateHero(v) {
      hero?.update(v);
    }

    const tick = setInterval(() => {
      if (view?.state?.playing) hero?.tick();
    }, 500);
    const off = nowPlaying.subscribe(draw);
    return () => {
      disposed = true;
      clearInterval(tick);
      hero?.destroy();
      off();
      panel.destroy?.();
    };
  },
};
