import { expect, test } from 'bun:test';
import { createPatUrl } from '../settings.tsx';

test('PAT helper preserves required fields, whitespace handling and limits', () => {
  expect(createPatUrl(null, 'team')).toBeNull();
  expect(createPatUrl('ada-bot', undefined)).toBeNull();
  expect(createPatUrl('ada-bot', '   ')).toBeNull();
  const url = new URL(createPatUrl('ada-bot', '  example-team  ')!);
  expect(url.origin + url.pathname).toBe('https://github.com/settings/personal-access-tokens/new');
  expect(Object.fromEntries(url.searchParams)).toEqual({ name: 'BB ada-bot', description: 'BB pull request attribution for @ada-bot in example-team.', target_name: 'example-team', pull_requests: 'write', contents: 'read' });
  const long = new URL(createPatUrl('b'.repeat(80), 'o'.repeat(1100))!);
  expect(long.searchParams.get('name')!.length).toBe(40);
  expect(long.searchParams.get('description')!.length).toBe(1024);
});
