// Control remoto de Venus Launcher: la página del celular. Sin dependencias: todo lo que llega del
// servidor (nombres, consola) se muestra como texto plano. El token sale del #fragmento de la URL, se saca de la barra de
// direcciones y después viaja solo en un header (nunca en la URL). Dura lo que dure la pestaña (sessionStorage).
(function () {
  'use strict';

  var STORE_KEY = 'venus-remote-token';
  var POLL_MS = 3000;
  var RETRY_MS = 5000;
  var S = {};
  var token = null;
  var seq = 0;
  var timer = null;
  var polling = false;
  var running = false;
  var state = null;
  var lastBusy = false;

  var $ = function (id) { return document.getElementById(id); };
  var T = function (key, vars) {
    var text = S[key] || key;
    Object.keys(vars || {}).forEach(function (k) { text = text.split('{' + k + '}').join(String(vars[k])); });
    return text;
  };

  function show(view) {
    $('login').hidden = view !== 'login';
    $('app').hidden = view !== 'app';
  }

  function saveToken(value) {
    token = value;
    try {
      if (value) sessionStorage.setItem(STORE_KEY, value);
      else sessionStorage.removeItem(STORE_KEY);
    } catch (e) { /* sin almacenamiento: vale hasta recargar */ }
  }

  function readToken() {
    var m = /^#t=([0-9A-Za-z-]{20,80})$/.exec(location.hash);
    if (m) {
      // Fuera de la barra de direcciones y del historial
      history.replaceState(null, '', '/');
      return normalize(m[1]);
    }
    try {
      return normalize(sessionStorage.getItem(STORE_KEY));
    } catch (e) {
      return null;
    }
  }

  function normalize(value) {
    var code = String(value || '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return /^[0-9A-HJKMNP-TV-Z]{28}$/.test(code) ? code : null;
  }

  function request(url, options) {
    var headers = Object.assign({ 'X-Venus-Token': token }, (options && options.headers) || {});
    return fetch(url, Object.assign({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' }, options, { headers: headers }));
  }

  function fail(message) {
    var el = $('banner');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function toLogin(message) {
    saveToken(null);
    stopPolling();
    seq = 0;
    $('console').textContent = '';
    show('login');
    var el = $('login-error');
    el.textContent = message || '';
    el.hidden = !message;
  }

  function stopPolling() {
    polling = false;
    clearTimeout(timer);
  }

  function schedule(ms) {
    clearTimeout(timer);
    if (polling) timer = setTimeout(poll, ms);
  }

  async function poll() {
    if (!polling || running) return;
    if (document.hidden) return schedule(POLL_MS);
    running = true;
    try {
      var res = await request('/api/state', { headers: { 'X-Venus-After': String(seq) } });
      if (res.status === 401) return toLogin(T('page_badCode'));
      if (res.status === 403) {
        var data403 = await res.json().catch(function () { return {}; });
        return toLogin(T(data403.error === 'cut' ? 'page_cut' : 'page_denied'));
      }
      if (res.status === 429) {
        var data429 = await res.json().catch(function () { return {}; });
        var minutes = Math.ceil((data429.retryAfter || 60) / 60);
        if (!state) return toLogin(T('page_tooMany', { minutes: minutes }));
        fail(T('page_tooMany', { minutes: minutes }));
        return schedule((data429.retryAfter || 60) * 1000);
      }
      if (res.status === 410) return toLogin(T('page_expired'));
      if (!res.ok) throw new Error('http ' + res.status);
      var data = await res.json();
      fail('');
      show('app');
      render(data);
      schedule(POLL_MS);
    } catch (err) {
      if (!state) show('app');
      fail(T('page_offline'));
      schedule(RETRY_MS);
    } finally {
      running = false;
    }
  }

  function clock(ms) {
    var d = new Date(ms);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function render(data) {
    var srv = data.server || {};
    state = srv.state;
    lastBusy = Boolean(srv.busy);
    document.title = srv.name || 'Venus Launcher';
    $('name').textContent = srv.name || '';
    $('meta').textContent = [srv.type, srv.version].filter(Boolean).join(' · ');
    var pill = $('state');
    pill.textContent = T('page_state_' + (['online', 'offline', 'starting', 'stopping'].indexOf(srv.state) >= 0 ? srv.state : 'offline'));
    pill.className = 'pill ' + (srv.state === 'online' ? 'good' : srv.state === 'offline' ? '' : 'warn');
    var offline = srv.state === 'offline';
    var online = srv.state === 'online';
    $('btn-start').hidden = !offline;
    $('btn-start').disabled = lastBusy;
    $('btn-stop').hidden = offline;
    $('btn-stop').disabled = srv.state !== 'online' && srv.state !== 'starting';
    $('btn-restart').hidden = offline;
    $('btn-restart').disabled = !online;
    $('command').disabled = offline;
    $('command-form').querySelector('button').disabled = offline;

    var players = data.players || [];
    $('player-count').textContent = String(players.length);
    $('no-players').hidden = players.length > 0;
    var list = $('players');
    list.textContent = '';
    players.forEach(function (p) {
      var li = document.createElement('li');
      li.textContent = p.name;
      list.appendChild(li);
    });

    if (data.lines && data.lines.length) appendLines(data.lines);
    seq = data.seq || seq;

    var left = Math.ceil(Math.max(0, (data.expiresAt || 0) - (data.now || Date.now())) / 60000);
    $('expires').textContent = T('page_expiresIn', { hours: Math.floor(left / 60), minutes: left % 60 });
  }

  function appendLines(lines) {
    var box = $('console');
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    lines.forEach(function (l) {
      var row = document.createElement('div');
      row.className = 'line ' + (/^(ERROR|FATAL|SEVERE)$/.test(l.level) ? 'bad' : /^WARN/.test(l.level) ? 'warn' : l.level === 'CMD' ? 'cmd' : '');
      var time = document.createElement('span');
      time.className = 'time';
      time.textContent = clock(l.t) + ' ';
      row.appendChild(time);
      row.appendChild(document.createTextNode(l.text));
      box.appendChild(row);
    });
    while (box.childElementCount > 200) box.removeChild(box.firstChild);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // Confirmación propia: Detener, Reiniciar y mandar un comando no salen sin esto
  function confirmAction(title, text, okText, command) {
    return new Promise(function (resolve) {
      var box = $('confirm');
      var yes = $('confirm-yes');
      var no = $('confirm-no');
      $('confirm-title').textContent = title;
      $('confirm-text').textContent = text;
      var code = $('confirm-command');
      code.textContent = command || '';
      code.hidden = !command;
      yes.textContent = okText;
      box.hidden = false;
      yes.focus();
      var done = function (value) {
        box.hidden = true;
        yes.onclick = null;
        no.onclick = null;
        resolve(value);
      };
      yes.onclick = function () { done(true); };
      no.onclick = function () { done(false); };
    });
  }

  async function act(body, btn) {
    if (btn) btn.disabled = true;
    try {
      var res = await request('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (res.status === 401) return toLogin(T('page_badCode'));
      if (res.status === 403) return toLogin(T('page_cut'));
      if (!res.ok) {
        var data = await res.json().catch(function () { return {}; });
        fail(T('page_err_' + (['busy', 'offline', 'bad_command', 'too_large'].indexOf(data.error) >= 0 ? data.error : 'failed')));
        return false;
      }
      fail('');
      return true;
    } catch (err) {
      fail(T('page_offline'));
      return false;
    } finally {
      if (btn) btn.disabled = false;
      schedule(100);
    }
  }

  function start() {
    polling = true;
    state = null;
    seq = 0;
    show('app');
    poll();
  }

  function bind() {
    document.querySelectorAll('[data-t]').forEach(function (el) { el.textContent = T(el.getAttribute('data-t')); });
    document.querySelectorAll('[data-ph]').forEach(function (el) { el.placeholder = T(el.getAttribute('data-ph')); });
    document.documentElement.lang = S.lang || 'es';

    $('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var code = normalize($('code').value);
      if (!code) {
        var el = $('login-error');
        el.textContent = T('page_badFormat');
        el.hidden = false;
        return;
      }
      $('code').value = '';
      $('login-error').hidden = true;
      saveToken(code);
      start();
    });
    $('btn-start').addEventListener('click', function (e) { act({ action: 'start' }, e.currentTarget); });
    $('btn-stop').addEventListener('click', async function (e) {
      var btn = e.currentTarget;
      if (await confirmAction(T('page_confirmStopTitle'), T('page_confirmStopText'), T('page_stop'))) act({ action: 'stop', confirm: true }, btn);
    });
    $('btn-restart').addEventListener('click', async function (e) {
      var btn = e.currentTarget;
      if (await confirmAction(T('page_confirmRestartTitle'), T('page_confirmRestartText'), T('page_restart'))) act({ action: 'restart', confirm: true }, btn);
    });
    $('command-form').addEventListener('submit', async function (e) {
      e.preventDefault();
      var input = $('command');
      var command = input.value.trim();
      if (!command) return;
      if (!(await confirmAction(T('page_confirmCommandTitle'), T('page_confirmCommandText'), T('page_send'), command))) return;
      if (await act({ action: 'command', command: command, confirm: true })) input.value = '';
    });
    $('btn-forget').addEventListener('click', function () { toLogin(''); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && polling) schedule(0);
    });
  }

  async function init() {
    try {
      var res = await fetch('/strings.json', { cache: 'no-store', credentials: 'omit' });
      S = await res.json();
    } catch (e) {
      S = {};
    }
    bind();
    var saved = readToken();
    if (saved) {
      saveToken(saved);
      start();
    } else {
      show('login');
    }
  }

  init();
})();
