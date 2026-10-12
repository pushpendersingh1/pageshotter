import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `pageshotter-extension/` is an unzipped copy of the built extension, created when loading it
  // unpacked in Chrome. It is build output like `dist/`, so it is never linted or committed.
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'pageshotter-extension/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: {
        chrome: 'readonly',
        document: 'readonly',
        window: 'readonly',
        navigator: 'readonly',
        indexedDB: 'readonly',
        Image: 'readonly',
        HTMLCanvasElement: 'readonly',
        ClipboardItem: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        crypto: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        fetch: 'readonly',
        createImageBitmap: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        RegExp: 'readonly',
        Set: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
      },
    },
  },
)
