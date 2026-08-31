#!/usr/bin/env node
import { writeFileSync } from 'node:fs';

if (process.argv[2] === '--sdk-identity') {
  console.log(JSON.stringify({
    engineVersion: '9.0.0',
    machineProtocolVersion: 99,
  }));
  process.exit(0);
}

if (process.env.NIKA_EFFECT_SENTINEL) {
  writeFileSync(process.env.NIKA_EFFECT_SENTINEL, 'effected');
}
process.exit(0);
