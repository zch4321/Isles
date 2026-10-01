import { buildApp } from './app.js';
import { readConfig } from './config.js';

const config = readConfig();
const app = await buildApp({
  dataDir: config.dataDir,
  webRoot: config.webRoot,
  schedule: config.schedule,
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
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
