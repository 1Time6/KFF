import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The one canonical hash of a source file.
 *
 * Git may materialise a tracked checkout with either CRLF or LF depending on `core.autocrlf`, while
 * the repository stores LF. A hash taken over raw bytes therefore describes the checkout rather than
 * the source: the same revision produced different build and Agent manifests on two machines, and a
 * fresh clone whose `core.autocrlf` was true failed the runtime's own "run a successful current
 * build first" and "installed Agent differs from the current source" checks with no source change at
 * all. Hashing the newline-normalised text makes the manifest a property of the revision.
 *
 * `.gitattributes` pins `eol=lf` for these paths, so the normalisation is a guard rather than the
 * only thing keeping the checks honest.
 */
export function sourceText(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}
export function sourceHash(file) {
  return createHash('sha256').update(sourceText(file), 'utf8').digest('hex');
}
export function bufferHash(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
