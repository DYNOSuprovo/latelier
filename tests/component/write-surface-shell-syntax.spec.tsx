// Shell Syntax reaches the write surfaces.
//
// ADR 0004 held the write surfaces strict on the grounds that a
// misread value here corrupts a document rather than returning wrong rows.
// What makes the leniency safe is the ADR's *other* rule — a destructive
// operation always shows the Canonical EJSON it will actually run — so the
// assertions below are as much about what is on screen before the write as
// about the write itself.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '../helpers/render';
import { DocumentEditor } from '../../src/pages/Workspace/DocumentEditor';
import { installAtelierMock, uninstallAtelierMock } from '../helpers/atelierMock';
import type { ScriptEditorProps } from '../../src/components/ScriptEditor';

// The JSON view mounts a real CodeMirror 6 `ScriptEditor`, which needs
// layout APIs jsdom doesn't implement (see `document-editor.spec.tsx`). This
// suite only needs a controlled text box with onChange/onBlur, not the
// completion popup, so the stub stays minimal (mirrors `stage-accordion.spec.tsx`).
vi.mock('../../src/components/ScriptEditor', () => ({
  ScriptEditor: ({ value, onChange, onBlur, testId, ariaLabel }: ScriptEditorProps) => (
    <textarea
      data-testid={testId}
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => onBlur?.()}
    />
  ),
}));

afterEach(() => {
  uninstallAtelierMock();
  vi.restoreAllMocks();
});

function renderInsert(): Array<{ docJson?: string; docsJson?: string }> {
  const calls: Array<{ docJson?: string; docsJson?: string }> = [];
  installAtelierMock({
    doc: {
      insert: async (input) => {
        calls.push(input as { docJson: string });
        return { insertedId: '1' };
      },
      insertMany: async (input) => {
        calls.push(input as { docsJson: string });
        return { insertedCount: 2, insertedIds: ['1', '2'] };
      },
    },
  });
  render(
    <DocumentEditor
      mode="insert"
      collection="coll"
      connectionId="c1"
      dbName="db"
      onClose={() => undefined}
      onInserted={() => undefined}
    />,
  );
  // Fields is the default view (W18 §2); this suite is about the JSON
  // view's Shell Syntax repair, so every case switches there first.
  fireEvent.click(screen.getByRole('radio', { name: 'JSON' }));
  return calls;
}

function insertBuffer(): HTMLTextAreaElement {
  return screen.getByRole('textbox', { name: 'Document JSON' }) as HTMLTextAreaElement;
}

const insertButton = () => screen.getByRole('button', { name: /^Insert/ });

describe('DocumentEditor — insert mode — Shell Syntax input (JSON view)', () => {
  it('rewrites Shell Syntax in the box, on blur', () => {
    renderInsert();

    fireEvent.change(insertBuffer(), { target: { value: "{name: 'foo', at: ISODate('2026-01-01T00:00:00.000Z')}" } });
    fireEvent.blur(insertBuffer());

    expect(insertBuffer().value).toBe(
      '{"name": "foo", "at": {"$date":"2026-01-01T00:00:00.000Z"}}',
    );
  });

  it('inserts Canonical EJSON even when Insert is pressed before any blur', async () => {
    const calls = renderInsert();

    fireEvent.change(insertBuffer(), { target: { value: "{name: 'foo',}" } });
    fireEvent.click(insertButton());

    await waitFor(() => expect(calls).toHaveLength(1));
    // No spacing: the payload is re-stringified from the parsed value, so
    // the wire carries normalized Canonical EJSON whatever the user typed.
    // The repair's in-place spacing survives where it is meant to — in the
    // buffer, asserted below — not on the wire.
    expect(calls[0]!.docJson).toBe('{"name":"foo"}');
    expect(insertBuffer().value).toBe('{"name": "foo"}');
  });

  it('still classifies an array as insertMany after the repair', async () => {
    // The transform runs in front of `classifyInsertPayload`, not inside it,
    // so the array-versus-document rule is unchanged and still reads
    // Canonical EJSON.
    const calls = renderInsert();

    fireEvent.change(insertBuffer(), { target: { value: "[{name: 'a'}, {name: 'b'},]" } });
    fireEvent.blur(insertBuffer());

    expect(screen.getByRole('button', { name: 'Insert 2 documents' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Insert 2 documents' }));

    await waitFor(() => expect(calls).toHaveLength(1));
    // Normalized on the wire — see the note on the previous case.
    expect(calls[0]!.docsJson).toBe('[{"name":"a"},{"name":"b"}]');
    expect(insertBuffer().value).toBe('[{"name": "a"}, {"name": "b"}]');
  });

  it('names the token it cannot read instead of saying "Invalid EJSON"', () => {
    renderInsert();

    fireEvent.change(insertBuffer(), { target: { value: '{name: nope}' } });

    expect(screen.getByText(/Line 1, column 8: /)).toBeTruthy();
    expect(screen.queryByText('Invalid EJSON')).toBeNull();
  });

  // A rejected regex flag is a different refusal from a bare word: the flag
  // allowlist in `regexText` throws after the literal has already parsed, so
  // it is the one refusal a purely syntactic reading would let through. The
  // reason has to name the flag, because "Invalid EJSON" over a valid regex
  // literal tells the user nothing about which character to delete.
  it('names the rejected regex flag rather than falling back to "Invalid EJSON"', () => {
    renderInsert();

    fireEvent.change(insertBuffer(), { target: { value: '{name: /^a/g}' } });

    expect(
      screen.getByText(
        'Line 1, column 8: The regular expression flag "g" (global) has no MongoDB equivalent. Remove it.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Invalid EJSON')).toBeNull();
    expect(insertButton()).toHaveProperty('disabled', true);
  });

  it('does not insert anything it could not read', async () => {
    const calls = renderInsert();

    fireEvent.change(insertBuffer(), { target: { value: '{name: nope}' } });
    fireEvent.click(insertButton());

    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toHaveLength(0);
  });
});

// The write payload must be Canonical EJSON. `stripIdForDuplicate` (the
// Duplicate-document seed) hands this editor the *readable* form: a date as
// `{"$date":"<ISO>"}` and an int32 as a bare number. Fields view revives it
// (typed BSON instances) and the save path re-stringifies with
// `ejsonStringify`, so no round trip through the JSON view's Shell Syntax
// reader is needed for this to hold — it is asserted here anyway, once, as
// a regression guard on the same seam.
describe('DocumentEditor — insert mode — the write payload is Canonical EJSON', () => {
  it('canonicalizes a readable duplicate seed before it crosses IPC', async () => {
    const insert = vi.fn().mockResolvedValue({ insertedId: 'new' });
    installAtelierMock({ doc: { insert } });

    render(
      <DocumentEditor
        mode="insert"
        collection="coll"
        connectionId="c1"
        dbName="db"
        initialDocJson={'{\n  "age": 67,\n  "createdAt": {\n    "$date": "2025-01-31T00:48:48.524Z"\n  }\n}'}
        onClose={() => undefined}
        onInserted={() => undefined}
      />,
    );

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^Insert/ }));

    await waitFor(() => expect(insert).toHaveBeenCalledTimes(1));
    const { docJson } = insert.mock.calls[0]![0] as { docJson: string };
    expect(docJson).toContain('"createdAt":{"$date":{"$numberLong":"1738284528524"}}');
    expect(docJson).toContain('"age":{"$numberInt":"67"}');
    expect(docJson).not.toContain('2025-01-31T00:48:48.524Z');
  });
});
