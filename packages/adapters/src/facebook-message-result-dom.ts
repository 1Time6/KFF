/** A visible outgoing bubble is insufficient until its UI also confirms a sent/delivered/read state. */
export function inspectFacebookMessageResult(input:{before_ids:string[];body:string}) {
  const helpers={visible(node:Element){const r=node.getBoundingClientRect(),s=getComputedStyle(node);return !node.closest('[hidden],[aria-hidden="true"]')&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}};
  const logs=[...document.querySelectorAll('[role="log"]')].filter(helpers.visible);
  if(logs.length!==1)return {matches:[],invalid:true};
  const matches=[];
  for(const article of logs[0].querySelectorAll('[role="article"]')){
    if(!helpers.visible(article))continue;
    const nodes=[...article.querySelectorAll('[data-message-id]')].filter(helpers.visible);
    if(nodes.length!==1)return {matches:[],invalid:true};
    const node=nodes[0],id=node.getAttribute('data-message-id')??'';
    if(input.before_ids.includes(id))continue;
    const bodies=[...node.querySelectorAll('div[dir="auto"]')].filter(helpers.visible);
    const label=node.getAttribute('aria-label')??'';
    // Never infer sender from the numeric prefix of a message ID.
    const self=/^[^，]+，(?:你|You)：/.test(label)&&label.endsWith('：'+input.body);
    // The verified Chinese UI renders "5分钟前发送" as plain presentation text, without aria-label.
    // Exclude message content, link previews and action menus so quoted status words cannot confirm a send.
    const statusNodes=[...article.querySelectorAll('[aria-label],[role="status"],span')].filter(el=>helpers.visible(el)&&!bodies.some(body=>body.contains(el))&&!el.closest('a,button,[role="button"],[role="link"]'));
    const statuses=statusNodes.map(el=>el.getAttribute('aria-label')??(el.children.length===0||el.getAttribute('role')==='status'?el.textContent??'':'')).map(text=>text.trim());
    const delivered=statuses.some(text=>/^(?:已发送|已送达|已读|Sent|Delivered|Seen)(?:$|[：:，,\s])/.test(text)||/^(?:刚刚发送|\d+\s*(?:秒|分钟|小时|天)前发送)$/.test(text));
    if(bodies.length===1&&(bodies[0].textContent??'').trim()===input.body&&self&&delivered&&!node.querySelector('[aria-haspopup="dialog"] img')&&/^[A-Za-z0-9_:+.@-]{1,160}$/.test(id))matches.push({message_id:id});
  }
  return {matches,invalid:false};
}
