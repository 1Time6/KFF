'use client';
import {useState,type FormEvent} from 'react';
import type {CollectionQuery,CollectionResult} from '@kff/contracts';
import {saveDownload} from './import-workbench';
const labels={message:'正文',author_id:'作者标识',reaction_count:'互动数',comment_count:'评论数',created_time:'来源时间'};
// Mirror of packages/core/src/collection-export.ts:18. The previous client version
// treated everything that was not MANUAL_IMPORT as OWNED_FIXTURE, so it offered and
// pre-checked fields for SOCIAL_DISCOVERY queries that the server always refuses with
// 403 EXPORT_FIELD_FORBIDDEN (its allow-list for that source is empty).
export function exportableFields(snapshot:{source_type:string;fields:string[];export_fields?:string[]}):string[] {
  if (snapshot.source_type === 'MANUAL_IMPORT') return snapshot.export_fields ?? [];
  if (snapshot.source_type === 'OWNED_FIXTURE') return snapshot.fields;
  return [];
}
export function CollectionExport({query,results,expired}:{query:CollectionQuery;results:CollectionResult[];expired:boolean}) {
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const allowed=exportableFields(query.snapshot);
  if (!allowed.length) return <details className="collection-export"><summary>导出查询结果</summary><p className="field-hint">{query.snapshot.source_type==='SOCIAL_DISCOVERY'?'此查询来自主动采集来源，服务端不允许导出采集字段；需要导出时请改用人工导入或本地合成来源。':'当前来源没有允许导出的字段。'}</p></details>;
  async function download(event:FormEvent<HTMLFormElement>) {event.preventDefault();const form=new FormData(event.currentTarget);setBusy(true);setError('');try{
    const input={format:form.get('format'),fields:form.getAll('fields'),...(form.get('selection')==='page'?{result_ids:results.map(row=>row.id)}:{})};
    await saveDownload(await fetch('/api/collections/'+query.id+'/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}),'kff-results.'+input.format);
  }catch(failure){setError(failure instanceof Error?failure.message:'导出未完成');}finally{setBusy(false);}}
  return <details className="collection-export"><summary>导出查询结果</summary>{error&&<p className="alert error" role="alert">{error}</p>}<form onSubmit={event=>void download(event)}><fieldset disabled={busy||expired}><fieldset className="collection-field-choice"><legend>选择来源允许导出的字段</legend>{query.snapshot.fields.filter(field=>allowed.includes(field)).map(field=><label key={field}><input type="checkbox" name="fields" value={field} defaultChecked/>{labels[field]}</label>)}</fieldset><div className="form-grid"><label className="field">导出格式<select name="format" aria-label="导出格式"><option value="xlsx">Excel（文本 ID）</option><option value="csv">CSV（UTF-8 BOM / KFF 文本转义）</option></select></label><label className="field">导出对象范围<select name="selection" aria-label="导出对象范围"><option value="all">此查询全部有效结果</option><option value="page" disabled={!results.length}>当前页 {results.length} 个对象</option></select></label></div><p className="field-hint">导出保留来源、观察版本与字段状态。CSV 文本会加单引号保护；回导时选择 KFF 文本转义格式。下载的副本由下载者管理。</p><button className="button subtle">下载所选结果</button></fieldset></form></details>;
}
