import { expect, test } from 'bun:test';
import { databaseFixture } from './backend-fixtures';

for (const action of ['close', 'reopen'] as const) {
  test(`database fixture ${action} retires prepared statements before removing or reopening its file`, () => {
    const fixture = databaseFixture();
    const statement = fixture.db.prepare('SELECT 1 AS n');
    expect(statement.get()).toEqual({ n: 1 });
    try {
      fixture[action]();
      expect(() => statement.get()).toThrow();
      if (action === 'reopen') {
        expect(fixture.db.prepare('SELECT 2 AS n').get()).toEqual({ n: 2 });
      }
    } finally {
      if (action === 'reopen') fixture.close();
      statement.finalize();
    }
  });
}
