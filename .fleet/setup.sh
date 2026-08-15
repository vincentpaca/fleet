#!/usr/bin/env sh
# Environment setup for a fleet job on this repo. Runs with unrestricted
# egress before the harness starts; keep it deterministic and fast.
set -e
npm install --no-fund --no-audit
