// A private temp namespace per test process, installed before any test runs.
//
// `node --test` gives every test file its own process, and each one was minting
// names directly in the shared system temp directory. Two processes that start
// in the same instant can walk the same name sequence, so one file's fresh
// directory could be another file's just-deleted one. That is the cause of two
// intermittent CI failures which looked unrelated: a test that deleted a
// workspace found it still present, and a test that created one found it gone.
//
// Each process points TMPDIR at its own directory. os.tmpdir() reads the
// variable on every call, so this reaches the thirty-odd files that call
// mkdtempSync directly without touching them, and the CLI and daemon children
// they spawn inherit it too. Removing it at exit also stops the suite leaking
// workspaces — a full run used to leave thousands behind.
//
// Two constraints shape the layout, and both were paid for:
//   - One level, not nested. Every process bases its directory on the real
//     system temp directory, remembered here, rather than on whatever TMPDIR
//     currently says. Nesting each process inside its parent's directory put
//     unix socket paths over the 104-byte sun_path limit on macOS and failed
//     144 tests at once.
//   - Short names. A single `f` plus mkdtemp's six random characters costs
//     eight characters of path. Including the pid as well cost six more and
//     pushed one daemon socket to 105 bytes — one over the limit. mkdtemp
//     already guarantees the directory is this process's alone, so the pid
//     bought nothing.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SYSTEM_TMP = 'FLEET_TEST_SYSTEM_TMP';
const systemTmp = process.env[SYSTEM_TMP] ?? tmpdir();
process.env[SYSTEM_TMP] = systemTmp;

const mine = mkdtempSync(join(systemTmp, 'f'));
process.env.TMPDIR = mine;

process.on('exit', () => {
  try {
    rmSync(mine, { recursive: true, force: true });
  } catch {
    // A leftover directory is untidy, never a test failure.
  }
});
