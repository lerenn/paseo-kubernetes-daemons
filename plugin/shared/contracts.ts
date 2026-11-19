import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';
export const nameSchema = z.string().max(50).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
export const requestSchema = z.object({ name: nameSchema });
export const createEnvironment = defineRpc({ name: 'environment.create', input: requestSchema, output: z.unknown() });
export const listEnvironments = defineRpc({ name: 'environment.list', input: z.object({}), output: z.unknown() });
export const releaseEnvironment = defineRpc({ name: 'environment.release', input: requestSchema, output: z.unknown() });
