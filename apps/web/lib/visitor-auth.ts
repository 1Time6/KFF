import {requireCondition} from '@kff/core';

export function visitorToken(request:Request,channelId:string) {
  const name='kff-visitor-'+channelId;
  const values=(request.headers.get('cookie')??'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'='));
  requireCondition(values.length<=1,'VISITOR_SESSION_REQUIRED','访客会话存在冲突，请清除本入口会话后重新开始',401);
  return values[0]?.slice(name.length+1);
}
export function visitorCookie(channelId:string,token:string,expiresAt:string|null) {
  const secure=new URL(process.env.KFF_APP_ORIGIN??'http://127.0.0.1:3000').protocol==='https:';
  return 'kff-visitor-'+channelId+'='+token+'; Path=/api/public/chat/'+channelId+'; HttpOnly; SameSite=Strict'+(secure?'; Secure':'')+(expiresAt?'; Expires='+new Date(expiresAt).toUTCString():'; Max-Age=0');
}
