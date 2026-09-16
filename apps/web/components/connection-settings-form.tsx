'use client';
import {useEffect,useState,type FormEvent} from 'react';
import type {Workspace} from '@kff/core/service';
import type {FacebookConnection} from '../../../packages/contracts/src/lead';
import {resolveReceptionTransport} from './reception-transport';
import {useRequestKey} from './use-request-key';

/**
 * The reception configuration form.
 *
 * The bound environment is controlled state, and the transport options are derived from *that*
 * environment's driver, because the server resolves the account from `account_id` and
 * `environment_id` together and accepts a BROWSER transport only for a matching driver. The previous
 * form offered BROWSER whenever the account had any native environment at all, so selecting a
 * different environment produced a combination the server refuses with SOURCE_NOT_CONFIGURED.
 * Switching environment re-validates the channel and clears a combination that is no longer legal;
 * it never silently keeps an incompatible selection.
 */
export function ConnectionSettingsForm({workspace,account,selected,busy,onSave}:{
  workspace:Workspace;account:{id:string;platform:string;account_type:string;is_synthetic:boolean};selected:FacebookConnection|undefined;busy:boolean;
  onSave:(payload:Record<string,unknown>)=>Promise<void>;
}){
  const requestKey=useRequestKey();
  const environments=workspace.environments.filter(row=>row.account_id===account.id);
  const [environmentId,setEnvironmentId]=useState(selected?.environment_id??environments[0]?.id??'');
  // Keep the controlled environment pointing at a row this account still has. A stale id would
  // submit an environment that is no longer bound to the account.
  useEffect(()=>{if(!environments.some(row=>row.id===environmentId))setEnvironmentId(selected?.environment_id??environments[0]?.id??'');},[environments.map(row=>row.id).join(','),selected?.environment_id]);
  const environment=environments.find(row=>row.id===environmentId);
  const resolved=resolveReceptionTransport(account,environment);
  const realBrowser=account.account_type==='profile'&&!account.is_synthetic;
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!resolved.supported)return;
    const fields=new FormData(event.currentTarget);
    const payload={account_id:account.id,environment_id:environmentId,expected_version:selected?.version??0,transport:fields.get('transport'),state:fields.get('state'),auto_reply:fields.get('auto_reply')==='on',reply_window_hours:Number(fields.get('reply_window_hours')),policy_ref:fields.get('policy_ref')};
    await onSave({...payload,request_id:requestKey.forPayload(payload)});
    requestKey.confirmed();
  }
  return <form className="business-form" aria-label="Facebook 接待配置" onSubmit={event=>void submit(event)}>
    <label>绑定执行环境<select name="environment_id" required value={environmentId} disabled={busy||!environments.length} onChange={event=>setEnvironmentId(event.target.value)}>{environments.map(row=><option value={row.id} key={row.id}>{row.name} · {row.browser_configuration?.driver??'未配置驱动'}</option>)}{!environments.length&&<option value="">此账号还没有环境，请先到环境中心创建</option>}</select></label>
    {!resolved.supported&&<p className="muted" role="note">{resolved.reason}</p>}
    {resolved.supported&&<>
      <label>回复渠道<select name="transport" required defaultValue={resolved.transports.includes((selected?.transport??resolved.default_transport) as 'BROWSER'|'API')&&environmentId===selected?.environment_id?(selected?.transport??resolved.default_transport):resolved.default_transport} key={environmentId}>{resolved.transports.map(transport=><option value={transport} key={transport}>{transport==='BROWSER'?(realBrowser?'AdsPower 人工回复':'本地浏览器验证'):'官方接口'}</option>)}</select></label>
      <label>接待状态<select name="state" defaultValue={selected?.state??'ACTIVE'}><option value="ACTIVE">启用接待</option><option value="PAUSED">暂停接待，继续收件</option></select></label>
      {realBrowser?<><input type="hidden" name="reply_window_hours" value="1"/><input type="hidden" name="policy_ref" value="kff.facebook-browser.explicit-consent.v1"/><p className="muted business-wide">人工处理已收到的私信。每次发送须关联客户明确同意，并单独审核一次回复；保存此配置不会自动发送。</p></>:<><label>私信服务窗口（小时）<input name="reply_window_hours" type="number" min={1} max={24} required defaultValue={selected?.reply_window_hours??24}/></label>
      <label>窗口依据<input name="policy_ref" maxLength={160} minLength={5} required defaultValue={selected?.policy_ref??(account.is_synthetic?'kff.fixture.service-window.v1':'')}/></label>
      <label><input name="auto_reply" type="checkbox" defaultChecked={selected?.auto_reply??false}/> 自动接待新私信</label></>}
    </>}
    <button className="button primary" disabled={busy||!resolved.supported}>保存 Facebook 接待配置</button>
  </form>;
}
