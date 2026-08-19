#!/usr/bin/env node
// Stand-in for the `aws` CLI, for `fleet connect` end-to-end tests (#57).
// Answers the three calls the ECS tunnel opener makes, and for the port-forward
// itself behaves the way the real one does: `aws ssm start-session` is a
// LAUNCHER — it forks session-manager-plugin, and that grandchild is what binds
// the local port and proxies it. Signalling only the launcher leaves the
// grandchild holding the port, which is the failure a test has to be able to see.
//
// The proxy is real TCP, so a test's /health goes through the forward rather
// than around it. FAKE_AWS_TARGET_PORT names what the far end would have been.
//
// State lives in FAKE_AWS_DIR:
//   round        — bumped by every start-session, so the next list-tasks reports
//                  a different task id: a service deployment, without a service.
//   sessions.log — one line per start-session, "<target> <launcherPid> <holderPid>"
//                  ("-" for a holder when the session died before forking one).
//   die-first    — present: the first start-session exits 1 instead of holding.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);

// --- the "plugin": bind the local port and proxy it to the far end ------------
if (args[0] === '--hold') {
  const [localPort, targetPort] = args.slice(1).map(Number);
  const server = net.createServer((client) => {
    const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
    client.pipe(upstream);
    upstream.pipe(client);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', drop);
    upstream.on('error', drop);
  });
  server.listen(localPort, '127.0.0.1');
  // No signal handlers on purpose: this process dies only when the whole
  // process group is signalled, exactly like the real plugin.
} else {
  const dir = process.env.FAKE_AWS_DIR;
  if (!dir) {
    process.stderr.write('fake-aws: FAKE_AWS_DIR is not set\n');
    process.exit(2);
  }
  const roundFile = join(dir, 'round');
  const readRound = () => (existsSync(roundFile) ? Number(readFileSync(roundFile, 'utf8')) : 1);
  const [service, action] = args;

  if (service === 'ecs' && action === 'list-tasks') {
    const round = readRound();
    process.stdout.write(
      JSON.stringify({ taskArns: [`arn:aws:ecs:us-east-1:111122223333:task/fleet/task-${round}`] }),
    );
    process.exit(0);
  } else if (service === 'ecs' && action === 'describe-tasks') {
    const round = readRound();
    process.stdout.write(
      JSON.stringify({
        tasks: [
          {
            lastStatus: 'RUNNING',
            containers: [{ name: 'fleet-daemon', runtimeId: `rt-${round}` }],
          },
        ],
      }),
    );
    process.exit(0);
  } else if (service === 'ssm' && action === 'start-session') {
    const target = args[args.indexOf('--target') + 1];
    const parameters = JSON.parse(args[args.indexOf('--parameters') + 1]);
    const localPort = Number(parameters.localPortNumber[0]);
    const round = readRound();
    // The task the next session resolves must differ: that is the deployment.
    writeFileSync(roundFile, String(round + 1));
    if (round === 1 && existsSync(join(dir, 'die-first'))) {
      appendFileSync(join(dir, 'sessions.log'), `${target} ${process.pid} -\n`);
      process.stderr.write('fake-aws: session terminated\n');
      process.exit(1);
    }
    // Plain child: same process group, no signal handlers, outlives its parent.
    const holder = spawn(
      process.execPath,
      [SELF, '--hold', String(localPort), String(process.env.FAKE_AWS_TARGET_PORT ?? 0)],
      { stdio: 'ignore' },
    );
    appendFileSync(join(dir, 'sessions.log'), `${target} ${process.pid} ${holder.pid}\n`);
    // The real launcher waits on its plugin, so it reaps it. Handling the
    // signals as no-ops (rather than exiting on them) keeps that true: a group
    // SIGTERM stops the holder, this process reaps it, and nothing is left
    // behind as a zombie for a test to mistake for "still holding the port".
    holder.on('exit', () => process.exit(0));
    setInterval(() => {}, 1_000);
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
  } else {
    process.stderr.write(`fake-aws: unexpected call: ${args.join(' ')}\n`);
    process.exit(2);
  }
}
