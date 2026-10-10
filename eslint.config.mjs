// @ts-check
import withNuxt from './.nuxt/eslint.config.mjs'
import betterTailwindcss from 'eslint-plugin-better-tailwindcss'
import { getDefaultAttributes } from 'eslint-plugin-better-tailwindcss/api/defaults'

export default withNuxt(
  betterTailwindcss.configs['correctness-error'],
  {
    settings: {
      'better-tailwindcss': {
        entryPoint: 'app/assets/css/main.css',
        attributes: [
          ...getDefaultAttributes(),
          ['^v-bind:ui$', [{ match: 'objectValues' }]]
        ]
      }
    }
  },
  {
    // B5 analysis notebook: one-off scripts, written dense on purpose.
    files: ['internal_docs/**/notebook/**/*.ts'],
    rules: {
      '@stylistic/max-statements-per-line': 'off',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
)
