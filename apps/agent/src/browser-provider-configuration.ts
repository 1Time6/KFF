import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Read only this host's optional key file. Never include it in controller messages or logs. */
export function browserProviderEnvironment(root: string, environment: Readonly<Record<string, string | undefined>> = process.env) {
  const values = Object.fromEntries(Object.entries(environment).filter(([key]) => /^(KFF_ADSPOWER_ORIGIN|KFF_ADSPOWER_API_KEY|KFF_BROWSER_PROXY_[A-Z0-9_]+)$/.test(key)));
  const file = path.join(root, '.kff', 'adspower-api-key.txt');
  if (!values.KFF_ADSPOWER_API_KEY && existsSync(file)) {
    const key = readFileSync(file, 'utf8').trim();
    if (key.length > 8192 || /[\r\n]/.test(key)) throw new Error('INVALID_ADSPOWER_KEY_FILE');
    if (key) values.KFF_ADSPOWER_API_KEY = key;
  }
  return values;
}
