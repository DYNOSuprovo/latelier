import { describe, it, expect } from 'vitest';
import { saveFilters } from '../../electron/ipc/handlers/app.ts';

describe('saveFilters', () => {
  it.each([
    ['orders.json', 'JSON', 'json'],
    ['orders.jsonl', 'JSON Lines', 'jsonl'],
    ['orders.CSV', 'CSV', 'csv'],
  ])('offers the filter matching %s first', (name, label, ext) => {
    expect(saveFilters(name)).toEqual([
      { name: label, extensions: [ext] },
      { name: 'All files', extensions: ['*'] },
    ]);
  });

  it('offers only All files for an unknown or missing extension', () => {
    expect(saveFilters('dump.bin')).toEqual([{ name: 'All files', extensions: ['*'] }]);
    expect(saveFilters('noext')).toEqual([{ name: 'All files', extensions: ['*'] }]);
    expect(saveFilters('proto.__proto__')).toEqual([{ name: 'All files', extensions: ['*'] }]);
  });
});
