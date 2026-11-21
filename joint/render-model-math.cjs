const fs = require('node:fs');
const katex = require('./build-vendor/katex.min.js');

const expressions = JSON.parse(fs.readFileSync(0, 'utf8'));
process.stdout.write(JSON.stringify(expressions.map(({ tex, display }) =>
  katex.renderToString(tex, {
    displayMode: display,
    output: 'mathml',
    strict: 'error',
    throwOnError: true,
  })
)));
