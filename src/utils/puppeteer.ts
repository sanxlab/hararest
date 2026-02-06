import puppeteer, { LaunchOptions } from 'puppeteer-core';

export const launchBrowser = async (options?: LaunchOptions) => {
  let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '';

  if (!executablePath && process.platform === 'linux') {
    executablePath = '/usr/bin/google-chrome';
  }

  return await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-gpu',
    ],
    ...options,
  });
};
