/**
 * Whether a Mongo host string refers to this machine only. Used to decide
 * whether turning TLS off exposes credentials to a network path.
 *
 * Accepts what the Host field can hold: a bare host, `host:port`, a bracketed
 * IPv6 literal (`[::1]:27017`), or a comma-separated seed list. A list is
 * local only if every entry is local — one remote seed is enough to put
 * traffic on the network. An empty string has no entries and is reported as
 * local so a blank field never warns.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function stripPort(entry: string): string {
  if (entry.startsWith('[')) {
    const close = entry.indexOf(']');
    return close === -1 ? entry : entry.slice(1, close);
  }
  // A single colon is host:port; several are a bare IPv6 literal.
  const first = entry.indexOf(':');
  return first !== -1 && first === entry.lastIndexOf(':') ? entry.slice(0, first) : entry;
}

export function isLocalHost(host: string): boolean {
  return host
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .every((entry) => LOCAL_HOSTS.has(stripPort(entry.toLowerCase())));
}

export interface TlsPosture {
  enabled: boolean;
  verify: boolean;
  host: string;
  /** The Mongo hop is to the tunnel's far side, not this machine. */
  viaSshTunnel: boolean;
}

/**
 * The warning to show for a weakened transport, or null when the posture is
 * fine. Two cases: certificate verification off (also disables the hostname
 * check), and TLS off towards a host that is not local. With an SSH tunnel
 * the host is resolved from the bastion, so `localhost` there is still local
 * to the database and stays quiet, while a remote host keeps the warning: the
 * tunnel encrypts only the hop to the bastion, not the bastion-to-mongod hop.
 */
export function tlsWarning(p: TlsPosture): string | null {
  if (p.enabled) {
    return p.verify
      ? null
      : 'Certificate and hostname checks are off. Anyone on the network path can impersonate this server and read your credentials.';
  }
  if (isLocalHost(p.host)) return null;
  return p.viaSshTunnel
    ? 'TLS is off. The SSH tunnel does not encrypt the last hop from the tunnel to this host, so credentials and data travel in cleartext on that hop.'
    : 'TLS is off for a host that is not local. Credentials and data travel in cleartext and anyone on the network path can read them.';
}
