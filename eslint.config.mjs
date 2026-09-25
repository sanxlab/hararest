import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    {
        ignores: ['dist/**', 'node_modules/**', 'vendor/**', '.kilo/**', 'coverage/**', 'src/__mocks__/**', 'eslint.config.mjs', 'jest.config.js'],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            globals: {
                ...globals.node,
            },
            parserOptions: {
                project: ['./tsconfig.json', './tsconfig.test.json'],
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-explicit-any': 'error',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                },
            ],
            'no-undef': 'off', // TypeScript handles this
        },
    },
    {
        files: ['public/rpg/*.js', 'docs/rpg/prototype/*.js'],
        languageOptions: { globals: globals.browser, parserOptions: { project: null } },
    },
    {
        files: ['scripts/*.cjs', 'docs/rpg/prototype/*.cjs'],
        languageOptions: { parserOptions: { project: null } },
        rules: { '@typescript-eslint/no-require-imports': 'off' },
    }
);
