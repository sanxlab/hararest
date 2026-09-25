/* Live RPG client. Only server responses update account and combat state. */
(async () => {
  'use strict';

  const $ = (q) => document.querySelector(q);
  const $$ = (q) => [...document.querySelectorAll(q)];
  const esc = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  const fmt = (value) => Number(value).toLocaleString('id-ID');
  const stars = (n) => '★'.repeat(n);
  const colors = {
    Api: '#c97954',
    Air: '#7cbbbe',
    Angin: '#a2b981',
    Tanah: '#b59d6d',
    Cahaya: '#dac778',
    Bayangan: '#ab8eaf',
  };
  const roleIcons = {
    Vanguard: '⚔',
    Guardian: '◈',
    Arcanist: '✧',
    Medic: '✚',
    Ranger: '➶',
    Trickster: '◇',
  };
  let csrf = '',
    pending = null;
  const pendingKey = 'hara-rpg-pending-v1';
  $('#login-retry').onclick = () => location.reload();
  async function request(path, method = 'GET', body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch('/rpg/api' + path, {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          headers:
            method === 'GET' ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(15000),
        });
        let data;
        try {
          data = await response.json();
        } catch {
          const e = new Error('Respons server tidak lengkap.');
          e.status = 502;
          throw e;
        }
        if (!response.ok) {
          const e = new Error(
            data.error?.message || data.message || 'Permintaan belum bisa diproses.',
          );
          e.status = response.status;
          e.code = data.error?.code;
          throw e;
        }
        return data;
      } catch (error) {
        if (attempt === 2 || (error.status && error.status < 500)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
  }
  const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket');
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (ticket) {
    try {
      csrf = (await request('/session/exchange', 'POST', { ticket })).csrf;
    } catch (error) {
      // A response can be lost after the cookie was set. Recover the existing
      // session before asking for another one-use link.
      try {
        await request('/profile');
      } catch {
        throw error;
      }
    }
  }
  const initial = await request('/profile');
  csrf = initial.csrf;
  const C = await request('/catalog');
  if (C.version !== 'arunika-v1') throw new Error('Versi game berubah. Muat ulang halaman.');
  const byId = new Map(C.characters.map((c) => [c.id, c]));
  const featured = byId.get(C.featured);
  const stages = C.stages;
  let state = initial.profile,
    battle = initial.battle;
  let busy = false,
    auto = false,
    speed = 1,
    currentTab = 'battle',
    rarityFilter = 0,
    autoTimer,
    toastTimer;
  function storePending(value) {
    pending = value;
    try {
      if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value));
      else sessionStorage.removeItem(pendingKey);
    } catch {
      /* Memory-only retry still works in this tab. */
    }
    if (!pending) $('#sync-note').hidden = true;
  }
  function applySnapshot(data) {
    state = data.profile;
    battle = data.battle;
    wallet();
    renderGacha();
    if (battle) {
      renderBattle();
      renderJourney();
      renderResult();
    }
    if (currentTab === 'collection') renderCollection();
    if (data.results?.length) renderPulls(data.results);
  }
  async function refresh() {
    const data = await request('/profile');
    csrf = data.csrf;
    applySnapshot(data);
  }
  async function perform(path, body, method = 'POST', retry = false) {
    if (busy) return;
    if (pending && !retry) {
      toast('Konfirmasi dulu aksi sebelumnya melalui tombol Coba ulang aksi.');
      return;
    }
    setAuto(auto && !!path?.includes('/actions'));
    if (!retry)
      storePending({
        path,
        method,
        body: { ...body, request_id: crypto.randomUUID() },
        owner: state.id,
      });
    busy = true;
    $('#sync-note').hidden = true;
    $('#retry-pending').disabled = true;
    if (battle) renderCommands();
    renderGacha();
    try {
      const data = await request(pending.path, pending.method, pending.body);
      storePending(null);
      applySnapshot(data);
      return data;
    } catch (error) {
      setAuto(false);
      // 4xx is a definitive rejection; 5xx/network errors may follow a commit.
      if (error.status >= 400 && error.status < 500) storePending(null);
      $('#sync-note').hidden = !pending;
      if (error.status === 401) {
        $('#game-shell').hidden = true;
        $('#login-screen').hidden = false;
        $('#login-message').textContent = error.message;
      } else {
        toast(error.message);
        try {
          await refresh();
        } catch {
          /* Keep last confirmed state. */
        }
      }
    } finally {
      busy = false;
      $('#retry-pending').disabled = false;
      if (battle) renderBattle();
      renderGacha();
    }
  }
  function wallet() {
    $('#shards').textContent = fmt(state.shards);
    $('#coins').textContent = fmt(state.coins);
  }
  function toast(message) {
    $('#toast').textContent = message;
    $('#toast').hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ($('#toast').hidden = true), 3600);
  }
  function modal(html, kicker = 'CATATAN PENJELAJAH') {
    setAuto(false);
    $('#modal-body').innerHTML = html;
    $('#modal-kicker').textContent = kicker;
    if (!$('#modal').open) $('#modal').showModal();
  }
  function whenIdle(fn) {
    return () => (busy ? toast('Tunggu aksi ini selesai.') : fn());
  }
  function switchTab(tab) {
    if (busy) return toast('Tunggu aksi ini selesai.');
    setAuto(false);
    currentTab = tab;
    $$('.view').forEach((v) => (v.hidden = v.id !== tab + '-view'));
    $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'collection') renderCollection();
    if (tab === 'gacha') renderGacha();
  }
  function rect(x, y, w, h, fill) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
  }
  function characterParts(c) {
    const role = c.role,
      color = colors[c.element] || '#a5b77a',
      dark = '#2b423c',
      skin = '#eac398',
      hair = ['#59604b', '#774e42', '#c6bc91', '#39584a', '#d7d1ac'][c.rarity - 1];
    let s =
      rect(11, 31, 6, 9, dark) +
      rect(21, 31, 6, 9, dark) +
      rect(9, 38, 8, 3, '#526056') +
      rect(21, 38, 9, 3, '#526056');
    if (['Arcanist', 'Medic'].includes(role)) s += `<path d="M12 17H26L30 36H7Z" fill="${color}"/>`;
    else
      s += rect(9, 19, 20, 14, dark) + rect(11, 18, 16, 13, color) + rect(10, 29, 18, 3, '#e2c89a');
    s +=
      rect(11, 5, 17, 13, hair) +
      rect(9, 8, 20, 8, hair) +
      rect(12, 10, 14, 10, skin) +
      rect(14, 10, 13, 4, skin) +
      rect(12, 6, 16, 6, hair) +
      rect(12, 11, 3, 6, hair) +
      rect(18, 14, 2, 2, dark) +
      rect(25, 14, 2, 2, dark) +
      rect(21, 18, 4, 2, '#b99078');
    s +=
      rect(7, 20, 5, 8, color) +
      rect(5, 26, 5, 5, skin) +
      rect(26, 20, 5, 8, color) +
      rect(28, 27, 4, 4, skin);
    if (role === 'Vanguard')
      s +=
        rect(2, 10, 3, 19, '#e7eadb') +
        rect(3, 7, 2, 4, '#f4efd6') +
        rect(0, 28, 8, 3, '#b99f58') +
        rect(3, 30, 3, 5, '#6a6951') +
        rect(13, 20, 5, 10, '#d18e6b');
    if (role === 'Guardian')
      s +=
        `<path d="M1 20H13V33L7 38 1 32Z" fill="#2f5548"/>` +
        rect(3, 22, 8, 10, '#b2bd9d') +
        rect(6, 22, 2, 13, '#e5d599') +
        rect(9, 4, 22, 6, '#a2b39d') +
        rect(16, 0, 8, 6, '#d2b778');
    if (role === 'Arcanist')
      s +=
        `<path d="M8 9L17 0 25 7 31 11Z" fill="${color}"/>` +
        rect(5, 10, 29, 4, '#38554b') +
        rect(1, 13, 3, 27, '#796957') +
        rect(0, 10, 7, 6, '#e4c96f') +
        rect(1, 11, 3, 3, '#fff1af');
    if (role === 'Medic')
      s +=
        rect(11, 7, 17, 4, '#e6e9d7') +
        rect(17, 5, 3, 7, '#c6d89e') +
        rect(15, 7, 7, 3, '#c6d89e') +
        rect(1, 14, 3, 27, '#8a8c61') +
        rect(0, 10, 7, 5, '#b0cc98') +
        rect(2, 8, 3, 9, '#e8e4a7') +
        rect(16, 22, 8, 12, '#ede8d5');
    if (role === 'Ranger')
      s +=
        `<path d="M7 17L9 5 22 2 32 15 29 21 26 8H13L12 20Z" fill="#698360"/><path d="M2 14Q-7 25 2 38L5 25Z" fill="#ae9064"/>` +
        rect(1, 16, 1, 20, '#efe2ad');
    if (role === 'Trickster')
      s +=
        rect(10, 18, 20, 5, '#c89177') +
        rect(27, 22, 9, 3, '#c89177') +
        rect(1, 25, 4, 10, '#d6e3d5') +
        rect(0, 33, 6, 2, '#9d8250');
    return s;
  }
  function heroSVG(c) {
    return `<svg viewBox="-5 -3 48 48" aria-hidden="true" class="pixel-sprite">${characterParts(c)}</svg>`;
  }
  function enemyParts(kind) {
    if (kind === 'moth')
      return `<path fill="#4a514d" d="M18 16L4 1 0 20 14 28 20 23 26 28 42 17 38 0 23 15Z"/><path fill="#b4bd8d" d="M16 16L6 6 5 19 16 23 18 20 27 22 36 15 35 5 25 17Z"/>${rect(17, 11, 8, 17, '#5a6955')}${rect(19, 13, 5, 5, '#e3cd80')}${rect(19, 9, 1, 4, '#e5d9b4')}${rect(24, 8, 1, 5, '#e5d9b4')}`;
    if (kind === 'boss')
      return `<path fill="#647b5e" d="M16 24L24 12 38 13 51 22 53 44 47 47 48 58 41 59 38 44 25 45 22 60 15 60 16 43 10 37Z"/><path fill="#354f41" d="M26 18L37 18 42 28 40 40 27 42 19 32Z"/><path fill="#a3b884" d="M20 24L28 15 40 19 42 25 37 28 27 28Z"/><path fill="#bfb779" d="M26 16L21 9 11 8 9 1 13 1 15 5 22 5 22 0 26 0 26 9 30 15 37 14 43 9 43 1 47 1 47 6 53 4 56 0 59 3 55 9 46 13 41 19Z"/>${rect(26, 23, 4, 4, '#ead282')}${rect(36, 23, 4, 4, '#ead282')}${rect(29, 31, 8, 9, '#ceb96c')}${rect(31, 30, 3, 12, '#efdb9c')}${rect(13, 32, 5, 5, '#98a975')}${rect(43, 36, 7, 6, '#a5b47d')}`;
    return `<path d="M4 23L7 14 13 8 21 7 25 3 31 9 38 15 40 25 34 31H9Z" fill="#3b6856"/><path d="M7 23L10 16 16 11 26 10 34 17 36 26 30 29H13Z" fill="#85b894"/>${rect(13, 14, 7, 3, '#bce0ac')}${rect(13, 20, 3, 4, '#253e39')}${rect(28, 20, 3, 4, '#253e39')}${rect(19, 25, 7, 2, '#588b76')}${rect(6, 29, 7, 3, '#65896b')}${rect(31, 29, 8, 3, '#65896b')}`;
  }
  function tree(x, y, scale, shade) {
    return `<g transform="translate(${x} ${y}) scale(${scale})" shape-rendering="crispEdges"><path d="M25 45h9v63h-9z" fill="#5d6950"/><path d="M29 0L4 31H14L0 54H12L2 72H59L48 52H57L42 29H50Z" fill="${shade}"/><path d="M29 4L16 29H26L15 49H31L20 68H38L33 45H41L31 26H37Z" fill="#ffffff0b"/></g>`;
  }
  function background() {
    let trees = '';
    for (let i = 0; i < 14; i++)
      trees += tree(
        i * 82 - 35,
        50 + (i % 3) * 13,
        0.8 + (i % 4) * 0.1,
        i % 2 ? '#799277' : '#8ea184',
      );
    let grass = '';
    for (let i = 0; i < 170; i++) {
      const x = (i * 137) % 1000,
        y = 260 + ((i * 53) % 150);
      grass += rect(x, y, 3 + (i % 3) * 3, 2, i % 3 ? '#63856a60' : '#bdc59580');
    }
    return `<defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="#dde1b9"/><stop offset="1" stop-color="#b7cba8"/></linearGradient><linearGradient id="ground" x2="0" y2="1"><stop stop-color="#8eaa7d"/><stop offset="1" stop-color="#587d61"/></linearGradient><radialGradient id="sun"><stop stop-color="#fff4b4" stop-opacity=".8"/><stop offset="1" stop-color="#fff4b4" stop-opacity="0"/></radialGradient></defs>
      <rect width="1000" height="430" fill="url(#sky)"/><circle cx="615" cy="75" r="130" fill="url(#sun)"/><circle cx="615" cy="75" r="30" fill="#f5e5ad"/><path d="M0 160L130 77 270 152 388 48 570 152 700 64 892 144 1000 112V260H0Z" fill="#abbca0"/><path d="M0 165L150 124 220 170 375 112 507 168 632 125 850 186 1000 158V277H0Z" fill="#95ae91"/>${trees}
      <path d="M0 240Q250 215 510 248T1000 229V430H0Z" fill="url(#ground)"/><path d="M0 322Q178 277 334 320T655 312 1000 322L1000 376Q700 338 440 370T0 368Z" fill="#a4b28a"/><path d="M0 350Q220 308 432 350T800 341L1000 356" fill="none" stroke="#b8be9290" stroke-width="9"/>${grass}
      <g shape-rendering="crispEdges" opacity=".9"><path d="M448 101H465V215H445ZM535 107H553V217H533ZM455 94H546V112H455Z" fill="#6e8469"/><path d="M460 110H532V124H460Z" fill="#8b9d78"/>${rect(446, 141, 21, 5, '#b7ba8d')}${rect(533, 165, 22, 5, '#b7ba8d')}${rect(478, 103, 14, 14, '#405d4d')}${rect(482, 107, 6, 7, '#dfca76')}${rect(493, 211, 35, 9, '#718366')}${rect(435, 217, 128, 7, '#768c6d')}</g>
      ${tree(-42, 18, 2.7, '#385d48')}${tree(912, -8, 3, '#2f5845')}<path d="M0 422V385L45 405 81 382 118 406 175 388 204 421ZM1000 422V386L955 408 911 380 883 408 829 399 800 430Z" fill="#345d46"/>
      ${[110, 204, 390, 570, 645, 781, 895].map((x, i) => `<circle cx="${x}" cy="${175 + (i % 3) * 42}" r="3" fill="#f6e7a2" opacity=".8"/>`).join('')}`;
  }
  const heroPositions = [
    [688, 156],
    [790, 194],
    [694, 270],
    [820, 307],
  ];
  async function startBattle(index = 0) {
    if (busy || pending) {
      toast('Tunggu atau konfirmasi aksi sebelumnya.');
      return;
    }
    setAuto(false);
    if (battle && !battle.done) {
      if (battle.stage === index) {
        $('#modal').close();
        switchTab('battle');
        return;
      }
      if (!confirm('Mundur dari battle aktif tanpa hadiah untuk pindah lokasi?')) return;
      if (
        !(await perform('/battles/' + battle.id + '/retreat', {
          expected_revision: battle.revision,
        }))
      )
        return;
    }
    $('#modal').close();
    switchTab('battle');
    await perform('/battles', { stage: index });
  }

  function renderScene() {
    $('#battle-scene').setAttribute(
      'viewBox',
      window.innerWidth <= 620 ? '145 0 745 430' : '0 0 1000 430',
    );
    const enemies = battle.enemies
      .map((e, i) => {
        const x = stages[battle.stage].boss ? 270 : 250 + i * 120,
          y = stages[battle.stage].boss ? 212 : 213 + i * 102;
        const scale = e.kind === 'boss' ? 3 : 2.65;
        return `<g class="enemy-target" data-enemy="${i}" tabindex="${e.hp > 0 ? 0 : -1}" role="button" aria-label="${esc(e.name)}, HP ${Math.round(e.hp)} dari ${e.max}" opacity="${e.hp > 0 ? 1 : 0.18}"><ellipse cx="${x}" cy="${y + 36}" rx="${e.kind === 'boss' ? 90 : 63}" ry="15" class="sprite-shadow"/><ellipse class="target-ring" cx="${x}" cy="${y + 36}" rx="${e.kind === 'boss' ? 95 : 66}" ry="18" fill="none" stroke="#efe1a3" stroke-width="2" stroke-dasharray="8 5" opacity="${battle.target === i && e.hp > 0 ? 0.9 : 0}"/><g id="enemy-sprite-${i}" transform="translate(${x - (e.kind === 'boss' ? 100 : 55)} ${y - (e.kind === 'boss' ? 140 : 52)}) scale(${scale})" class="pixel-sprite"><g class="${e.kind === 'moth' ? 'idle-float' : ''}">${enemyParts(e.kind)}</g></g><rect x="${x - 70}" y="${y + 65}" width="140" height="36" rx="4" fill="#edf0dcd9"/><text x="${x}" y="${y + 80}" text-anchor="middle" fill="#2d4e3c" font-family="Arial,sans-serif" font-size="11">${esc(e.name)}</text><rect x="${x - 56}" y="${y + 86}" width="112" height="4" rx="2" fill="#b8c5a8"/><rect x="${x - 56}" y="${y + 86}" width="${112 * Math.max(0, e.hp / e.max)}" height="4" rx="2" fill="#b49664"/><text x="${x}" y="${y - 67}" text-anchor="middle" fill="#4c5e42" font-family="Arial,sans-serif" font-size="10">${e.hp > 0 ? (e.charged ? '✦ Bersiap menyerang kuat' : '⚔ Bersiap menyerang') : ''}</text></g>`;
      })
      .join('');
    const heroes = battle.heroes
      .map((c, i) => {
        const [x, y] = heroPositions[i];
        return `<g opacity="${c.hp <= 0 ? 0.18 : c.acted ? 0.6 : 1}"><ellipse cx="${x}" cy="${y + 30}" rx="35" ry="9" class="sprite-shadow"/>${battle.active === i && !battle.done ? `<ellipse cx="${x}" cy="${y + 31}" rx="41" ry="12" fill="none" stroke="#f4e4a4" stroke-width="2"/><path d="M${x - 5} ${y - 77}l5 6 5-6" fill="#f5e6a9"/>` : ''}<g id="hero-sprite-${i}" transform="translate(${x + 38} ${y - 55}) scale(-2.1 2.1)" class="pixel-sprite">${characterParts(c)}</g>${c.guard ? `<text x="${x - 42}" y="${y - 7}" font-size="25" fill="#dceca1">◈</text>` : ''}</g>`;
      })
      .join('');
    $('#battle-scene').innerHTML = background() + enemies + heroes;
    $$('[data-enemy]').forEach((e) => {
      const choose = () => {
        if (busy || !!pending || battle.done || battle.enemies[+e.dataset.enemy].hp <= 0) return;
        battle.target = +e.dataset.enemy;
        renderScene();
        renderCommands();
      };
      e.onclick = choose;
      e.onkeydown = (evt) => {
        if (evt.key === 'Enter' || evt.key === ' ') {
          evt.preventDefault();
          choose();
        }
      };
    });
  }
  function renderBattle() {
    renderScene();
    const stage = stages[battle.stage];
    const region = C.regions[stage.region];
    $('#battle-view h1').innerHTML = esc(region.name) + '<span>.</span>';
    $('#battle-view .subtitle').textContent = region.lore;
    $('#battle-view .eyebrow').textContent =
      'BAB ' + String(stage.region + 1).padStart(2, '0') + ' · MENYALAKAN KEMBALI FAJAR';
    $('.scene-caption span').textContent = region.name.toUpperCase();
    $('.panel-title span:last-child').textContent =
      String(stage.region + 1).padStart(2, '0') + ' / 10';
    $('.region-art>span').textContent = region.name;
    $('#combat-log').textContent = battle.logs[0] || 'Pilih aksi.';
    $('#stage-name').textContent = stage.name;
    $('#stage-level').textContent = `Lv. ${stage.level}${stage.boss ? ' · BOSS' : ''}`;
    $('#round-label').textContent = 'RONDE ' + String(battle.round).padStart(2, '0');
    $('#phase-label').textContent = battle.done
      ? 'Pertarungan selesai'
      : battle.phase === 'enemy'
        ? 'Giliran musuh'
        : 'Giliran timmu';
    $('#turn-order').innerHTML =
      battle.heroes
        .map(
          (h, i) =>
            `<span class="turn-chip ${h.acted || h.hp <= 0 ? 'spent' : ''} ${i === battle.active && battle.phase === 'player' ? 'current' : ''}" title="${esc(h.name)}">${roleIcons[h.role] || '✧'}</span>`,
        )
        .join('') +
      '<span style="color:#9ea88e">→</span><span class="turn-chip" title="Fase musuh">♟</span>';
    $('#party').innerHTML = battle.heroes
      .map(
        (h, i) =>
          `<button class="hero-card ${i === battle.active ? 'active' : ''} ${h.acted ? 'acted' : ''} ${h.hp <= 0 ? 'down' : ''}" data-hero="${i}" ${busy || h.acted || h.hp <= 0 || battle.done ? 'disabled' : ''} aria-label="${esc(h.name)}, ${h.hp}/${h.max} HP, ${h.energy} energi"><span class="role-tag">${h.role}</span><span class="portrait">${heroSVG(h)}</span><span><b>${esc(h.name)}</b><span class="hero-meta"><span class="stars">${stars(h.rarity)}</span><span>Lv.${stage.level}</span></span><span class="hp-track"><i style="width:${(h.hp / h.max) * 100}%"></i></span><span class="hp-number">${Math.round(h.hp)} / ${h.max}</span><span class="energy">${Array.from({ length: 5 }, (_, n) => `<span class="${n < h.energy ? 'charged' : ''}">◆</span>`).join('')}</span></span></button>`,
      )
      .join('');
    $$('[data-hero]').forEach(
      (btn) =>
        (btn.onclick = () => {
          if (busy) return;
          battle.active = +btn.dataset.hero;
          renderBattle();
        }),
    );
    renderCommands();
  }
  function renderCommands() {
    const hero = battle.heroes[battle.active];
    $('#actor-name').textContent = hero.name;
    $('#actor-caption').textContent = hero.element.toUpperCase() + ' · ' + hero.role.toUpperCase();
    $('#target-caption').textContent = 'Target: ' + (battle.enemies[battle.target]?.name || '—');
    $$('[data-action]').forEach((btn) => {
      const a = btn.dataset.action;
      btn.disabled =
        busy ||
        !!pending ||
        battle.done ||
        hero.acted ||
        hero.hp <= 0 ||
        (a === 'skill' && hero.energy < 2) ||
        (a === 'ultimate' && hero.energy < 5);
      if (a === 'skill')
        btn.title =
          'Efek skill: ' +
          (hero.role === 'Medic'
            ? 'Pulihkan 38% HP maksimal rekan hidup dengan persentase HP terendah.'
            : hero.role === 'Guardian'
              ? 'Kurangi damage ke seluruh tim 50% sampai akhir fase musuh.'
              : 'Serang satu target dengan kekuatan 1,85×.');
    });
    $('#retreat').disabled = busy || !!pending || battle.done;
  }
  function renderJourney() {
    const region = stages[battle.stage].region;
    $('#journey').innerHTML = stages
      .map((s, i) => ({ ...s, index: i }))
      .filter((s) => s.region === region)
      .map(
        (s) =>
          `<button class="journey-node ${s.index === battle.stage ? 'current' : ''} ${s.index > state.unlocked ? 'locked' : ''}" data-stage="${s.index}" ${s.index > state.unlocked ? 'disabled' : ''}><span class="node-icon">${state.cleared.includes(s.index) ? '✓' : s.index > state.unlocked ? '·' : s.icon}</span><span><b>Jalur ${s.level} ${s.boss ? '· Boss' : ''}</b><small>${s.label}</small></span></button>`,
      )
      .join('');
    $$('[data-stage]').forEach((btn) => (btn.onclick = () => void startBattle(+btn.dataset.stage)));
    const current = $('#journey .current');
    if (current)
      $('#journey').scrollTop = Math.max(0, current.offsetTop - $('#journey').offsetTop - 100);
  }
  function effect(target, text) {
    const node = document.querySelector(target);
    if (node) {
      node.classList.add('hit-flash');
      setTimeout(() => node.classList.remove('hit-flash'), 550 / speed);
    }
    const svg = $('#battle-scene');
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', target.includes('enemy') ? '315' : '760');
    label.setAttribute('y', '180');
    label.setAttribute('class', 'float-damage');
    label.textContent = text;
    svg.append(label);
    setTimeout(() => label.remove(), 900 / speed);
  }

  async function act(action) {
    if (busy || pending || !battle || battle.done) return;
    const actor = battle.active,
      target = battle.target;
    const previous = battle.enemies.map((e) => e.hp);
    const data = await perform('/battles/' + battle.id + '/actions', {
      expected_revision: battle.revision,
      actor,
      action,
      target,
    });
    if (!data) return;
    for (let i = 0; i < previous.length; i++)
      if (previous[i] > battle.enemies[i].hp)
        effect('#enemy-sprite-' + i, '−' + (previous[i] - battle.enemies[i].hp));
    scheduleAuto();
  }
  function renderResult() {
    $('#battle-overlay').hidden = !battle?.done;
    if (!battle?.done) return;
    const win = battle.result === 'win';
    const title = win
      ? 'Cahaya ditemukan.'
      : battle.result === 'lose'
        ? 'Istirahat sejenak.'
        : 'Kembali ke perkemahan.';
    const desc = win
      ? battle.first_clear
        ? `+${battle.reward_shards} Embun Bintang · +${battle.reward_coins} koin. Progres tersimpan.`
        : 'Latihan selesai. Hadiah pertama sudah pernah diambil.'
      : 'Tidak ada hadiah. Kamu bisa mencoba lagi atau menyusun tim baru.';
    $('#battle-overlay').innerHTML =
      `<span class="result-emblem">${win ? '✦' : '☾'}</span><h2>${title}</h2><p>${desc}</p><div class="result-actions"><button class="button" id="retry-battle">Coba lagi</button>${win && battle.stage < stages.length - 1 ? '<button class="button secondary" id="next-battle">Lanjutkan →</button>' : ''}</div>`;
    $('#retry-battle').onclick = () => void startBattle(battle.stage);
    if ($('#next-battle')) $('#next-battle').onclick = () => void startBattle(battle.stage + 1);
    setAuto(false);
  }
  function setAuto(on) {
    auto = on;
    clearTimeout(autoTimer);
    $('#auto-button').setAttribute('aria-pressed', String(auto));
    $('#auto-button').innerHTML = `Auto <span>${auto ? 'ON' : 'OFF'}</span>`;
    if (on) scheduleAuto();
  }
  function scheduleAuto() {
    clearTimeout(autoTimer);
    if (!auto || busy || !!pending || battle.done || currentTab !== 'battle' || $('#modal').open)
      return;
    autoTimer = setTimeout(() => {
      const h = battle.heroes[battle.active];
      const hurt = battle.heroes.some((a) => a.hp > 0 && a.hp / a.max < 0.72);
      const skill =
        h.role === 'Medic'
          ? hurt
          : h.role === 'Guardian'
            ? battle.enemies.some((e) => e.hp > 0 && e.charged)
            : true;
      void act(h.energy >= 5 ? 'ultimate' : h.energy >= 2 && skill ? 'skill' : 'attack');
    }, 800 / speed);
  }
  function renderCollection() {
    const query = $('#character-search').value.toLocaleLowerCase();
    const list = C.characters.filter(
      (c) =>
        (!rarityFilter || c.rarity === rarityFilter) &&
        `${c.name} ${c.role} ${c.element}`.toLocaleLowerCase().includes(query),
    );
    $('#collection-count').textContent =
      Object.keys(state.collection).filter((id) => byId.has(id)).length +
      ' / ' +
      C.characters.length +
      ' dimiliki';
    $('#collection-grid').innerHTML = list.length
      ? list
          .map(
            (c) =>
              `<button class="collection-card ${state.collection[c.id] ? '' : 'unowned'}" data-character="${c.id}" style="--rarity:var(--r${c.rarity})"><div class="collection-art">${heroSVG(c)}</div><span class="owned-label">${state.party.includes(c.id) ? 'DALAM TIM' : state.collection[c.id] ? 'DIMILIKI ×' + state.collection[c.id] : 'BELUM DIMILIKI'}</span><div class="collection-copy"><span class="stars">${stars(c.rarity)}</span><b>${esc(c.name)}</b><small>${c.element} · ${c.role}</small></div></button>`,
          )
          .join('')
      : '<p class="empty">Karakter tidak ditemukan.</p>';
    $$('[data-character]').forEach(
      (btn) => (btn.onclick = () => characterDetail(btn.dataset.character)),
    );
  }
  function characterDetail(id) {
    const c = byId.get(id),
      owned = state.collection[id] > 0;
    modal(
      `<div class="character-detail-top">${heroSVG(c)}<div><span class="stars">${stars(c.rarity)}</span><h2>${esc(c.name)}</h2><p>${c.element} · ${c.role}<br>${esc(c.personality)}</p></div></div><p class="concept-note">Versi awal memakai skill berdasarkan role: Medic memulihkan, Guardian melindungi tim, role lain menyerang kuat. Elemen aktif; kit unik dan pasif di bawah masih rancangan.</p><h3>${esc(c.skill.name)}</h3><p>${esc(c.skill.description)}</p><p><b>Pasif · ${esc(c.passive.name)}</b><br>${esc(c.passive.description)}</p><h3>Arah desain</h3><p>${esc(c.visual)}</p><details><summary>Prompt sprite</summary><pre>${esc(c.art.sprite_prompt)}</pre></details><h3>${owned ? 'Atur tim' : 'Belum bergabung'}</h3>${owned ? `<p>Empat karakter berbeda. Selesaikan atau mundur dari battle aktif sebelum mengganti anggota.</p><div class="detail-team">${state.party.map((other, i) => `<button class="button outline" data-replace="${i}" ${state.party.includes(id) ? 'disabled' : ''}>${i + 1} · ${esc(byId.get(other).name)}</button>`).join('')}</div>` : '<p>Karakter ini tersedia dalam pemanggilan.</p>'}`,
      'ARSIP KARAKTER',
    );
    $$('[data-replace]').forEach(
      (btn) =>
        (btn.onclick = async () => {
          if (busy || pending) return;
          const slot = +btn.dataset.replace;
          if (battle && !battle.done) {
            if (!confirm('Mundur dari battle aktif tanpa hadiah untuk mengganti tim?')) return;
            if (
              !(await perform('/battles/' + battle.id + '/retreat', {
                expected_revision: battle.revision,
              }))
            )
              return;
          }
          const party = [...state.party];
          party[slot] = id;
          if (await perform('/party', { party, expected_revision: state.revision }, 'PUT')) {
            $('#modal').close();
            toast(c.name + ' bergabung dengan tim.');
          }
        }),
    );
  }
  function renderGacha() {
    $('#featured-art').innerHTML = heroSVG(featured);
    $('#featured-name').textContent = featured.name;
    $('#featured-subtitle').textContent =
      featured.element + ' · ' + featured.role + ' — ' + featured.passive.name;
    $('#pity-five').textContent = state.pity5 + ' / 80';
    $('#pity-four').textContent = state.pity4 + ' / 10';
    $('#pity-progress').style.width = (state.pity5 / 80) * 100 + '%';
    $('#featured-guarantee').textContent = state.guarantee
      ? '★5 berikutnya pasti karakter unggulan.'
      : 'Saat mendapat ★5: 50% peluang karakter unggulan.';
    $('#pull-one').disabled = busy || !!pending || state.shards < 160;
    $('#pull-ten').disabled = busy || !!pending || state.shards < 1600;
  }

  function renderPulls(results) {
    $('#summon-results').innerHTML = results
      .map(
        ({ character: c, duplicate }, i) =>
          `<article class="summon-result" style="--rarity:var(--r${c.rarity});animation-delay:${i * 0.045}s">${heroSVG(c)}<span class="stars">${stars(c.rarity)}</span><b>${esc(c.name)}</b><small>${duplicate ? 'Duplikat · +' + [0, 5, 10, 20, 40, 80][c.rarity] + ' Debu Gema' : 'Baru dalam koleksi'}</small></article>`,
      )
      .join('');
  }
  async function summon(count) {
    if (busy || pending) return;
    $('.summon-banner').classList.add('summoning');
    const data = await perform('/gacha/pulls', { banner_id: 'fajar-v1', count });
    $('.summon-banner').classList.remove('summoning');
    if (data) toast(count + ' hasil tersimpan. Debu Gema: ' + state.dust);
  }
  function showWorld() {
    modal(
      `<h2>Sepuluh wilayah. Satu fajar.</h2><p>Level 1–999. Selesaikan jalur secara berurutan untuk membuka lokasi berikutnya.</p><div class="world-grid">${C.regions.map((r, i) => `<button class="world-tile" data-region="${i}"><span>${String(i + 1).padStart(2, '0')} · ${r.min_level - 1 <= state.unlocked ? 'TERBUKA' : 'TERKUNCI'}</span><b>${esc(r.name)}</b><small>LEVEL ${r.min_level}–${r.max_level}</small></button>`).join('')}</div>`,
      'ATLAS ARUNIKA',
    );
    $$('[data-region]').forEach(
      (btn) =>
        (btn.onclick = () => {
          const index = +btn.dataset.region,
            r = C.regions[index];
          const nodes = stages
            .map((s, i) => ({ ...s, index: i }))
            .filter((s) => s.region === index);
          modal(
            `<button class="button outline world-back" id="atlas-back">← Semua wilayah</button><h2>${esc(r.name)}</h2><p>Level ${r.min_level}–${r.max_level}. ${esc(r.lore)}</p><div class="world-grid">${nodes.map((s) => `<button class="world-tile" data-travel="${s.index}" ${s.index > state.unlocked ? 'disabled' : ''}><span>${state.cleared.includes(s.index) ? 'SELESAI' : s.index > state.unlocked ? 'TERKUNCI' : 'BISA DIJELAJAHI'}</span><b>Jalur ${s.level}</b><small>${s.label}</small></button>`).join('')}</div>`,
            'ATLAS ARUNIKA',
          );
          $('#atlas-back').onclick = showWorld;
          $$('[data-travel]').forEach(
            (btn) => (btn.onclick = () => void startBattle(+btn.dataset.travel)),
          );
        }),
    );
  }
  function rates() {
    modal(
      '<h2>Peluang yang terbuka.</h2><table><thead><tr><th>BINTANG</th><th>PELUANG DASAR</th><th>KARAKTER</th></tr></thead><tbody>' +
        [1, 2, 3, 4, 5]
          .map(
            (s, i) =>
              `<tr><td class="stars">${stars(s)}</td><td>${[40, 30, 20, 8, 2][i]}%</td><td>12</td></tr>`,
          )
          .join('') +
        '</tbody></table><p>1 tarikan = 160 Embun Bintang. Sepuluh tarikan = 1.600, dihitung satu per satu. Pemanggilan memakai mata uang permainan, tanpa uang asli.</p><ul><li>★4 atau lebih paling lambat tarikan ke-10 sejak ★4/★5 terakhir.</li><li>★5: peluang dasar 2%. Mulai tarikan 61, peluang naik 5 poin persentase per tarikan; tarikan 80 dijamin ★5.</li><li>Prioritas: cek ★5 → jaminan ★4 → distribusi ★1–4. Saat peluang ★5 naik, bobot ★1–4 dibagi proporsional 40:30:20:8.</li><li>★5 mereset dua penghitung. ★4 hanya mereset penghitung ★4.</li><li>★5 memiliki peluang 50% menjadi karakter unggulan. Jika kalah, ★5 berikutnya pasti unggulan.</li><li>Duplikat dicatat sebagai salinan + 5/10/20/40/80 Debu Gema menurut bintang. Upgrade duplikat belum dibuat.</li></ul><p>Koleksi, saldo, dan pity tersimpan di akun yang sama dengan bot.</p>',
      'ATURAN PEMANGGILAN',
    );
  }
  function help() {
    modal(
      `<h2>Perjalanan ${esc(state.name)}.</h2><p>Progres terhubung dengan akun WhatsApp. Battle, saldo, hasil gacha, dan pity otomatis tersimpan di akunmu.</p><ol><li>Pilih musuh dan anggota tim yang belum bergerak.</li><li>Serang +1 energi, skill −2, bertahan +2, Ultimate memerlukan 5. Guardian mengurangi damage tim; Medic memulihkan.</li><li>Keunggulan elemen: Api → Angin → Tanah → Air → Api; Cahaya dan Bayangan saling unggul.</li><li>Tutup browser kapan saja. Buka .rpg lanjut untuk kembali ke battle tersimpan.</li><li>Hadiah cerita pertama hanya sekali. Latihan ulang tidak memberi hadiah tambahan.</li></ol><p>Versi awal: level tim mengikuti jalur yang sudah terbuka; leveling terpisah, equipment, dan kit unik belum aktif. Sprite masih sketsa role/archetype.</p><p>Saldo awal 1.600 Embun Bintang diberikan sekali. Jalur biasa memberi 20 Embun; boss wilayah 200. Gacha bisa dilakukan dari web atau .rpg gacha 1 / 10.</p><div class="account-actions"><button class="button outline" id="history-button">Riwayat gacha</button><button class="button outline" id="logout-button">Keluar akun</button></div>`,
      'PANDUAN PENJAGA',
    );
    $('#history-button').onclick = async () => {
      try {
        const data = await request('/gacha/history');
        modal(
          '<h2>20 pemanggilan terakhir</h2>' +
            data.history
              .map(
                (entry) =>
                  `<p>${new Date(entry.created_at * 1000).toLocaleString('id-ID')}<br>${entry.results.map((p) => stars(p.character.rarity) + ' ' + esc(p.character.name)).join('<br>')}</p>`,
              )
              .join('') +
            (data.history.length ? '' : '<p>Belum ada pemanggilan.</p>'),
          'RIWAYAT AKUN',
        );
      } catch (error) {
        toast(error.message);
      }
    };
    $('#logout-button').onclick = async () => {
      if (pending) return toast('Konfirmasi aksi tertunda sebelum keluar.');
      try {
        await request('/session/logout', 'POST', {});
        location.reload();
      } catch (error) {
        toast(error.message);
      }
    };
  }
  $$('[data-tab]').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));
  $$('[data-action]').forEach((b) => (b.onclick = () => void act(b.dataset.action)));
  $('#auto-button').onclick = () => setAuto(!auto);
  $('#speed-button').onclick = () => {
    speed = speed === 1 ? 2 : 1;
    $('#speed-button').textContent = speed + '×';
  };
  $('#retreat').onclick = () => {
    if (!busy && !pending && window.confirm('Mundur dari battle ini tanpa hadiah?'))
      void perform('/battles/' + battle.id + '/retreat', { expected_revision: battle.revision });
  };
  $('#world-button').onclick = whenIdle(showWorld);
  $('#log-button').onclick = whenIdle(() =>
    modal(
      '<h2>Catatan pertarungan</h2><ul class="log-list">' +
        battle.logs.map((l) => '<li>' + esc(l) + '</li>').join('') +
        '</ul>',
    ),
  );
  $('#help').onclick = whenIdle(help);
  $('#design-help').onclick = whenIdle(help);
  $('#rates-button').onclick = whenIdle(rates);
  $('#pull-one').onclick = () => void summon(1);
  $('#pull-ten').onclick = () => void summon(10);
  $('#character-search').oninput = renderCollection;
  $$('[data-rarity]').forEach(
    (b) =>
      (b.onclick = () => {
        rarityFilter = +b.dataset.rarity;
        $$('[data-rarity]').forEach((x) => x.classList.toggle('selected', x === b));
        renderCollection();
      }),
  );
  $('#close-modal').onclick = () => $('#modal').close();
  $('#modal').addEventListener('click', (e) => {
    if (e.target === $('#modal')) {
      const r = $('#modal').getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        $('#modal').close();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setAuto(false);
  });
  window.addEventListener('resize', () => {
    if (battle) renderScene();
  });
  $('#retry-pending').onclick = async () => {
    if (pending && !busy) await perform(null, null, 'POST', true);
  };
  $('#login-screen').hidden = true;

  $('#save-status').textContent = 'Akun ' + state.name + ' · tersimpan di server';
  applySnapshot(initial);
  try {
    const stored = JSON.parse(sessionStorage.getItem(pendingKey) || 'null');
    if (
      stored?.owner === state.id &&
      typeof stored.path === 'string' &&
      stored.path.startsWith('/') &&
      stored.body?.request_id &&
      ['POST', 'PUT'].includes(stored.method)
    )
      storePending(stored);
    else storePending(null);
  } catch {
    storePending(null);
  }
  if (pending) await perform(null, null, 'POST', true);
  if (!battle && !pending) await startBattle(0);
  if (!battle)
    throw new Error(
      'Battle belum terkonfirmasi. Coba sambungkan lagi; permintaan yang sama akan dilanjutkan.',
    );
  $('#game-shell').hidden = false;
  window.addEventListener('focus', () => {
    if (!busy && !pending) {
      setAuto(false);
      void refresh().catch((error) => toast(error.message));
    }
  });
})().catch((error) => {
  document.querySelector('#game-shell').hidden = true;
  document.querySelector('#login-screen').hidden = false;
  document.querySelector('#login-message').textContent =
    error.message || 'Koneksi game belum tersedia.';
});
