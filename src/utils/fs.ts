import { writeFileSync, renameSync } from 'fs';

/**
 * Atomic file write: write to .tmp, then rename.
 * Prevents corruption if process crashes mid-write.
 */
export function atomicWriteFileSync(path: string, data: string): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}
