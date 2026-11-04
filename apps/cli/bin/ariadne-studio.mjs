#!/usr/bin/env node
// Checked before the bundle loads, so an old Node gets this message instead of
// a syntax or import error from somewhere inside the server.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`Ariadne Studio needs Node.js 22.12 or newer; this is ${process.version}.`);
  console.error('Install the current LTS from https://nodejs.org and run it again.');
  process.exit(1);
}
await import('../dist/cli.mjs');
