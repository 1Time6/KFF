import {AppError,requireCondition} from '@kff/core';

export async function readBoundedJson(response:Response) {
  if(!response.ok)throw new AppError(response.status===429?'SOURCE_RATE_LIMITED':response.status===401||response.status===403?'SOURCE_AUTH_REQUIRED':'REMOTE_ERROR','采集接口暂不能提供结果',502);
  const reader=response.body?.getReader();requireCondition(reader,'REMOTE_ERROR','采集响应为空',502);
  const chunks:Uint8Array[]=[];let bytes=0;
  while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.length;if(bytes>1024*1024){await reader.cancel();throw new AppError('COLLECTION_LIMIT_EXCEEDED','采集响应超过 1 MiB',502);}chunks.push(value);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;}catch{throw new AppError('COLLECTION_INVALID_PAGE','采集响应不是 JSON',502);}
}
