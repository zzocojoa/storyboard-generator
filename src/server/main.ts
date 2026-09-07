import { CodexRequestStore } from '../codex/requests.js';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import { createApp } from './app.js';
import { ProjectStore } from './store.js';
import type { FastifyInstance } from 'fastify';

const configPath: string = process.argv[2] ?? 'storyboard.config.json';
const config: AppConfig = await loadConfig(configPath);
const store: ProjectStore = new ProjectStore(config.dataRoot);
const requests: CodexRequestStore = new CodexRequestStore(config.codex.requestRoot);
const app: FastifyInstance = await createApp(config, store, requests);
await app.listen({ host: config.host, port: config.port });
