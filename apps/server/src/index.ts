import { ConfigManager } from '@isles/config';
import { buildApp } from './app.js';
import { webRoot } from './config.js';

const config = new ConfigManager();
const app = await buildApp({
  config,
  webRoot,
  logger: true,
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

try {
  await app.listen({ host: config.current.host, port: config.current.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
