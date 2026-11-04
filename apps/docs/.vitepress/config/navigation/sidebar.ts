import type { DefaultTheme } from 'vitepress';

const sidebar: DefaultTheme.SidebarItem[] = [
  {
    text: 'Guides',
    items: [
      { text: 'Introduction', link: '/guides/introduction' },
      { text: 'Install and set up', link: '/guides/install' },
      { text: 'Test on your phone', link: '/guides/test-on-your-phone' },
      { text: 'Record your first case', link: '/guides/first-case' },
      { text: 'Recording', link: '/guides/recording' },
      { text: 'Setup blocks', link: '/guides/setup-blocks' },
      { text: 'Test users', link: '/guides/test-users' },
      { text: 'Edit and chain cases', link: '/guides/edit-and-chain' },
      { text: 'Run and Run all', link: '/guides/run' },
      { text: 'Run video', link: '/guides/run-video' },
      { text: 'Test case documents', link: '/guides/test-case-documents' },
      { text: 'Your project files', link: '/guides/project-files' },
      { text: 'Use with an existing Maestro project', link: '/guides/existing-maestro-project' },
      { text: 'CI', link: '/guides/ci' },
      { text: 'If you know Maestro', link: '/guides/if-you-know-maestro' },
      { text: 'Compare the tools', link: '/guides/compare' },
    ],
  },
  {
    text: 'Frequently asked questions',
    items: [
      { text: 'General', link: '/faq/general' },
      { text: 'Recording', link: '/faq/recording' },
      { text: 'Running', link: '/faq/running' },
      { text: 'Troubleshooting', link: '/faq/troubleshooting' },
    ],
  },
  {
    text: 'Reference',
    items: [
      { text: 'CLI', link: '/reference/cli' },
      { text: 'project.json', link: '/reference/project-json' },
      { text: 'How a case becomes a flow', link: '/reference/case-to-flow' },
      { text: 'How clicks become selectors', link: '/reference/selectors' },
      { text: 'Known limits', link: '/reference/known-limits' },
    ],
  },
  {
    text: 'Contribute',
    items: [
      { text: 'Develop from the repository', link: '/contribute/develop' },
      { text: 'Smoke tests', link: '/contribute/smoke-tests' },
      { text: 'Packaging and releases', link: '/contribute/packaging' },
    ],
  },
];

export default sidebar;
