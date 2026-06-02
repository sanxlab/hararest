import fs from 'fs';
import path from 'path';
import puppeteer, { LaunchOptions } from 'puppeteer-core';

const DEFAULT_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
];

const envExecutableCandidates = () => [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  process.env.GOOGLE_CHROME_BIN,
  process.env.CHROMIUM_PATH,
].filter((candidate): candidate is string => Boolean(candidate));

const commonExecutableCandidates = () => [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
];

const cacheExecutableCandidates = () => {
  const roots = [
    process.env.PUPPETEER_CACHE_DIR,
    process.env.HOME ? path.join(process.env.HOME, '.cache/puppeteer') : '',
  ].filter((root): root is string => Boolean(root));
  const candidates: string[] = [];

  for (const root of roots) {
    const chromeRoot = path.join(root, 'chrome');
    if (!fs.existsSync(chromeRoot)) continue;

    for (const versionDir of fs.readdirSync(chromeRoot)) {
      candidates.push(path.join(chromeRoot, versionDir, 'chrome-linux64', 'chrome'));
      candidates.push(path.join(chromeRoot, versionDir, 'chrome-linux', 'chrome'));
    }
  }

  return candidates;
};

export const resolveBrowserExecutablePath = (override?: string): string => {
  const candidates = [
    override,
    ...envExecutableCandidates(),
    ...commonExecutableCandidates(),
    ...cacheExecutableCandidates(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  return candidates.find((candidate) => fs.existsSync(candidate)) || '';
};

export const launchBrowser = async (options: LaunchOptions = {}) => {
  const executablePath = resolveBrowserExecutablePath(options.executablePath);
  const args = [...DEFAULT_ARGS, ...(options.args || [])];

  if (!executablePath) {
    throw new Error(
      'Chrome/Chromium executable not found. Set PUPPETEER_EXECUTABLE_PATH or install chromium.'
    );
  }

  return await puppeteer.launch({
    ...options,
    headless: options.headless ?? true,
    executablePath,
    args,
  });
};
