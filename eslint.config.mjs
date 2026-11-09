import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/node_modules/**',
      'apps/server/src/generated/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: ['scripts/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser } },
    // Prettier owns template layout; these rules otherwise conflict with its output.
    rules: {
      'vue/html-indent': 'off',
      'vue/html-self-closing': ['warn', { html: { void: 'always' } }],
      'vue/html-closing-bracket-newline': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
    },
  },
  {
    files: ['apps/web/app/pages/**/*.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },
  {
    files: ['apps/web/app/**/*.vue'],
    languageOptions: {
      globals: {
        window: 'readonly',
        sessionStorage: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        MessageEvent: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
  {
    files: ['apps/web/public/widget-loader.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        URL: 'readonly',
        crypto: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
      },
    },
  },
  {
    files: [
      'tests/integration/identity.mjs',
      'tests/integration/widget.mjs',
      'tests/integration/messages.mjs',
      'tests/integration/realtime.mjs',
      'tests/integration/frontend.mjs',
      'tests/integration/reception.mjs',
      'tests/integration/inbox.mjs',
    ],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        AbortSignal: 'readonly',
        document: 'readonly',
        window: 'readonly',
        location: 'readonly',
        localStorage: 'readonly',
        Storage: 'readonly',
        crypto: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
);
