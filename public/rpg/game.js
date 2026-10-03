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
  // getRandomValues also works on the HTTP origin used inside the tailnet.
  const requestID = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
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
  const [C, art] = await Promise.all([
    request('/catalog'),
    fetch('/rpg/assets/index.json', { cache: 'no-store' }).then(async (response) => {
      if (!response.ok) throw new Error('Daftar gambar game belum tersedia. Muat ulang halaman.');
      return response.json();
    }),
  ]);
  function artPath(kind, id) {
    const value = art[kind]?.[id];
    if (!value) throw new Error('Gambar katalog belum lengkap: ' + id);
    return esc(value);
  }
  if (!['arunika-v1', 'arunika-v2', 'arunika-v3'].includes(C.version))
    throw new Error('Versi game berubah. Muat ulang halaman.');
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
        body: { ...body, request_id: requestID() },
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
    $('#modal').scrollTop = 0;
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
  function characterParts(c) {
    return `<image href="${artPath('characters', c.id)}" x="-5" y="-3" width="48" height="48"/>`;
  }
  function heroArt(c) {
    return `<img src="${artPath('characters', c.id)}" alt="" width="128" height="128" class="pixel-sprite" loading="lazy" decoding="async"/>`;
  }
  function background() {
    const region = C.regions[stages[battle.stage].region];
    return `<image href="${artPath('arenas', region.id)}" width="1000" height="430" preserveAspectRatio="xMidYMid slice"/>`;
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
        const size = e.kind === 'boss' ? 190 : 128;
        return `<g class="enemy-target" data-enemy="${i}" tabindex="${e.hp > 0 ? 0 : -1}" role="button" aria-label="${esc(e.name)}, HP ${Math.round(e.hp)} dari ${e.max}" opacity="${e.hp > 0 ? 1 : 0.18}"><ellipse cx="${x}" cy="${y + 36}" rx="${e.kind === 'boss' ? 90 : 63}" ry="15" class="sprite-shadow"/><ellipse class="target-ring" cx="${x}" cy="${y + 36}" rx="${e.kind === 'boss' ? 95 : 66}" ry="18" fill="none" stroke="#efe1a3" stroke-width="2" stroke-dasharray="8 5" opacity="${battle.target === i && e.hp > 0 ? 0.9 : 0}"/><g id="enemy-sprite-${i}" transform="translate(${x - size / 2} ${y + 36 - size})" class="pixel-sprite"><g class="${e.kind === 'moth' ? 'idle-float' : ''}"><image href="${artPath('enemies', e.id)}" width="${size}" height="${size}"/></g></g><rect x="${x - 70}" y="${y + 65}" width="140" height="36" rx="4" fill="#edf0dcd9"/><text x="${x}" y="${y + 80}" text-anchor="middle" fill="#2d4e3c" font-family="Arial,sans-serif" font-size="11">${esc(e.name)}</text><rect x="${x - 56}" y="${y + 86}" width="112" height="4" rx="2" fill="#b8c5a8"/><rect x="${x - 56}" y="${y + 86}" width="${112 * Math.max(0, e.hp / e.max)}" height="4" rx="2" fill="#b49664"/><text x="${x}" y="${y - 67}" text-anchor="middle" fill="#fff7dc" stroke="#294033" stroke-width="3" paint-order="stroke" stroke-linejoin="round" font-family="Arial,sans-serif" font-size="10">${e.hp > 0 ? (e.charged ? '✦ Bersiap menyerang kuat' : '⚔ Bersiap menyerang') : ''}</text></g>`;
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
    $('#region-artwork').src = art.arenas[region.id];
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
          `<button class="hero-card ${i === battle.active ? 'active' : ''} ${h.acted ? 'acted' : ''} ${h.hp <= 0 ? 'down' : ''}" data-hero="${i}" ${busy || h.acted || h.hp <= 0 || battle.done ? 'disabled' : ''} aria-label="${esc(h.name)}, ${h.hp}/${h.max} HP, ${h.energy} energi"><span class="role-tag">${h.role}</span><span class="portrait">${heroArt(h)}</span><span><b>${esc(h.name)}</b><span class="hero-meta"><span class="stars">${stars(h.rarity)}</span><span>Lv.${h.level || stage.level}${h.awakening ? ` · A${h.awakening}` : ''}</span></span><span class="hp-track"><i style="width:${(h.hp / h.max) * 100}%"></i></span><span class="hp-number">${Math.round(h.hp)} / ${h.max}${h.shield ? ' · ◈ ' + h.shield : ''}</span><span class="energy">${Array.from({ length: 5 }, (_, n) => `<span class="${n < h.energy ? 'charged' : ''}">◆</span>`).join('')}</span></span></button>`,
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
    $('#target-caption').textContent =
      'Target: ' +
      (battle.enemies[battle.target]?.name || '—') +
      enemyStatus(battle.enemies[battle.target]);
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
          (battle.rules !== 'arunika-v1'
            ? byId.get(hero.id).skill.description
            : hero.role === 'Medic'
              ? 'Pulihkan 38% HP maksimal rekan hidup dengan persentase HP terendah.'
              : hero.role === 'Guardian'
                ? 'Kurangi damage ke seluruh tim 50% sampai akhir fase musuh.'
                : 'Serang satu target dengan kekuatan 1,85×.');
    });
    $('#retreat').disabled = busy || !!pending || battle.done;
    $('#skill-description').textContent =
      hero.skill.name + ' · ' + $('[data-action="skill"]').title;
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
        ? `+${battle.reward_shards} Embun Bintang · +${battle.reward_coins} koin · +${battle.reward_xp || 0} XP untuk tiap anggota tim · +${battle.reward_training_xp || 0} XP latihan.`
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
              `<button class="collection-card ${state.collection[c.id] ? '' : 'unowned'}" data-character="${c.id}" style="--rarity:var(--r${c.rarity})"><div class="collection-art">${heroArt(c)}</div><span class="owned-label">${state.party.includes(c.id) ? 'DALAM TIM' : state.collection[c.id] ? 'DIMILIKI ×' + state.collection[c.id] : 'BELUM DIMILIKI'}</span><div class="collection-copy"><span class="stars">${stars(c.rarity)}</span><b>${esc(c.name)}</b><small>${c.element} · ${c.role}${state.growth?.[c.id] ? ' · Lv.' + state.growth[c.id].level + (state.awakening?.[c.id] ? ' · A' + state.awakening[c.id] : '') : ''}</small></div></button>`,
          )
          .join('')
      : '<p class="empty">Karakter tidak ditemukan.</p>';
    $$('[data-character]').forEach(
      (btn) => (btn.onclick = () => characterDetail(btn.dataset.character)),
    );
  }
  function enemyStatus(e) {
    if (!e) return '';
    const labels = [];
    for (const [key, name] of Object.entries({
      burn: 'Bara',
      weaken: 'ATK↓',
      expose: 'DEF↓',
      slow: 'Lambat',
      blind: 'Kabut',
    })) {
      if (e[key]) labels.push(`${name} ${e[key]}`);
    }
    if (e.mark) labels.push('Tanda');
    if (e.shield) labels.push(`Perisai ${e.shield}`);
    return labels.length ? ' · ' + labels.join(' · ') : '';
  }
  const slotNames = { weapon: 'Senjata', armor: 'Armor', charm: 'Jimat' };
  const gearStats = (item) => {
    const rank = state.enhancements?.[item.id] || 0;
    const stat = (n) =>
      Math.round((n * (100 + (C.progression?.enhancement_percent || 0) * rank)) / 100);
    return [`HP +${stat(item.hp)}`, `ATK +${stat(item.attack)}`, `DEF +${stat(item.defense)}`].join(
      ' · ',
    );
  };
  function awakeningPanel(c, locked) {
    if (C.version !== 'arunika-v3') return '';
    const r = C.progression,
      rank = state.awakening?.[c.id] || 0,
      next = rank + 1;
    const coins = r.awakening_coins * next,
      dust = r.awakening_dust * c.rarity * next;
    return `<section class="awakening-panel"><h3>Awakening · A${rank} / ${r.awakening_max}</h3><p>Bonus HP, ATK, DEF dasar: <b>+${rank * r.awakening_percent}%</b>. Tiap tahap menambah ${r.awakening_percent}%. Bonus equipment dihitung terpisah.</p><p>Debu Bintang: <b>${fmt(state.dust)}</b> · didapat dari duplikat gacha. Karakter dan jumlah salinan tetap dimiliki.</p><button class="button outline" id="awaken-character" ${locked || rank >= r.awakening_max || state.coins < coins || state.dust < dust ? 'disabled' : ''}>${rank >= r.awakening_max ? 'Awakening maksimum' : `Awakening A${next} · ${fmt(coins)} koin + ${fmt(dust)} debu`}</button></section>`;
  }
  function enhancementButton(item, locked) {
    if (C.version !== 'arunika-v3') return '';
    const r = C.progression,
      rank = state.enhancements?.[item.id] || 0,
      next = rank + 1;
    const coins = item.price * next,
      dust = r.enhancement_dust * next;
    return `<p>Upgrade +${rank} / ${r.enhancement_max} · bonus stat equipment ${rank * r.enhancement_percent}%</p><button class="button outline" data-enhance="${item.id}" ${locked || !state.inventory?.[item.id] || rank >= r.enhancement_max || state.coins < coins || state.dust < dust ? 'disabled' : ''}>${rank >= r.enhancement_max ? 'Upgrade maksimum' : `Upgrade +${next} · ${fmt(coins)} koin + ${fmt(dust)} debu`}</button>`;
  }
  function progressionPanel(c) {
    const g = state.growth[c.id],
      locked = busy || !!pending || (battle && !battle.done);
    return `<section class="progression-panel"><h3>Latihan · Lv.${g.level} / ${state.level_cap}</h3><p>${g.xp} / 100 XP menuju level berikutnya. Cadangan: <b>${fmt(state.training_xp)} XP latihan</b> · ${fmt(state.coins)} koin.</p><p>100 XP latihan + 10 koin per level. Naikkan batas level dengan melanjutkan cerita. Karakter baru mengikuti level jalur yang sudah terbuka.</p>${locked ? '<p class="concept-note">Selesaikan atau mundur dari battle sebelum latihan dan mengganti equipment.</p>' : ''}<div class="detail-team">${[1, 10].map((levels) => `<button class="button outline" data-train="${levels}" ${locked || g.level + levels > state.level_cap || state.training_xp < 100 * levels || state.coins < 10 * levels ? 'disabled' : ''}>Latih +${levels} level</button>`).join('')}</div>${awakeningPanel(c, locked)}<h3>Equipment</h3><div class="equipment-slots">${Object.entries(
      slotNames,
    )
      .map(
        ([slot, name]) =>
          `<label>${name}<select data-gear="${slot}" ${locked ? 'disabled' : ''}><option value="">Tanpa ${name.toLowerCase()}</option>${C.equipment
            .filter((item) => item.slot === slot && state.inventory[item.id] > 0)
            .map(
              (item) =>
                `<option value="${item.id}" ${state.loadouts[c.id]?.[slot] === item.id ? 'selected' : ''}>${esc(item.name)} +${state.enhancements?.[item.id] || 0} · ${gearStats(item)}</option>`,
            )
            .join('')}</select></label>`,
      )
      .join(
        '',
      )}</div><button class="button outline" id="open-equipment-shop">Kunjungi bengkel</button></section>`;
  }
  function bindProgression(id) {
    if ($('#awaken-character'))
      $('#awaken-character').onclick = async () => {
        if (busy || pending) return;
        if (
          await perform('/characters/awaken', {
            character_id: id,
            expected_revision: state.revision,
          })
        ) {
          characterDetail(id);
          toast('Awakening tersimpan. Bonus berlaku pada battle baru.');
        }
      };
    $$('[data-train]').forEach(
      (btn) =>
        (btn.onclick = async () => {
          if (busy || pending) return;
          if (
            await perform('/characters/train', {
              character_id: id,
              levels: +btn.dataset.train,
              expected_revision: state.revision,
            })
          ) {
            characterDetail(id);
            toast('Latihan tersimpan. Level berlaku pada battle berikutnya.');
          }
        }),
    );
    $$('[data-gear]').forEach(
      (select) =>
        (select.onchange = async () => {
          if (busy || pending) return;
          await perform(
            '/equipment/equip',
            {
              character_id: id,
              item_id: select.value,
              slot: select.dataset.gear,
              expected_revision: state.revision,
            },
            'PUT',
          );
          characterDetail(id);
        }),
    );
    if ($('#open-equipment-shop')) $('#open-equipment-shop').onclick = () => equipmentShop(id);
  }
  function equipmentShop(returnTo) {
    const locked = busy || !!pending || (battle && !battle.done);
    modal(
      `<h2>Bengkel lentera.</h2><p>Saldo <b>${fmt(state.coins)} koin</b>. Setiap pembelian memberi satu salinan; satu salinan hanya bisa dipasang pada satu karakter. Equipment tidak diundi.</p>${C.version === 'arunika-v3' ? `<p>Debu Bintang: <b>${fmt(state.dust)}</b>. Upgrade menambah ${C.progression.enhancement_percent}% stat dasar per tahap dan berlaku untuk <b>semua salinan jenis equipment yang sama</b>, termasuk pembelian berikutnya. Maksimum +${C.progression.enhancement_max}; tidak ada peluang gagal.</p>` : ''}${locked ? '<p class="concept-note">Selesaikan atau mundur dari battle sebelum berbelanja.</p>' : ''}<div class="equipment-grid">${(C.equipment || []).map((item) => `<article class="equipment-item"><span class="eyebrow">${slotNames[item.slot]}</span><h3>${esc(item.name)}</h3><p>${gearStats(item)}</p><p>Dimiliki: ${state.inventory?.[item.id] || 0}${state.unlocked < item.unlock ? ` · Terbuka setelah jalur ${item.unlock}` : ''}</p><button class="button outline" data-buy="${item.id}" ${locked || state.coins < item.price || state.unlocked < item.unlock || state.inventory?.[item.id] >= 60 ? 'disabled' : ''}>Beli · ${fmt(item.price)} koin</button>${enhancementButton(item, locked)}</article>`).join('')}</div>${returnTo ? '<button class="button secondary" id="back-to-character">Kembali ke karakter</button>' : ''}`,
      'BENGKEL EQUIPMENT',
    );
    $$('[data-buy]').forEach(
      (btn) =>
        (btn.onclick = async () => {
          if (busy || pending) return;
          if (
            await perform('/equipment/buy', {
              item_id: btn.dataset.buy,
              expected_revision: state.revision,
            })
          ) {
            equipmentShop(returnTo);
            toast('Equipment tersimpan di inventori.');
          }
        }),
    );
    $$('[data-enhance]').forEach(
      (btn) =>
        (btn.onclick = async () => {
          if (busy || pending) return;
          if (
            await perform('/equipment/enhance', {
              item_id: btn.dataset.enhance,
              expected_revision: state.revision,
            })
          ) {
            equipmentShop(returnTo);
            toast('Upgrade tersimpan untuk semua salinan equipment ini.');
          }
        }),
    );
    if ($('#back-to-character')) $('#back-to-character').onclick = () => characterDetail(returnTo);
  }
  function characterDetail(id) {
    const c = byId.get(id),
      owned = state.collection[id] > 0;
    modal(
      `<div class="character-detail-top">${heroArt(c)}<div><span class="stars">${stars(c.rarity)}</span><h2>${esc(c.name)}</h2><p>${c.element} · ${c.role}<br>${esc(c.personality)}</p></div></div><p class="concept-note">Skill aktif berikut berlaku pada battle baru. Battle lama memakai aturan sebelumnya sampai selesai. ${C.version === 'arunika-v3' ? 'Passive otomatis aktif pada battle baru; tidak memerlukan awakening.' : 'Pasif di bagian rancangan belum aktif.'}</p><h3>${esc(c.skill.name)}</h3><p>${esc(c.skill.description)}</p><p><b>${C.version === 'arunika-v3' ? 'Passive' : 'Rancangan pasif'} · ${esc(c.passive.name)}</b><br>${esc(c.passive.description)}</p>${owned && C.version !== 'arunika-v1' ? progressionPanel(c) : ''}<h3>Arah desain</h3><p>${esc(c.visual)}</p><details><summary>Prompt sprite</summary><pre>${esc(c.art.sprite_prompt)}</pre></details><h3>${owned ? 'Atur tim' : 'Belum bergabung'}</h3>${owned ? `<p>Empat karakter berbeda. Selesaikan atau mundur dari battle aktif sebelum mengganti anggota.</p><div class="detail-team">${state.party.map((other, i) => `<button class="button outline" data-replace="${i}" ${state.party.includes(id) ? 'disabled' : ''}>${i + 1} · ${esc(byId.get(other).name)}</button>`).join('')}</div>` : '<p>Karakter ini tersedia dalam pemanggilan.</p>'}`,
      'ARSIP KARAKTER',
    );
    bindProgression(id);
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
    $('#featured-art').innerHTML = heroArt(featured);
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
          `<article class="summon-result" style="--rarity:var(--r${c.rarity});animation-delay:${i * 0.045}s">${heroArt(c)}<span class="stars">${stars(c.rarity)}</span><b>${esc(c.name)}</b><small>${duplicate ? 'Duplikat · +' + [0, 5, 10, 20, 40, 80][c.rarity] + ' Debu Bintang' : 'Baru dalam koleksi'}</small></article>`,
      )
      .join('');
  }
  async function summon(count) {
    if (busy || pending) return;
    $('.summon-banner').classList.add('summoning');
    const data = await perform('/gacha/pulls', { banner_id: 'fajar-v1', count });
    $('.summon-banner').classList.remove('summoning');
    if (data) toast(count + ' hasil tersimpan. Debu Bintang: ' + state.dust);
  }
  function showWorld() {
    modal(
      `<h2>Sepuluh wilayah. Satu fajar.</h2><p>Level 1–999. Selesaikan jalur secara berurutan untuk membuka lokasi berikutnya.</p><div class="world-grid">${C.regions.map((r, i) => `<button class="world-tile" data-region="${i}"><img class="world-art" src="${artPath('arenas', r.id)}" width="240" height="100" loading="lazy" decoding="async" alt=""/><span>${String(i + 1).padStart(2, '0')} · ${r.min_level - 1 <= state.unlocked ? 'TERBUKA' : 'TERKUNCI'}</span><b>${esc(r.name)}</b><small>LEVEL ${r.min_level}–${r.max_level}</small></button>`).join('')}</div>`,
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
        '</tbody></table><p>1 tarikan = 160 Embun Bintang. Sepuluh tarikan = 1.600, dihitung satu per satu. Pemanggilan memakai mata uang permainan, tanpa uang asli.</p><ul><li>★4 atau lebih paling lambat tarikan ke-10 sejak ★4/★5 terakhir.</li><li>★5: peluang dasar 2%. Mulai tarikan 61, peluang naik 5 poin persentase per tarikan; tarikan 80 dijamin ★5.</li><li>Prioritas: cek ★5 → jaminan ★4 → distribusi ★1–4. Saat peluang ★5 naik, bobot ★1–4 dibagi proporsional 40:30:20:8.</li><li>★5 mereset dua penghitung. ★4 hanya mereset penghitung ★4.</li><li>★5 memiliki peluang 50% menjadi karakter unggulan. Jika kalah, ★5 berikutnya pasti unggulan.</li><li>Duplikat menambah satu salinan dan 5/10/20/40/80 Debu Bintang sesuai bintangnya. Gunakan Debu Bintang bersama koin untuk awakening karakter dan upgrade equipment di tab Karakter. Salinan karakter tetap dimiliki.</li></ul><p>Koleksi, saldo, dan pity tersimpan di akun yang sama dengan bot.</p>',
      'ATURAN PEMANGGILAN',
    );
  }
  function help() {
    modal(
      `<h2>Perjalanan ${esc(state.name)}.</h2><p>Progres terhubung dengan akun WhatsApp. Battle, saldo, hasil gacha, dan pity otomatis tersimpan di akunmu.</p><ol><li>Pilih musuh dan anggota tim yang belum bergerak.</li><li>Serang +1 energi, skill −2, bertahan +2, Ultimate memerlukan 5. Setiap karakter memiliki skill dan pasif sendiri; baca efeknya di tab Karakter.</li><li>Keunggulan elemen: Api → Angin → Tanah → Air → Api; Cahaya dan Bayangan saling unggul.</li><li>Tutup browser kapan saja. Buka .rpg lanjut untuk kembali ke battle tersimpan.</li><li>Hadiah cerita pertama hanya sekali. Latihan ulang tidak memberi hadiah tambahan.</li></ol><p>Setiap kemenangan cerita pertama memberi anggota tim 100 XP dan menambah 100 XP latihan cadangan. Latih karakter di tab Karakter dengan XP cadangan dan koin. Beli equipment di Bengkel lalu pasang pada slot senjata, pelindung, atau jimat. Selesaikan atau mundur dari battle sebelum latihan atau mengubah perlengkapan.</p><p>Semua 60 karakter memiliki skill aktif dan pasif. Pasif otomatis aktif pada battle baru, tanpa perlu awakening. Awakening A0–A5 menaikkan HP, ATK, dan DEF dasar; upgrade equipment +0–+5 meningkatkan stat seluruh salinan jenis equipment tersebut. Keduanya memakai koin dan Debu Bintang dari duplikat gacha.</p><p>Jelajahi 999 jalur di 10 wilayah dengan 100 spesies musuh. Buka peta untuk melihat wilayah dan jalur yang sudah terbuka.</p><p>Saldo awal 1.600 Embun Bintang diberikan sekali. Jalur biasa memberi 20 Embun; boss wilayah 200. Gacha bisa dilakukan dari web atau .rpg gacha 1 / 10.</p><div class="account-actions"><button class="button outline" id="history-button">Riwayat gacha</button><button class="button outline" id="logout-button">Keluar akun</button></div>`,
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
