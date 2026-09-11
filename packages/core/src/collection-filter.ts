import type {CollectionResult,CollectionQuery} from '@kff/contracts';
import type {PoolClient} from 'pg';
import {collectionFilterSchema,type CollectionFilter} from '../../contracts/src/target-selection';
import {digest,requireCondition} from './index';

export function matchesCollectionFilter(row:CollectionResult,input:CollectionFilter) {
  const filter=collectionFilterSchema.parse(input);
  if(filter.id_prefix&&!row.source_object_id.startsWith(filter.id_prefix))return false;
  if(filter.message_contains){const field=row.fields.message;if(field?.kind!=='VALUE'||typeof field.value!=='string'||!field.value.toLocaleLowerCase('en-US').includes(filter.message_contains.toLocaleLowerCase('en-US')))return false;}
  if(filter.author_id){const field=row.fields.author_id;if(field?.kind!=='VALUE'||field.value!==filter.author_id)return false;}
  if(filter.min_reactions!==null){const field=row.fields.reaction_count;if(field?.kind!=='VALUE'||typeof field.value!=='number'||field.value<filter.min_reactions)return false;}
  for(const [key,kind] of Object.entries(filter.field_states))if(row.fields[key as keyof typeof row.fields]?.kind!==kind)return false;
  return true;
}
export async function filteredCollectionRows(client:PoolClient,query:CollectionQuery,runId:string,input:CollectionFilter) {
  const filter=collectionFilterSchema.parse(input);const needed=[...(filter.message_contains?['message']:[]),...(filter.author_id?['author_id']:[]),...(filter.min_reactions!==null?['reaction_count']:[]),...Object.keys(filter.field_states)];
  requireCondition(needed.every(field=>query.snapshot.fields.includes(field as keyof CollectionResult['fields'])),'FILTER_FIELD_UNAVAILABLE','筛选字段未包含在此查询的允许字段中');
  const rows=(await client.query<CollectionResult>('SELECT r.id,r.observation_id,r.result_order::text,o.source_object_id,o.observed_at,o.source_url,o.fields,o.evidence_hash,o.allowed_purposes,o.expires_at,o.object_version FROM kff.collection_results r JOIN kff.collection_observations o ON o.id=r.observation_id WHERE r.run_id=$1 AND o.expires_at>clock_timestamp() ORDER BY r.result_order LIMIT 1001',[runId])).rows;
  requireCondition(rows.length<=1000,'COLLECTION_LIMIT_EXCEEDED','此查询超出当前结果范围上限',409);return rows.filter(row=>matchesCollectionFilter(row,filter));
}
export function collectionResultPage(query:CollectionQuery,rows:CollectionResult[],filter:CollectionFilter,after:string,limit:number) {
  const candidates=rows.filter(row=>BigInt(row.result_order)>BigInt(after));const results=candidates.slice(0,limit);
  return {results,next_cursor:candidates.length>limit?results.at(-1)!.result_order:null,filtered_count:rows.length,page_after:after,
    page_hash:digest({query_id:query.id,query_snapshot_hash:query.snapshot_hash,filter,after,limit,observations:results.map(row=>({result_id:row.id,observation_id:row.observation_id}))})};
}
