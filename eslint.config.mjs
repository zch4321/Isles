import js from '@eslint/js';
import { defineConfigWithVueTs, vueTsConfigs } from '@vue/eslint-config-typescript';
import skipFormatting from 'eslint-config-prettier';
import vue from 'eslint-plugin-vue';

export default defineConfigWithVueTs(
  {
    ignores: ['**/dist/**', '.isles/**', 'playwright-report/**', 'test-results/**'],
  },
  js.configs.recommended,
  vue.configs['flat/recommended'],
  vueTsConfigs.recommended,
  {
    // Keep the names and optional styling props used by upstream shadcn-vue primitives.
    files: ['apps/web/src/components/ui/**/*.vue'],
    rules: {
      'vue/multi-word-component-names': 'off',
      'vue/require-default-prop': 'off',
    },
  },
  skipFormatting,
);
