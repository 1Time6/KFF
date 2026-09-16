import { z } from 'zod';
import { collectionSnapshotSchema } from './collection';

// This extension is assembled by the collection scheduler, never accepted as generic task input.
export const browserCollectionTaskSchema = z.object({
  run_id: z.string().uuid(), query_id: z.string().uuid(), token: z.string().regex(/^[1-9][0-9]*$/),
  page_number: z.number().int().min(1).max(100), cursor: z.string().min(1).max(2048).nullable(),
  limit: z.number().int().min(1).max(100), snapshot: collectionSnapshotSchema,
  snapshot_hash: z.string().regex(/^[a-f0-9]{64}$/),
  // Optional only for existing synthetic snapshots; Agent treats their command deadline as the limit.
  expires_at: z.string().datetime().optional(),
}).strict().refine(value => value.snapshot.discovery?.provider === 'LOCAL_BROWSER' && Boolean(value.snapshot.browser_environment), '分页任务需要固定的受管浏览器配置');
export type BrowserCollectionTask = z.infer<typeof browserCollectionTaskSchema>;
