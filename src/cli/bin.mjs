#!/usr/bin/env node
// fleet — the installed entrypoint (#66).
//
// Node refuses to type-strip .ts files under node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so an npm-installed copy of
// this package cannot execute src/cli/main.ts directly — a .ts bin works from
// a checkout and dies the moment npm installs it. This shim registers a loader
// hook that performs the same erasable-syntax strip through the public
// node:module API, which does not care where the files live, then hands over
// to main.ts. From a checkout it behaves identically, so there is one entry
// path, not two. Gate: test/packaging-install.test.ts.
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// stripTypeScriptTypes emits one ExperimentalWarning per process. It is the
// same strip the native loader applies (our engines floor, >=23.6, ships it);
// a CLI that warns on stderr on every invocation teaches users to ignore
// stderr, so silence exactly that warning and no other.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes('stripTypeScriptTypes')) return;
  emitWarning(warning, ...rest);
};

registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    const source = stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8'), { mode: 'strip' });
    return { format: 'module', source, shortCircuit: true };
  },
});

await import('./main.ts');
