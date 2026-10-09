const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['playwright-report/', 'test-results/'] },
  js.configs.recommended,
  {
    rules: {
      // An empty catch is how the code says an error doesn't matter, such as localStorage being unavailable.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // A leading underscore marks a value that's unpacked only to leave it out, such as `{ routes: _routes, ...rest }`.
      'no-unused-vars': ['error', { varsIgnorePattern: '^_', argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['src/**/*.js', 'test/**/*.js', 'e2e/**/*.js', '*.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
  {
    // The page's scripts run in the browser as ES modules.
    files: ['public/**/*.js'],
    languageOptions: { sourceType: 'module', globals: globals.browser },
  },
];
