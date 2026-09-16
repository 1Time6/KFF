import type {Task} from '@kff/contracts';

export function CommentOutreachSummary({task}:{task:Task}) {
  const context=task.snapshot.outreach?.browser;
  if(!context)return null;
  return <div className="content-preview" aria-label="公开评论回复范围">
    <label>将回复这条公开评论</label>
    <p>{context.source_body}</p>
    <p><a href={context.comment_url} target="_blank" rel="noreferrer">核对原评论</a> · 作者 ID：{task.snapshot.outreach!.author_id}</p>
    <p>来源显示时间：{context.displayed_time} · 动作到期：{new Date(context.expires_at).toLocaleString('zh-CN')}</p>
    <p>批准依据：{task.snapshot.outreach!.authorization_basis}</p>
    <p>此动作只在原评论下公开回复一次。对方主动私信后，才进入对应会话接待。</p>
  </div>;
}
