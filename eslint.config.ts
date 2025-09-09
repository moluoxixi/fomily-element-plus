import EslintConfig from '@moluoxixi/eslintconfig'

export default EslintConfig(
  {
    ignores: [
      'docs/vitepress/.vitepress/theme/components/DocsCodeDemo/**',
      'packages/components/ConfigForm/**',
      '.husky/**',
      '**/*.md',
    ],
  },
)
