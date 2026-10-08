import { ConfigManager } from '@isles/config';
import { buildApp } from './app.js';
import { webRoot } from './config.js';
import { openLogOutput } from './logging.js';

const config = new ConfigManager();
const logStream = await openLogOutput(config.current, {
  pretty: process.argv.includes('--pretty-logs'),
});
const app = await buildApp({
  config,
  webRoot,
  logStream,
});
// File writes are synchronous, so the entry is kept before Node reports the error and exits.
process.on('uncaughtExceptionMonitor', (error, origin) =>
  app.log.fatal({ err: error, origin }, 'Uncaught exception'),
);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } catch (error) {
    app.log.error({ err: error }, 'Server shutdown failed');
    process.exitCode = 1;
  } finally {
    logStream.close();
  }
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  await app.listen({ host: config.current.host, port: config.current.port });
} catch (error) {
  app.log.error({ err: error }, 'Server failed to listen');
  process.exitCode = 1;
  await app.close();
  logStream.close();
}
