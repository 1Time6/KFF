import { z } from 'zod';

export const minorAmount = z.string().regex(/^(0|[1-9][0-9]{0,14})$/);
export const budgetInput = z.object({
  request_id: z.string().uuid(), expected_version: z.number().int().min(0),
  currency: z.string().regex(/^[A-Z]{3}$/), minor_unit_exponent: z.number().int().min(0).max(6),
  precision_source: z.string().trim().min(5).max(300), limit_minor: minorAmount,
  reason: z.string().trim().min(5).max(300),
}).strict();
export const costReconciliationInput = z.object({
  request_id: z.string().uuid(), expected_version: z.number().int().positive(),
  decision: z.enum(['PENDING','SETTLE','RELEASE','ADJUST']), actual_cost_minor: minorAmount.nullable(),
  evidence_ref: z.string().trim().min(1).max(300), note: z.string().trim().min(10).max(1000),
  confirmation: z.literal('I_RECONCILED_THIS_COST'),
}).strict().refine(value => value.decision === 'PENDING' ? value.actual_cost_minor === null : value.decision === 'RELEASE' ? value.actual_cost_minor === '0' : value.actual_cost_minor !== null, '待核账不填写实际金额，释放必须有明确零费用依据');

export interface CostBalance {
  currency: string; id: string | null; minor_unit_exponent: number | null; precision_source: string | null;
  limit_minor: string | null; version: number | null; held_minor: string; confirmed_minor: string;
  pending_count: number; available_minor: string | null;
}
export interface CostRecord {
  action_id: string; permit_id: string | null; currency: string; reserved_minor: string; actual_cost_minor: string | null;
  state: 'RESERVED' | 'PENDING_RECONCILIATION' | 'SETTLED' | 'RELEASED'; version: number;
  cost_basis: string; evidence_ref: string | null; title: string; created_at: string;
}
export interface CostEvent {
  id: string; action_id: string | null; currency: string;
  event_type: 'LIMIT_SET' | 'RESERVED' | 'PENDING_RECONCILIATION' | 'SETTLED' | 'RELEASED' | 'ADJUSTED';
  created_at: string; details: { evidence_ref?: string; actual_cost_minor?: string | null; reserved_minor?: string; reason?: string };
}
export interface CostWorkspace { balances: CostBalance[]; reservations: CostRecord[]; entries: CostEvent[] }
