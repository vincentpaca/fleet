/**
 * Unit coverage for the two runner timers, using the injected `now` both were
 * built with. The blocked-time-exclusion arithmetic lives here, deterministic
 * and instant; the seconds-scale e2e tests (runner-stall, runner-wall-clock)
 * keep only the wiring claim — that the decision watcher actually calls
 * block()/resume() on these meters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WallClockTimer } from '../src/runner/wall-clock.ts';
import { IdleTimer } from '../src/runner/idle.ts';

const T0 = 1_000_000;

test('wall-clock: a blocked interval spanning the limit does not expire the budget', () => {
  const timer = new WallClockTimer(10_000, T0);
  timer.block(T0 + 2_000);
  // 20s of wall time pass while blocked — active time is still 2s.
  assert.equal(timer.activeMs(T0 + 22_000), 2_000);
  assert.equal(timer.expired(T0 + 22_000), false);
  assert.equal(timer.remainingMs(T0 + 22_000), 8_000);
});

test('wall-clock: resume restarts the meter and the budget then expires on active time', () => {
  const timer = new WallClockTimer(10_000, T0);
  timer.block(T0 + 2_000);
  timer.resume(T0 + 22_000);
  assert.equal(timer.blockedMs(T0 + 22_000), 20_000);
  // 8s more active runtime reaches the 10s limit exactly.
  assert.equal(timer.expired(T0 + 29_999), false);
  assert.equal(timer.expired(T0 + 30_000), true);
  assert.equal(timer.remainingMs(T0 + 30_000), 0);
});

test('wall-clock: block and resume are idempotent', () => {
  const timer = new WallClockTimer(10_000, T0);
  timer.block(T0 + 1_000);
  timer.block(T0 + 5_000); // ignored: interval already open at +1s
  timer.resume(T0 + 6_000);
  timer.resume(T0 + 9_000); // ignored: no interval open
  assert.equal(timer.blockedMs(T0 + 9_000), 5_000);
  assert.equal(timer.activeMs(T0 + 9_000), 4_000);
});

test('idle: silence past the limit expires; a touch restarts the window', () => {
  const idle = new IdleTimer(5_000, T0);
  assert.equal(idle.expired(T0 + 4_999), false);
  assert.equal(idle.expired(T0 + 5_000), true);
  idle.touch(T0 + 3_000);
  assert.equal(idle.idleMs(T0 + 7_000), 4_000);
  assert.equal(idle.expired(T0 + 7_000), false);
  assert.equal(idle.expired(T0 + 8_000), true);
});

test('idle: blocked time is excluded from the idle window', () => {
  const idle = new IdleTimer(5_000, T0);
  idle.block(T0 + 2_000);
  // A minute passes waiting on the operator: not a stall.
  assert.equal(idle.idleMs(T0 + 62_000), 2_000);
  assert.equal(idle.expired(T0 + 62_000), false);
  idle.resume(T0 + 62_000);
  assert.equal(idle.expired(T0 + 64_999), false);
  assert.equal(idle.expired(T0 + 65_000), true);
});

test('idle: a touch during a blocked interval carries the blocked state over', () => {
  // The harness polls for its answer and each poll line touches the timer;
  // the restarted window must still be blocked or the wait would count as
  // silence again.
  const idle = new IdleTimer(5_000, T0);
  idle.block(T0 + 1_000);
  idle.touch(T0 + 10_000);
  assert.equal(idle.idleMs(T0 + 60_000), 0, 'still blocked: no idle time accrues');
  assert.equal(idle.expired(T0 + 60_000), false);
  idle.resume(T0 + 60_000);
  assert.equal(idle.expired(T0 + 65_000), true, 'window runs from resume once unblocked');
});
