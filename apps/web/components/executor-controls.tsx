'use client';
import { useId, useState } from 'react';
import type { Workspace } from '@kff/core/service';
import type { createAgent } from '@kff/core/controls';

async function post<T>(endpoint: string, input: unknown): Promise<T> {
  const response = await fetch('/api/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const value = await response.json(); if (!response.ok) throw new Error(value.error?.message ?? '操作未完成'); return value;
}
export function ExecutorControls({ data, busy, act }: { data: Workspace; busy: boolean; act(operation: () => Promise<unknown>, message?: string): Promise<void> }) {
  const inputId = useId();
  const [pairing, setPairing] = useState<Awaited<ReturnType<typeof createAgent>> | null>(null);
  const administrator = data.scope.role === 'admin';
  return <section className="panel control-panel" aria-label="执行端管理">
    <div className="panel-head"><h2>执行端管理</h2><span className="muted">每台 Agent 一个执行槽</span></div>
    <div className="table-scroll"><table><thead><tr><th>执行端</th><th>连接状态</th><th>最近心跳</th><th>接单控制</th></tr></thead><tbody>{data.agents.map(agent => <tr key={agent.id}><td><strong>{agent.name}</strong><small>{agent.id}</small></td><td>{agent.status === 'REVOKED' ? '已撤销' : agent.status === 'DRAINING' ? '停止接单' : agent.is_online && agent.status === 'ONLINE' ? '在线' : '等待连接'}</td><td>{agent.heartbeat_at ? new Date(agent.heartbeat_at).toLocaleTimeString('zh-CN') : '尚无心跳'}</td><td>{administrator && agent.status !== 'REVOKED' && <div className="head-actions"><button className="button small subtle" disabled={busy} onClick={() => void act(() => post('agents/' + agent.id + '/control', { action: agent.status === 'DRAINING' ? 'RESUME' : 'DRAIN', reason: '管理员在执行端工作台调整接单状态' }), '接单状态已更新；已提交动作继续核实')}>{agent.status === 'DRAINING' ? '恢复接单' : '停止接单'}</button><button className="button small danger" disabled={busy} onClick={() => void act(() => post('agents/' + agent.id + '/control', { action: 'REVOKE', reason: '管理员撤销此 Agent 配对凭据' }), '凭据已撤销，旧在途动作保留核验状态')}>撤销配对</button></div>}</td></tr>)}</tbody></table></div>
    {administrator && <div className="agent-registration"><details><summary>登记新的 Agent</summary><form onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); void act(async () => { setPairing(await post('agents', { name: form.get('name') })); }, 'Agent 已登记，请保存配对文件'); }}><div className="field"><label htmlFor={inputId}>执行端名称</label><input id={inputId} name="name" maxLength={80} required placeholder="例如：运营电脑 02" /></div><button className="button subtle" disabled={busy}>生成配对文件</button></form></details>{pairing && <div className="pairing-result" role="status"><strong>{pairing.agent.name} 已登记</strong><p>配对文件只在本次操作后提供。安装到目标宿主的 .kff/agent-config.json 前，先停止该宿主旧 Agent 并核对未完成记录。</p><button className="button primary" onClick={() => { const url = URL.createObjectURL(new Blob([JSON.stringify(pairing.configuration, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = 'kff-agent-' + pairing.agent.id + '.json'; link.click(); URL.revokeObjectURL(url); }}>保存配对文件</button><button className="button subtle" onClick={() => setPairing(null)}>已保存，关闭此提示</button></div>}</div>}
  </section>;
}
