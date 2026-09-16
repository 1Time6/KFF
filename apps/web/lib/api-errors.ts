/**
 * Field-level validation errors for the API error contract.
 *
 * The route returned only `error.issues[0].message`, so the field path was lost and the client could
 * not point at the input to fix: a form with several problems showed one sentence with no location.
 * The payload below keeps the stable `code` / `request_id` shape and adds a bounded `field_errors`
 * list, so the page can locate the field while the server check stays the final authority.
 *
 * Two limits are deliberate:
 *  - at most `LIMIT` entries are reported, so a large payload cannot turn one response into a wall
 *    of text or leak the whole schema;
 *  - the message is the validator's own text and the path is the field path only. Table names, SQL,
 *    constraint text and private values are never included, which is why the unique-violation case
 *    is recognised by constraint name rather than by echoing the database error.
 */
export const FIELD_ERROR_LIMIT = 12;
export interface FieldError { field: string; message: string }
export interface ValidationIssue { path: readonly (string | number | symbol)[]; message: string }

/** The dotted field path of an issue, or the whole request when the issue is not field-specific. */
export function fieldPathOf(issue: Pick<ValidationIssue, 'path'>): string {
  const parts = (issue.path ?? []).map(part => String(part)).filter(part => part.length > 0);
  // An empty path is a whole-object refinement; it is reported against the request itself.
  return parts.length ? parts.join('.') : '(request)';
}

/** Build the bounded, ordered field-error list for a set of validation issues. */
export function fieldErrorsFrom(issues: readonly ValidationIssue[]): FieldError[] {
  const seen = new Set<string>();
  const errors: FieldError[] = [];
  for (const issue of issues) {
    const field = fieldPathOf(issue);
    // One entry per field: repeating the same path crowds out the other problems.
    if (seen.has(field)) continue;
    seen.add(field);
    errors.push({ field, message: issue.message });
    if (errors.length >= FIELD_ERROR_LIMIT) break;
  }
  return errors;
}

/** A readable summary that names the first field instead of only quoting a message. */
export function validationSummary(errors: readonly FieldError[]): string {
  if (!errors.length) return '输入无效';
  const first = errors[0];
  const where = first.field === '(request)' ? '' : first.field + '：';
  return errors.length === 1 ? where + first.message : where + first.message + `（共 ${errors.length} 项需要修改）`;
}

/**
 * Recognise the unique-constraint violations the product can explain, by constraint name. Anything
 * unrecognised keeps the generic conflict message: the database error itself is never returned,
 * because it carries table, column and value details.
 */
export const KNOWN_UNIQUE_CONSTRAINTS: Record<string, string> = {
  accounts_brand_id_platform_account_type_external_id_is_synthetic_key: '此品牌下已存在相同的平台账号（平台、类型与数字 ID 相同）。',
  facebook_connections_page_id_is_synthetic_key: '此平台主页已配置过接待连接，请直接编辑现有连接。',
  contact_targets_brand_id_account_id_channel_remote_id_key: '此账号下已登记过相同的联系目标。',
  capabilities_account_id_capability_key_key: '此账号已存在相同能力的记录。',
  template_versions_organization_id_brand_id_capability_key_version_number_key: '此动作下已存在相同版本号，请使用新的版本号。',
  customer_identities_organization_id_brand_id_account_id_platform_remote_id_key: '此账号下已存在相同平台标识的客户身份。',
};
export function uniqueViolationMessage(constraint: string | undefined): { message: string; recognized: boolean } {
  const known = constraint ? KNOWN_UNIQUE_CONSTRAINTS[constraint] : undefined;
  if (known) return { message: known, recognized: true };
  return { message: '记录已存在或与现有数据冲突，请刷新后核对再提交。', recognized: false };
}
