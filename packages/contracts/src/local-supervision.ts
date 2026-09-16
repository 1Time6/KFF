/** Local parent/child IPC only; never accepted as a remote task. */
export const localSupervisionProtocol = 'kff.local-supervision.v1';
export function isDrainRequest(value:unknown):boolean {
  return typeof value==='object'&&value!==null&&Object.keys(value).length===2&&'protocol' in value&&value.protocol===localSupervisionProtocol&&'command' in value&&value.command==='drain';
}
