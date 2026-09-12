export async function businessRequest<T>(path:string,data?:unknown,signal?:AbortSignal):Promise<T> {
  let response:Response;
  try{response=await fetch('/api/'+path,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),cache:'no-store',signal});}
  catch(failure){if(failure instanceof Error&&failure.name==='AbortError')throw failure;throw new Error(data===undefined?'连接中断，暂时无法读取。':'连接中断，暂未收到保存确认。请保留原内容重试。');}
  const value=await response.json();
  if(!response.ok)throw Object.assign(new Error(value.error?.message??'暂时无法完成，请稍后重试'),{code:value.error?.code,status:response.status});
  return value as T;
}
export const businessTime=(value:string|null|undefined)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'尚未记录';
export const stageNames:Record<string,string>={NEW_INQUIRY:'新咨询',QUALIFYING:'待资格核对',FOLLOWING_UP:'可跟进',IN_PROGRESS:'处理中',QUALIFIED_INQUIRY:'有效询盘',WON:'成交（人工标记）',DELIVERING:'交付中',DELIVERED:'已交付',LOST:'流失',OPTED_OUT:'退出（停止联系）'};
