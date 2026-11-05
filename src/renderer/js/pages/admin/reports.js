// Panel de administracion: denuncias de perfiles (3.1). render(root) dibuja la lista de admin_profile_reports (0027)
// con Cerrar y Quitar la cancion y cerrar (admin_profile_report_close). Lo enchufa pages/admin.js.
import { h, icon, mount, ok, fail, setBusy, skeleton, emptyState, fmtAgo, fmtDate, fmtTime, ensureCss } from '../../ui.js';
import { t, loadNs } from '../../i18n.js';
import { cloud } from '../../cloud.js';
import { cleanText, LIMITS } from '../../features/profile-editor/model.js';
import { normalizeSong } from '../../features/profile-editor/music-logic.js'; // 4.6: la cancion es de Openverse
import { attributionEl, ensureMusicCss } from '../../features/profile-editor/music-ui.js';

const P = (k, vars) => t(`profile.${k}`, vars);

export async function render(root) {
  ensureCss('features/profile-social');
  ensureMusicCss();
  await loadNs('profile', 'profilemusic');
  const list = h('div', { class: 'stack pf-rep-list' });
  const reload = h('button', { class: 'btn sm', type: 'button' }, icon('refresh'), P('adminReportsReload'));
  mount(root, h('div', { class: 'page-head' }, h('div', { class: 'ph-text' }, h('h2', { class: 'page-title' }, P('adminReportsTitle')), h('p', { class: 'page-sub' }, P('adminReportsSub'))), h('div', { class: 'page-actions' }, reload)), list);

  async function load() {
    mount(list, skeleton('list', { rows: 4, label: P('adminReportsLoading') }));
    try {
      const { data, error } = await cloud.client.rpc('admin_profile_reports');
      if (error) throw error;
      const rows = Array.isArray(data) ? data : [];
      if (!rows.length) return mount(list, emptyState('shield', P('adminReportsEmpty'), ''));
      mount(list, rows.map(row));
    } catch (err) {
      console.warn('[admin] denuncias:', err?.message || err);
      mount(list, emptyState('alert', P('adminReportsFailed'), ''));
    }
  }
  const nameOf = (u) => cleanText(u?.displayName || u?.username || '', 32) || t('social.someone');
  function row(r) {
    const open = r.status === 'open';
    const closeBtn = h('button', { class: 'btn sm', type: 'button', disabled: !open }, icon('check'), P('adminReportClose'));
    const songBtn = h('button', { class: 'btn sm danger', type: 'button', disabled: !open || !r.target?.song }, icon('volumeX'), P('adminReportRemoveSong'));
    const act = (btn, removeSong) => async () => {
      const release = setBusy(btn);
      try {
        const { error } = await cloud.client.rpc('admin_profile_report_close', { p_id: r.id, p_remove_song: removeSong });
        if (error) throw error;
        ok(P('adminReportClosedOk'));
        load();
      } catch (err) {
        fail(P('adminReportFailed'), err);
      } finally {
        release();
      }
    };
    closeBtn.addEventListener('click', act(closeBtn, false));
    songBtn.addEventListener('click', act(songBtn, true));
    const song = normalizeSong(r.target?.song); // null si no es de Openverse o no pasa la validacion: no se reproduce
    const at = Date.parse(r.at);
    return h(
      'div',
      { class: ['card', 'pf-rep', !open && 'closed'] },
      h(
        'div',
        { class: 'pf-rep-head' },
        h('span', { class: ['pill', open ? 'warn' : 'good'] }, P(open ? 'adminReportOpen' : 'adminReportClosed')),
        h('span', { class: 'badge' }, P(`reportReason_${r.reason === 'song' ? 'song' : 'content'}`)),
        h('span', { class: 'pf-rep-time', title: Number.isFinite(at) ? `${fmtDate(at)} ${fmtTime(at)}` : '' }, Number.isFinite(at) ? fmtAgo(at) : ''),
      ),
      h('div', { class: 'pf-rep-who' }, h('strong', {}, P('adminReportTarget', { name: nameOf(r.target) })), h('span', { class: 'muted' }, ` · ${P('adminReportBy', { name: nameOf(r.reporter) })}`)),
      r.text ? h('p', { class: 'pf-rep-text selectable' }, cleanText(r.text, LIMITS.reportText)) : null,
      song ? h('div', { class: 'pf-rep-song' }, h('span', { class: 'muted' }, `${P('adminReportSong')}: `), h('audio', { controls: true, preload: 'none', src: song.url }), attributionEl(song)) : null,
      h('div', { class: 'row wrap' }, closeBtn, songBtn),
    );
  }
  reload.addEventListener('click', load);
  load();
}
