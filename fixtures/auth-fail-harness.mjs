// Fake harness CLI for the auth-failure park tests (#205). Three shapes of
// dying, selected by argv[2]:
//
//   plain (default) — what headless claude actually does on a dead
//     credential: a stream init line, then the plain (non-JSON) refusal
//     "Invalid API key · Please run /login" on stdout, exit 1.
//   content — an auth-looking string inside ASSISTANT content, exit 1 for an
//     unrelated reason. The conservative signature scope must NOT read job
//     content as a credential failure; this run stays cancelled(harness-exit).
//   stderr — the refusal on stderr only, exit 1: the CLI's error channel.
const mode = process.argv[2] ?? 'plain';
const line = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

line({ type: 'system', subtype: 'init', model: 'claude-test' });

if (mode === 'plain') {
  process.stdout.write('Invalid API key · Please run /login\n');
} else if (mode === 'content') {
  line({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'This test covers the authentication_error path; also: Invalid API key handling.' },
      ],
    },
  });
} else if (mode === 'stderr') {
  process.stderr.write('OAuth token has expired. Please obtain a new token or refresh your existing token.\n');
}

process.exit(1);
