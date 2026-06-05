import js from '@eslint/js'
import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import globals from 'globals'

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'logs/**',
      'exports/**',
      'tests/**',
      '**/*.har'
    ]
  },
  js.configs.recommended,
  ...tsPlugin.configs['flat/recommended'],
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2022
      }
    },
    rules: {
      // Стиль/удобство: проект уже использует unused-args через `_` префикс (рекомендация TS).
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      // Проект много где использует `any` (viem helpers, Web3 ABIs). Переводим в warn,
      // чтобы линт не падал, но был сигналом к рефактору.
      '@typescript-eslint/no-explicit-any': 'warn'
    }
  }
]
