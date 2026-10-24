/** Shared koffi loader: rides the pinned DSH runtime's own koffi build. */
const {join, resolve} = require('node:path');
const {existsSync} = require('node:fs');
const embedded = join(process.cwd(), '.companyos-embedded', 'dsh-runtime', 'runtime', 'node_modules', '.pnpm', 'koffi@3.1.1', 'node_modules', 'koffi');
module.exports = existsSync(resolve(embedded, 'package.json')) ? require(embedded) : require('koffi');
