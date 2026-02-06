/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.ts'],
    forceExit: true,
    clearMocks: true,
    resetMocks: true,
    restoreMocks: true,
};
