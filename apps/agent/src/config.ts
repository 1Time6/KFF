import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

export const runtimeDir = path.join(process.env.KFF_ROOT ?? process.cwd(), '.kff');
const configured = z.object({ agent_id: z.string().uuid(), organization_id: z.string().uuid(), brand_id: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/), controller_origin: z.string().url() }).strict().parse(JSON.parse(readFileSync(path.join(runtimeDir, 'agent-config.json'), 'utf8')));
const controller = new URL(process.env.KFF_APP_ORIGIN ?? configured.controller_origin);
if (controller.origin !== controller.href.replace(/\/$/, '') || controller.username || controller.password || !(controller.protocol === 'https:' || (controller.protocol === 'http:' && controller.hostname === '127.0.0.1'))) throw new Error('INVALID_CONTROLLER_ORIGIN');
export const agentConfig = { ...configured, token: process.env.KFF_AGENT_TOKEN ?? configured.token, controller_origin: controller.origin };
