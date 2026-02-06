import { launchBrowser } from '../../utils/puppeteer';

export class BratService {
    async create(text: string) {
        const browser = await launchBrowser();
        try {
            const page = await browser.newPage();
            await page.goto('https://www.bratgenerator.com/');
            await page.click('#toggleButtonWhite');
            await page.evaluate('textInput.value = "";');
            await page.type('#textInput', text);


            const element = await page.waitForSelector('#textOverlay', { visible: true, timeout: 5000 });
            if (!element) {
                throw new Error('Failed to generate image: Element not found');
            }

            const image = await element.screenshot();
            return image;
        } catch (error) {
            console.error('BratService Error:', error);
            throw error;
        } finally {
            await browser.close();
        }
    }
}
