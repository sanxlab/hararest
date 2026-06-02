jest.mock('../utils/puppeteer', () => ({
    launchBrowser: jest.fn()
}));

import supertest from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import app from '../app';
import { launchBrowser } from '../utils/puppeteer';

type EvaluatePayload = {
    url?: string;
};

type MockPage = {
    setDefaultTimeout: jest.Mock;
    setUserAgent: jest.Mock;
    setExtraHTTPHeaders: jest.Mock;
    goto: jest.Mock;
    setCookie: jest.Mock;
    cookies: jest.Mock;
    evaluate: jest.Mock;
    waitForSelector: jest.Mock;
    type: jest.Mock;
    click: jest.Mock;
    waitForNavigation: jest.Mock;
};

type MockBrowser = {
    newPage: jest.Mock;
    close: jest.Mock;
};

const mockedLaunchBrowser = launchBrowser as jest.MockedFunction<typeof launchBrowser>;
const instagramEnvKeys = ['INSTAGRAM_COOKIE', 'INSTAGRAM_COOKIE_FILE'];

describe('Instagram Stalker Module', () => {
    let mockPage: MockPage;
    let mockBrowser: MockBrowser;
    let originalEnv: Record<string, string | undefined>;

    beforeEach(() => {
        jest.clearAllMocks();
        originalEnv = Object.fromEntries(instagramEnvKeys.map((key) => [key, process.env[key]]));
        for (const key of instagramEnvKeys) {
            delete process.env[key];
        }

        mockPage = {
            setDefaultTimeout: jest.fn(),
            setUserAgent: jest.fn().mockResolvedValue(undefined),
            setExtraHTTPHeaders: jest.fn().mockResolvedValue(undefined),
            goto: jest.fn().mockResolvedValue(undefined),
            setCookie: jest.fn().mockResolvedValue(undefined),
            cookies: jest.fn().mockResolvedValue([{ name: 'sessionid', value: 'session-value' }]),
            evaluate: jest.fn().mockImplementation((_fn: unknown, payload?: EvaluatePayload | string) => {
                if (payload === '936619743392459') {
                    return Promise.resolve('936619743392459');
                }

                if (!payload) {
                    return Promise.resolve('csrf-token');
                }

                if (typeof payload === 'string') {
                    return Promise.resolve({
                        found: true,
                        rawText: 'About this account\nDate joined\nJanuary 2020\nAccount based in\nIndonesia'
                    });
                }

                if (payload.url?.includes('/web_profile_info/')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        text: '{}',
                        retryAfter: '',
                        json: {
                            status: 'ok',
                            data: {
                                user: {
                                    id: '123',
                                    username: 'targetuser',
                                    full_name: 'Target User',
                                    biography: 'Hello',
                                    external_url: 'https://example.com',
                                    is_private: false,
                                    is_verified: true,
                                    is_business_account: false,
                                    edge_followed_by: { count: 10 },
                                    edge_follow: { count: 5 },
                                    edge_owner_to_timeline_media: { count: 2 },
                                    profile_pic_url_hd: 'https://cdn.example.com/profile.jpg',
                                    show_account_transparency_details: true
                                }
                            }
                        }
                    });
                }

                if (payload.url?.includes('/users/123/info/')) {
                    return Promise.resolve({
                        ok: true,
                        status: 200,
                        text: '{}',
                        retryAfter: '',
                        json: {
                            status: 'ok',
                            user: {
                                show_account_transparency_details: true,
                                transparency_product_enabled: true,
                                mutual_followers_count: 3
                            }
                        }
                    });
                }

                return Promise.resolve({
                    ok: true,
                    status: 200,
                    text: '{}',
                    retryAfter: '',
                    json: { status: 'ok', items: [], more_available: false }
                });
            }),
            waitForSelector: jest.fn(),
            type: jest.fn(),
            click: jest.fn(),
            waitForNavigation: jest.fn()
        };

        mockBrowser = {
            newPage: jest.fn().mockResolvedValue(mockPage),
            close: jest.fn().mockResolvedValue(undefined)
        };

        mockedLaunchBrowser.mockResolvedValue(mockBrowser as never);
    });

    afterEach(() => {
        for (const key of instagramEnvKeys) {
            const value = originalEnv[key];
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    describe('GET /api/instagram/stalk', () => {
        it('should return profile and about account data for an authenticated request', async () => {
            process.env.INSTAGRAM_COOKIE = 'sessionid=session-value';

            const response = await supertest(app).get(
                '/api/instagram/stalk?username=@targetuser&warmupDelayMs=0&warmupJitterMs=0'
            );

            expect(response.status).toBe(200);
            expect(response.body.status).toBe('success');
            expect(response.body.data.target_username).toBe('targetuser');
            expect(response.body.data.profile).toEqual({
                id: '123',
                username: 'targetuser',
                full_name: 'Target User',
                biography: 'Hello',
                external_url: 'https://example.com',
                is_private: false,
                is_verified: true,
                is_business_account: false,
                followers_count: 10,
                following_count: 5,
                posts_count: 2,
                profile_pic_url: 'https://cdn.example.com/profile.jpg'
            });
            expect(response.body.data.about_account.date_joined).toBe('January 2020');
            expect(mockPage.setCookie).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'sessionid',
                    value: 'session-value',
                    domain: '.instagram.com'
                })
            );
            expect(mockBrowser.close).toHaveBeenCalled();
        });

        it('should accept INSTAGRAM_COOKIE as a cookie file path from env', async () => {
            const cookieDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instagram-cookie-'));
            const cookieFile = path.join(cookieDir, 'cookies.txt');
            fs.writeFileSync(
                cookieFile,
                '.instagram.com\tTRUE\t/\tTRUE\t1893456000\tsessionid\tfile-session-value\n',
                'utf8'
            );
            process.env.INSTAGRAM_COOKIE = cookieFile;

            const response = await supertest(app).get(
                '/api/instagram/stalk?username=@targetuser&warmupDelayMs=0&warmupJitterMs=0'
            );

            expect(response.status).toBe(200);
            expect(response.body.data.auth.cookie_file_loaded).toBe(cookieFile);
            expect(response.body.data.auth.cookie_file_imported_count).toBe(1);
            expect(mockPage.setCookie).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'sessionid',
                    value: 'file-session-value',
                    domain: '.instagram.com'
                })
            );

            fs.rmSync(cookieDir, { recursive: true, force: true });
        });

        it('should return 400 if username is missing', async () => {
            const response = await supertest(app).get('/api/instagram/stalk');
            expect(response.status).toBe(400);
        });

        it('should return 400 if authentication is missing', async () => {
            const response = await supertest(app).get('/api/instagram/stalk?username=targetuser');
            expect(response.status).toBe(400);
        });
    });
});
