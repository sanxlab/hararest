/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleNameMapper: {
        '^dns/promises$': '<rootDir>/src/__mocks__/dns-promises.ts'
    },
    forceExit: true,
    clearMocks: true,
};
