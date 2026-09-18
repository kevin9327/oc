/**
 * Shared test support. `node --test` collects `*.test.js` only, so nothing
 * here runs as a test of its own.
 */

import { writeFileSync, chmodSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Whether a permission-bit assertion means anything on this filesystem.
 * Windows derives all nine bits from the read-only attribute, so a writable
 * file always reports 0o666 and who else can read it is decided by the ACL it
 * inherits from its directory; an exFAT, SMB, or bind-mounted scratch disk
 * reports the mount's fixed mode. On those a mode check tests the filesystem
 * rather than oc, so the caller skips it by name instead of asserting
 * something weaker under the name of the real check.
 * @param {string} dir - a writable directory on the filesystem under test
 * @returns {string|false} the skip reason, or false when modes are honored
 */
export function modeSkip(dir) {
  const probe = join(dir, '.oc-mode-probe');
  try {
    writeFileSync(probe, '', { mode: 0o600 });
    chmodSync(probe, 0o600);
    if ((statSync(probe).mode & 0o777) === 0o600) return false;
  } catch {
    // A filesystem that refuses chmod outright cannot keep the promise the
    // assertion checks either, so it skips for the same reason.
  } finally {
    try {
      unlinkSync(probe);
    } catch {
      // Nothing to clean up: the probe was never created.
    }
  }
  return 'filesystem does not store POSIX permission bits';
}
