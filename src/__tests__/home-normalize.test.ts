/**
 * Git Bash on Windows exports `HOME` as a POSIX path (`/c/Users/alice`). Node's
 * `path` is native there, so joining that string onto `.teamai/...` targets a
 * drive-root path (`\c\Users\alice`) instead of `C:\Users\alice` — credentials,
 * the repo cache and the path-safety allowlist would all land somewhere the user
 * never looks. `normalizeHomePath` converts exactly that shape and nothing else.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { normalizeHomePath } from '../utils/home.js';

const realPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

afterEach(() => setPlatform(realPlatform));

describe('normalizeHomePath', () => {
  it('converts a Git Bash drive path to native form', () => {
    setPlatform('win32');
    expect(normalizeHomePath('/c/Users/alice')).toBe('C:\\Users\\alice');
    expect(normalizeHomePath('/d/work/home')).toBe('D:\\work\\home');
    expect(normalizeHomePath('/c')).toBe('C:\\');
  });

  it('converts a /cygdrive/ path', () => {
    setPlatform('win32');
    expect(normalizeHomePath('/cygdrive/c/Users/alice')).toBe(
      'C:\\Users\\alice',
    );
  });

  it('leaves an already-native Windows home alone', () => {
    setPlatform('win32');
    expect(normalizeHomePath('C:\\Users\\alice')).toBe('C:\\Users\\alice');
    expect(normalizeHomePath('C:/Users/alice')).toBe('C:/Users/alice');
  });

  it('does not mistake a POSIX home for a drive path', () => {
    setPlatform('win32');
    // Only a single-letter root is an MSYS drive; /home and /usr are not.
    expect(normalizeHomePath('/home/alice')).toBe('/home/alice');
    expect(normalizeHomePath('/usr/share')).toBe('/usr/share');
    expect(normalizeHomePath('/cygdrive')).toBe('/cygdrive');
  });

  it('never rewrites anything on POSIX platforms', () => {
    setPlatform('linux');
    expect(normalizeHomePath('/c/Users/alice')).toBe('/c/Users/alice');
    setPlatform('darwin');
    expect(normalizeHomePath('/c/Users/alice')).toBe('/c/Users/alice');
  });
});
