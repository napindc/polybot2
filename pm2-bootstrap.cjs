/**
 * PM2 bootstrap — loads tsx register and runs the main entry point.
 * This avoids Windows issues with PM2 not finding .cmd interpreters.
 */
require('tsx/cjs');
require('./src/index.ts');
