import { fileURLToPath } from 'node:url';

/** Only packaged resources are located relative to the Isles installation. */
export const installationRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const webRoot = fileURLToPath(new URL('../../../apps/web/dist/', import.meta.url));
