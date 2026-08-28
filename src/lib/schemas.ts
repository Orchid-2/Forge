/**
 * Shared request schemas.
 *
 * These live outside the route files because a Next.js route module may only
 * export its HTTP handlers and route config — exporting a schema from one and
 * importing it into its `[id]` sibling fails the build.
 */
import { z } from 'zod';

const providerEnum = z.enum(['ollama', 'llamacpp', 'openai-compat']);

export const profileInput = z.object({
  name: z.string().min(1).max(60),
  description: z.string().max(200).nullable().optional(),
  icon: z.string().max(8).optional(),
  accent: z.string().max(40).optional(),
  systemPrompt: z.string().default(''),
  provider: providerEnum.nullable().optional(),
  model: z.string().nullable().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(0).max(200).optional(),
  repeatPenalty: z.number().min(0.5).max(2).optional(),
  maxTokens: z.number().int().min(64).max(131072).optional(),
  contextWindow: z.number().int().min(512).max(1_048_576).nullable().optional(),
  stopSequences: z.array(z.string()).optional(),
  enabledTools: z.array(z.string()).optional(),
  memoryRead: z.boolean().optional(),
  memoryWrite: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});

export const profilePatch = profileInput.partial().extend({
  isDefault: z.boolean().optional(),
  archived: z.boolean().optional(),
});

export const projectInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(400).nullable().optional(),
  icon: z.string().max(8).optional(),
  accent: z.string().max(40).optional(),
  systemPrompt: z.string().default(''),
  defaultProfileId: z.string().nullable().optional(),
  defaultProvider: providerEnum.nullable().optional(),
  defaultModel: z.string().nullable().optional(),
  memoryScoped: z.boolean().optional(),
  pinned: z.boolean().optional(),
});

export const projectPatch = projectInput.partial().extend({
  archived: z.boolean().optional(),
});

export const mcpInput = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(300).nullable().optional(),
  transport: z.enum(['stdio', 'http', 'sse']).default('stdio'),
  command: z.string().nullable().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().nullable().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional(),
});

export const goalInput = z.object({
  title: z.string().min(1).max(100),
  description: z.string().max(300).nullable().optional(),
  icon: z.string().max(8).optional(),
  accent: z.string().max(40).optional(),
  kind: z.enum(['counter', 'streak', 'target']).optional(),
  unit: z.string().max(20).optional(),
  target: z.number().min(0).optional(),
});

export const goalPatch = goalInput.partial().extend({
  archived: z.boolean().optional(),
});
