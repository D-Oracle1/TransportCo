// Client-safe entry point (bundled into the mobile apps). The server-only env
// loader — which uses node:fs and dotenv — is intentionally NOT re-exported
// here; import it from '@transportco/config/env' instead. Keeping it out of the
// main entry prevents Metro/React Native from trying to bundle node:fs.
export * from './defaults';
export * from './brand';
