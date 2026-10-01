import { PassThrough } from 'node:stream';
import * as repl from 'node:repl';
import { inspect } from 'node:util';
import { ejsonStringifyRelaxed } from '../mongo/ejson.ts';
import type { Channel } from './channel.ts';
import type { RpcClient } from './rpcClient.ts';
import { isShellInput, type ShellStartRequest } from './shellProtocol.ts';

/**
 * A shell session's REPL, running in the runner child. `repl.start` reads from
 * and writes to in-memory streams; main feeds the input stream with
 * `shell-in` messages and forwards what the output stream produces. The
 * session's `db` is the same RPC facade a script gets, so the REPL holds no
 * client and no credentials either: a `require('child_process')` typed here
 * reaches this process and nothing of main's.
 *
 * Runs under Electron's utilityProcess and Node's type stripping (see
 * `runner.ts`), so no enums, no parameter properties, no runtime path aliases.
 */
export function startShellSession(channel: Channel, rpc: RpcClient, req: ShellStartRequest): void {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  stdout.setEncoding('utf8');
  stdout.on('data', (chunk: string) => channel.post({ type: 'shell-out', data: chunk }));

  // `use foo` swaps this without rebuilding the `db` proxy.
  const ctx = { currentDb: req.dbName };
  const db = rpc.makeDb(ctx);

  // Before the REPL starts: it writes its own first prompt as it starts.
  stdout.write(`${req.banner}\n`);

  const server = repl.start({
    prompt: `${ctx.currentDb}> `,
    input: stdin,
    output: stdout,
    terminal: false,
    useColors: false,
    ignoreUndefined: true,
    writer: shellWriter,
  });
  server.context.db = db;
  server.context.use = (name: string) => {
    ctx.currentDb = name;
    server.setPrompt(`${name}> `);
    return `switched to db ${name}`;
  };
  server.context.help = helpText;
  // Mongosh-style `show ...` sugar (rewritten in main). Returned values flow
  // through the standard REPL writer, so they are formatted like any query.
  server.context.__shellShow = async (kind: 'dbs' | 'collections'): Promise<string> => {
    if (kind === 'dbs') {
      // `authorizedDatabases: true` lets users with scoped roles (Atlas
      // read-only, per-db users) see the dbs they have access to even when
      // they lack the cluster-wide listDatabases privilege.
      const admin = rpc.makeDb({ currentDb: 'admin' }) as {
        runCommand(cmd: object): Promise<{ databases: Array<{ name: string; sizeOnDisk?: number }> }>;
      };
      const r = await admin.runCommand({ listDatabases: 1, authorizedDatabases: true });
      return r.databases.map((d) => `${d.name}\t${d.sizeOnDisk ?? 0}`).join('\n');
    }
    const cursor = (db as { listCollections(): { toArray(): Promise<Array<{ name: string }>> } }).listCollections();
    return (await cursor.toArray()).map((c) => c.name).join('\n');
  };

  // A user's own un-awaited rejection must not take the session down.
  process.on('unhandledRejection', (reason) => {
    const message = (reason as { message?: unknown } | null)?.message;
    stdout.write(`Uncaught: ${typeof message === 'string' ? message : String(reason)}\n`);
  });

  server.on('exit', () => channel.post({ type: 'shell-exit' }));
  channel.onMessage((message) => {
    if (isShellInput(message)) stdin.write(message.data);
  });
}

function shellWriter(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  // EJSON returns undefined for values it can't serialize (e.g. plain
  // functions, including the `db` proxy). Fall through to util.inspect so
  // typing `db` still produces something readable.
  try {
    const ejson = ejsonStringifyRelaxed(value, 2);
    if (typeof ejson === 'string') return ejson;
  } catch {
    // fall through
  }
  return inspect(value, { depth: 4, colors: false });
}

function helpText(): string {
  return [
    "L'Atelier shell: a Node REPL with a Mongo driver context, run in its own process.",
    '',
    '  db                          — current database (use("name") to switch)',
    '  db.<coll>.find(filter, opt) — returns a cursor (call .toArray())',
    '  db.<coll>.findOne(filter)',
    '  db.<coll>.insertOne(doc)',
    '  db.<coll>.updateOne(filter, update)',
    '  db.<coll>.deleteOne(filter)',
    '  db.<coll>.countDocuments(filter)',
    '  db.<coll>.aggregate(pipeline).toArray()',
    '  db.runCommand({ ping: 1 })',
    '  show dbs / show collections',
    '',
    'All async ops can be awaited at the top level.',
  ].join('\n');
}
