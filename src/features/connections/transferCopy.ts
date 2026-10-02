import type { RepickFile } from '@shared/types';

/** Mirrors the minimum main enforces (C13 §2); main stays the authority. */
export const MIN_EXPORT_PASSPHRASE_LENGTH = 12;

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

export const REPICK_LABEL: Record<RepickFile, string> = {
  tlsCa: 're-pick CA file',
  tlsClientCert: 're-pick client certificate',
  sshKey: 're-pick SSH key',
};
