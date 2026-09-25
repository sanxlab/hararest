// Real browser -> Hararest gateway -> Go RPG service -> temporary SQLite.
// No WhatsApp login, production DB, paid API, or deployed service is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createServer } = require('node:http');
const express = require('express');
const helmet = require('helmet');
const puppeteer = require('puppeteer');
const { createRpgRouter } = require('../dist/modules/rpg/rpg.route');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const botDir = process.env.KOTONEHARA_DIR || path.resolve(__dirname, '../../kotonehara');
(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hara-rpg-e2e-'));
  const binary = path.join(temp, 'rpg.test');
  const secret = 'browser-test-only-secret-'.repeat(2);
  let backend, server, browser;
  let backendOutput = '';
  const settings = { upstream: '', secret };
  try {
    const build = spawn('go', ['test', '-c', '-o', binary, './internal/rpg'], {
      cwd: botDir,
      stdio: 'inherit',
    });
    assert.equal((await once(build, 'exit'))[0], 0, 'build Go fixture');
    const app = express();
    app.use(helmet());
    let dropDrawResponses = 0;
    const drawRequests = [];
    app.use((req, res, next) => {
      const end = res.end;
      res.end = function (...args) {
        if (
          req.method === 'POST' &&
          req.originalUrl === '/rpg/api/gacha/pulls' &&
          res.statusCode === 200
        ) {
          drawRequests.push(req.body.request_id);
          if (dropDrawResponses > 0) {
            dropDrawResponses--;
            // Simulate a gateway that loses the successful upstream response
            // after commit. A 502 avoids Chromium's transparent socket retries.
            res.statusCode = 502;
            res.removeHeader('Content-Length');
            res.removeHeader('ETag');
            return end.call(
              this,
              JSON.stringify({
                error: {
                  code: 'test_lost_response',
                  message: 'Gateway lost the committed response.',
                },
              }),
            );
          }
        }
        return end.apply(this, args);
      };
      next();
    });
    app.use('/rpg', createRpgRouter(settings));
    server = createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    const startBackend = async () => {
      await fs.rm(path.join(temp, 'ready.json'), { force: true });
      backend = spawn(binary, ['-test.run=^TestBrowserFixture$', '-test.timeout=5m'], {
        env: { ...process.env, RPG_E2E_DIR: temp, RPG_E2E_ORIGIN: origin, RPG_E2E_SECRET: secret },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      backend.stdout.on('data', (data) => {
        backendOutput += data;
      });
      backend.stderr.on('data', (data) => {
        backendOutput += data;
      });
      for (let i = 0; i < 100; i++) {
        if (backend.exitCode !== null) throw new Error('Fixture exited: ' + backendOutput);
        try {
          const ready = JSON.parse(await fs.readFile(path.join(temp, 'ready.json'), 'utf8'));
          settings.upstream = ready.upstream;
          return ready;
        } catch {
          await wait(100);
        }
      }
      throw new Error('Go fixture startup timeout');
    };
    const stopBackend = async () => {
      if (backend && backend.exitCode === null) {
        const done = once(backend, 'exit');
        backend.kill('SIGTERM');
        await done;
      }
    };
    const ready = await startBackend();
    browser = await puppeteer.launch({
      executablePath: process.env.RPG_BROWSER || '/usr/bin/google-chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    page.setDefaultTimeout(20000);
    await page.setViewport({ width: 1440, height: 1100 });
    await page.goto(origin + '/rpg/#ticket=' + ready.ticket);
    await page.waitForFunction(() => !document.querySelector('#game-shell').hidden);
    assert.equal(new URL(page.url()).hash, '', 'login fragment removed');
    assert.equal(await page.$$eval('[data-hero]', (els) => els.length), 4);
    const profile = () => page.evaluate(async () => (await fetch('/rpg/api/profile')).json());
    const call = (url, data, csrf) =>
      page.evaluate(
        async (url, data, csrf) => {
          const res = await fetch('/rpg/api' + url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
            body: JSON.stringify(data),
          });
          return { status: res.status, data: await res.json() };
        },
        url,
        data,
        csrf,
      );
    let state = await profile();
    assert.equal(state.profile.shards, 1600);
    const battleID = state.battle.id;
    const hp = state.battle.enemies[1].hp;
    await page.click('[data-enemy="1"]');
    await page.click('[data-action="attack"]');
    await page.waitForFunction(
      async () => (await (await fetch('/rpg/api/profile')).json()).battle.revision === 1,
    );
    state = await profile();
    assert.ok(state.battle.enemies[1].hp < hp);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#game-shell').hidden);
    assert.equal((await profile()).battle.id, battleID);
    assert.equal((await profile()).battle.revision, 1);
    await stopBackend();
    await startBackend();
    await page.reload();
    await page.waitForFunction(() => !document.querySelector('#game-shell').hidden);
    assert.equal((await profile()).battle.revision, 1, 'resume after Go process restart');
    console.log('PASS: one-use login, server damage, reload and service restart preserve battle');

    await page.click('#speed-button');
    await page.click('#auto-button');
    await page.waitForFunction(() => !document.querySelector('#battle-overlay').hidden);
    state = await profile();
    assert.equal(state.battle.result, 'win');
    assert.equal(state.profile.shards, 1620);
    assert.equal(state.profile.unlocked, 1);
    await page.click('#retry-battle');
    await page.waitForFunction(
      () =>
        document.querySelector('#battle-overlay').hidden &&
        !document.querySelector('[data-action="attack"]').disabled,
    );
    await page.click('#auto-button');
    await page.waitForFunction(() => !document.querySelector('#battle-overlay').hidden);
    assert.equal((await profile()).profile.shards, 1620);
    console.log('PASS: battle rewards and map unlock persist; replay gives no second reward');

    await page.click('[data-tab="gacha"]');
    dropDrawResponses = 3;
    await page.click('#pull-ten');
    await page.waitForFunction(
      () =>
        !document.querySelector('#sync-note').hidden &&
        document.querySelector('#shards').textContent.trim() === '20',
    );
    assert.equal((await profile()).profile.shards, 20);
    await page.reload();
    await page.waitForFunction(
      () =>
        !document.querySelector('#game-shell').hidden &&
        document.querySelector('#sync-note').hidden,
    );
    await page.click('[data-tab="gacha"]');
    assert.equal(await page.$$eval('.summon-result', (els) => els.length), 10);
    assert.equal(new Set(drawRequests).size, 1, 'retry must reuse the original request ID');
    assert.ok(drawRequests.length >= 4);
    assert.equal((await profile()).profile.shards, 20);
    const history = await page.evaluate(
      async () => (await (await fetch('/rpg/api/gacha/history')).json()).history,
    );
    assert.equal(history.length, 1);
    assert.equal(history[0].results.length, 10);
    console.log('PASS: lost responses plus browser reload replay one draw without double debit');

    state = await profile();
    assert.equal(
      (await call('/battles', { request_id: 'forbidden-level', stage: 998 }, state.csrf)).status,
      403,
    );
    assert.equal(
      (
        await call(
          '/gacha/pulls',
          { request_id: 'no-csrf-token', count: 1, banner_id: 'fajar-v1' },
          '',
        )
      ).status,
      403,
    );
    assert.equal(
      (await call('/battles', { request_id: 'fake-balance', stage: 1, shards: 99999 }, state.csrf))
        .status,
      400,
    );
    const stranger = await browser.createBrowserContext();
    const other = await stranger.newPage();
    await other.goto(origin + '/rpg/');
    assert.equal(await other.evaluate(async () => (await fetch('/rpg/api/profile')).status), 401);
    await stranger.close();
    console.log(
      'PASS: locked levels, forged balances, missing CSRF, and unauthenticated access rejected',
    );

    await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
    for (const tab of ['battle', 'collection', 'gacha']) {
      await page.click(`[data-tab="${tab}"]`);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
        'mobile overflow: ' + tab,
      );
    }
    await page.click('[data-tab="collection"]');
    assert.equal(await page.$$eval('[data-character]', (els) => els.length), 60);
    await page.click('[data-rarity="5"]');
    assert.equal(await page.$$eval('[data-character]', (els) => els.length), 12);
    await page.click('[data-tab="battle"]');
    await page.click('#world-button');
    assert.equal(await page.$$eval('[data-region]', (els) => els.length), 10);
    await page.click('[data-region="0"]');
    assert.equal(await page.$$eval('[data-travel]', (els) => els.length), 99);
    await page.click('[data-travel="1"]');
    await page.waitForFunction(() => document.querySelector('#battle-overlay').hidden);
    await page.screenshot({ path: '/tmp/hara-rpg-live-mobile.png', fullPage: true });
    await page.setViewport({ width: 1440, height: 1100 });
    await page.waitForFunction(() => !document.querySelector('#game-shell').hidden);
    await page.screenshot({ path: '/tmp/hara-rpg-live-desktop.png', fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: mobile layouts, collection60, ten regions, and next-stage navigation');
    console.log(
      'RPG browser integration passed against real Go + SQLite (WhatsApp delivery covered by handler tests).',
    );
  } finally {
    if (browser) await browser.close();
    if (backend && backend.exitCode === null) {
      const done = once(backend, 'exit');
      backend.kill('SIGTERM');
      await done;
    }
    if (server) await new Promise((resolve) => server.close(resolve));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
