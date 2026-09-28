import { describe, expect, it, vi } from 'vitest';
import { rankCommands, groupRows, RECENT_LABEL } from '../../src/commands/rank';
import type { Command, PaletteContext } from '../../src/commands/types';

const ctx: PaletteContext = { pathname: '/connections', connectionId: null };

const make = (overrides: Partial<Command>): Command => ({
  id: overrides.id ?? 'x',
  title: overrides.title ?? 'Untitled',
  group: overrides.group ?? 'general',
  perform: () => {},
  ...overrides,
});

describe('rankCommands', () => {
  it('hides commands whose when() returns false', () => {
    const all = [
      make({ id: 'a', title: 'Alpha' }),
      make({ id: 'b', title: 'Beta', when: () => false }),
    ];
    const ranked = rankCommands(all, '', ctx, []);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['a']);
  });

  it('treats a throwing when() as false and warns once (dev)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const all = [
      make({
        id: 'broken',
        title: 'Broken',
        when: () => {
          throw new Error('boom');
        },
      }),
      make({ id: 'ok', title: 'OK' }),
    ];
    const ranked = rankCommands(all, '', ctx, []);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['ok']);
    expect(warn).toHaveBeenCalledWith('[commandRegistry] when() threw for "broken":', expect.any(Error));
    warn.mockRestore();
  });

  it('trims and lowercases the query before matching', () => {
    const all = [make({ id: 'a', title: 'Save Query' })];
    const ranked = rankCommands(all, '  SAVE  ', ctx, []);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['a']);
  });

  it('with empty query: surfaces recents first then registration order', () => {
    const all = [
      make({ id: 'a', title: 'Alpha' }),
      make({ id: 'b', title: 'Beta' }),
      make({ id: 'c', title: 'Gamma' }),
    ];
    const ranked = rankCommands(all, '', ctx, ['c']);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['c', 'a', 'b']);
    expect(ranked.map((r) => r.bucket)).toEqual(['recent', 'substring', 'substring']);
  });

  it('with empty query: ignores a stale recent id that is not visible', () => {
    const all = [make({ id: 'a', title: 'Alpha' })];
    // 'ghost' is a recent id from a command that no longer exists (or is
    // hidden by when()) — it must not produce a row with an undefined cmd.
    const ranked = rankCommands(all, '', ctx, ['ghost', 'a']);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.cmd.id).toBe('a');
    expect(ranked[0]!.bucket).toBe('recent');
  });

  it('ranks prefix matches above substring matches above keyword matches', () => {
    const all = [
      make({ id: 'kw', title: 'Unrelated', keywords: ['save'] }),
      make({ id: 'sub', title: 'Re-save query' }),
      make({ id: 'pref', title: 'Save query' }),
    ];
    const ranked = rankCommands(all, 'sav', ctx, []);
    expect(ranked.map((r) => r.cmd.id)).toEqual(['pref', 'sub', 'kw']);
  });

  it('promotes a query-matching command into the recent bucket if MRU includes it', () => {
    const all = [make({ id: 'pref', title: 'Save query' })];
    const ranked = rankCommands(all, 'sav', ctx, ['pref']);
    expect(ranked[0]!.bucket).toBe('recent');
  });

  it('matches subtitle and keywords case-insensitively', () => {
    const all = [
      make({ id: 'a', title: 'Foo', subtitle: 'has BAR inside' }),
      make({ id: 'b', title: 'Baz', keywords: ['Bar'] }),
    ];
    const ranked = rankCommands(all, 'bar', ctx, []);
    expect(ranked.map((r) => r.cmd.id).sort()).toEqual(['a', 'b']);
  });

  it('excludes a command that matches nothing, instead of ranking it anyway', () => {
    const all = [make({ id: 'a', title: 'Alpha', subtitle: 'first letter', keywords: ['abc'] })];
    const ranked = rankCommands(all, 'zzz', ctx, []);
    expect(ranked).toEqual([]);
  });

  it('does not read a keyword match out of a defaulted, blank subtitle', () => {
    // A command with no subtitle falls back to '' — querying for a
    // substring of the mutation-testing sentinel text catches a wrong
    // non-empty default, since '' never contains any non-empty substring.
    const all = [make({ id: 'a', title: 'Alpha', keywords: ['abc'] })];
    const ranked = rankCommands(all, 'here', ctx, []);
    expect(ranked).toEqual([]);
  });

  it('does not read a keyword match out of a defaulted, empty keyword list', () => {
    const all = [make({ id: 'a', title: 'Alpha', subtitle: 'first letter' })];
    const ranked = rankCommands(all, 'here', ctx, []);
    expect(ranked).toEqual([]);
  });

  it('joins multiple keywords with a space, not concatenated', () => {
    // 'foo bar' does not contain 'oobar' as a substring — it would if the
    // keywords were joined without a separator ('foobar').
    const all = [make({ id: 'a', title: 'Alpha', keywords: ['foo', 'bar'] })];
    const ranked = rankCommands(all, 'oobar', ctx, []);
    expect(ranked).toEqual([]);
  });
});

describe('groupRows', () => {
  it('renders a Recent header before group headers', () => {
    const ranked = rankCommands(
      [
        make({ id: 'a', title: 'Alpha', group: 'general' }),
        make({ id: 'b', title: 'Beta', group: 'workspace' }),
      ],
      '',
      ctx,
      ['b'],
    );
    const grouped = groupRows(ranked);
    expect(grouped.map((g) => g.key)).toEqual(['recent', 'general']);
    expect(grouped[0]!.rows.map((r) => r.cmd.id)).toEqual(['b']);
    expect(grouped[1]!.rows.map((r) => r.cmd.id)).toEqual(['a']);
  });

  it('does not duplicate a recent command into its own group', () => {
    const ranked = rankCommands(
      [make({ id: 'a', title: 'Alpha', group: 'workspace' })],
      '',
      ctx,
      ['a'],
    );
    const grouped = groupRows(ranked);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.key).toBe('recent');
  });

  it('labels the recent header "Recent"', () => {
    const ranked = rankCommands([make({ id: 'a', title: 'Alpha' })], '', ctx, ['a']);
    const grouped = groupRows(ranked);
    expect(grouped[0]!.label).toBe('Recent');
    expect(RECENT_LABEL).toBe('Recent');
  });

  it('keeps multiple commands in the same group together, not overwritten', () => {
    const ranked = rankCommands(
      [
        make({ id: 'a', title: 'Alpha', group: 'workspace' }),
        make({ id: 'b', title: 'Beta', group: 'workspace' }),
      ],
      '',
      ctx,
      [],
    );
    const grouped = groupRows(ranked);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.rows.map((r) => r.cmd.id)).toEqual(['a', 'b']);
  });

  it('orders groups by GROUP_ORDER', () => {
    const ranked = rankCommands(
      [
        make({ id: 'a', title: 'Aggregation thing', group: 'aggregation' }),
        make({ id: 'b', title: 'Workspace thing', group: 'workspace' }),
        make({ id: 'c', title: 'General thing', group: 'general' }),
      ],
      '',
      ctx,
      [],
    );
    const grouped = groupRows(ranked);
    expect(grouped.map((g) => g.key)).toEqual(['general', 'workspace', 'aggregation']);
  });
});
