/**
 * Create a file only if it is not already there, in one syscall.
 *
 * The shape this replaces — `if (!existsSync(p)) writeFileSync(p, data)` —
 * reads as "never clobber the operator's own file", and that is the right
 * intent. The gap between the two calls is what goes wrong: `fleet setup` run
 * twice in the same checkout, or a job materialising a workspace while the CLI
 * scaffolds it, and both callers see "absent" and both write. The second one
 * wins and the first one's file is gone, which is exactly the outcome the
 * check existed to prevent.
 *
 * The `wx` flag moves the decision into the kernel (`O_CREAT | O_EXCL`), where
 * create-if-absent is one indivisible operation. Nothing can interleave.
 *
 * Returns true when this call created the file and false when it was already
 * there, so callers can still report "wrote" against "kept existing" without
 * asking the filesystem a second question — asking again would reintroduce the
 * gap this exists to close.
 */
import { writeFileSync } from 'node:fs';

export function createIfAbsent(
  path: string,
  data: string | Buffer,
  options: { mode?: number } = {},
): boolean {
  try {
    writeFileSync(path, data, { ...options, flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}
