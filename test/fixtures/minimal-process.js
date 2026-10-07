'use strict';

// Minimal sandbox process shim, loaded via `node -r` before index.js.
// Strips the node process features the openpave SpiderMonkey sandbox does not
// provide (no stdout/stderr streams, no .on(), no .exit()) while keeping
// console.log/console.error functional — the sandbox console maps to print()
// independent of process.stdout, and this mirrors that by writing straight to
// the captured fd streams.

var realStdoutWrite = process.stdout.write.bind(process.stdout);
var realStderrWrite = process.stderr.write.bind(process.stderr);

process.stdout.write = undefined;
process.stderr.write = undefined;
process.on = undefined;
process.exit = undefined;

console.log = function () {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
  realStdoutWrite(parts.join(' ') + '\n');
};
console.error = function () {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) parts.push(String(arguments[i]));
  realStderrWrite(parts.join(' ') + '\n');
};
