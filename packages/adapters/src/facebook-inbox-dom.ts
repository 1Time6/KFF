/** Rendered message fields only. No React internals, storage, or decoded message-ID timestamps. */
export function inspectFacebookInboxDom() {
  // Object methods remain self-contained when TSX serializes this function for page.evaluate.
  const helpers = {visible(node: Element) {
    const rect=node.getBoundingClientRect(), style=getComputedStyle(node);
    return rect.width>0 && rect.height>0 && style.visibility!=='hidden' && style.display!=='none';
  },groupSender(node:Element) {
    // Messenger may flatten several turns into one sibling container. Resolve
    // only the contiguous run of one explicit actor, with one final avatar.
    for(let parent=node.parentElement,depth=0;parent&&depth<10&&!parent.matches('[role="log"]');parent=parent.parentElement,depth++) {
      const members=[...parent.querySelectorAll('[data-message-id]')];
      if(members.length<2)continue;
      if(parent.getAttribute('role')!==null||parent.parentElement?.getAttribute('role')!=='none'||members.length>50||members.some(member=>!helpers.visible(member)))return null;
      const branches=[...parent.children].map(child=>child.querySelectorAll('[data-message-id]').length);
      if(branches.filter(count=>count===1).length!==members.length||branches.some(count=>count>1))return null;
      const actors=members.map(member=>{
        const bodies=[...member.querySelectorAll('div[dir="auto"]')].filter(helpers.visible),label=member.getAttribute('aria-label')??'',body=bodies.length===1?(bodies[0].textContent??'').trim():'';
        const split=label.indexOf('，');
        return body&&split>0&&label.endsWith('：'+body)?label.slice(split+1,-('：'+body).length):null;
      });
      const index=members.indexOf(node),actor=actors[index];
      if(index<0||!actor||/^(你|You)$/.test(actor)||actors.some(value=>!value))return null;
      let first=index,last=index;
      while(first>0&&actors[first-1]===actor)first--;
      while(last+1<members.length&&actors[last+1]===actor)last++;
      const run=members.slice(first,last+1),anchors=run.filter(member=>member.querySelectorAll('[role="button"][aria-haspopup="dialog"] img').length>0);
      if(run.length<2||run.length>20||anchors.length!==1||anchors[0]!==run.at(-1)||anchors[0].querySelectorAll('[role="button"][aria-haspopup="dialog"] img').length!==1)return null;
      return anchors[0];
    }
    return null;
  }};
  const logs=[...document.querySelectorAll('[role="log"]')].filter(helpers.visible);
  if (logs.length!==1) return {rows:[],invalid:1};
  let invalid=0;
  const rows=[];
  for (const article of logs[0].querySelectorAll('[role="article"]')) {
    if (!helpers.visible(article)) continue;
    const nodes=[...article.querySelectorAll('[data-message-id]')].filter(helpers.visible);
    if (nodes.length!==1) {invalid++;continue;}
    const node=nodes[0], id=node.getAttribute('data-message-id')??'', label=node.getAttribute('aria-label')??'';
    const bodies=[...node.querySelectorAll('div[dir="auto"]')].filter(helpers.visible);
    let avatars=[...node.querySelectorAll('[role="button"][aria-haspopup="dialog"] img')];
    let body=bodies.length===1?(bodies[0].textContent??'').trim():'';
    // An explicit self label distinguishes outgoing text; message ID prefixes do not identify senders.
    const self=/^[^，]+，(?:你|You)(?:：|$)/.test(label);
    const senderAnchor=!self&&!avatars.length&&bodies.length===1?helpers.groupSender(node):null;
    if(senderAnchor)avatars=[...senderAnchor.querySelectorAll('[role="button"][aria-haspopup="dialog"] img')];
    // Messenger renders a small recipient read marker outside an outgoing text body.
    const readMarkers=self?[...node.querySelectorAll('span > img[width="14"][height="14"]')].filter(element=>
      /^.+于(?:\d{4}年\d{1,2}月\d{1,2}日\s+)?\d{1,2}:\d{2}已读$/.test(element.getAttribute('alt')??'') &&
      !bodies.some(body=>body.contains(element)) && !element.closest('a,button,[role="button"],[role="link"]')):[];
    const media=[...node.querySelectorAll('img,video,audio,canvas,svg')].filter(element=>!element.closest('[aria-hidden="true"]')&&!readMarkers.includes(element));
    const split=label.indexOf('，');
    // A photo has no text body. Keep only its existence, never image contents or a download URL.
    // The original direction/name label and each incoming avatar still identify its sender.
    const actor=self?label.slice(split+1):avatars[0]?.getAttribute('alt');
    const image=bodies.length===0&&media.length===1&&media[0].tagName==='IMG'&&Boolean(media[0].closest('a,[role="link"]'))&&
      (self?/^(你|You)$/.test(actor??''):Boolean(actor)&&label.slice(split+1)===actor);
    if(image)body='[图片附件，内容未读取]';
    if (!/^[A-Za-z0-9_:+.@-]{1,160}$/.test(id) || !body || body.length>5000 || avatars.length!==(self?0:1) || split<1 || (!image&&(media.length>0||!label.endsWith('：'+body)))) {invalid++;continue;}
    rows.push({message_id:id,body,direction:self?'OUTBOUND' as const:'INBOUND' as const,display_name:self?null:avatars[0].getAttribute('alt')??'',displayed_time:label.slice(0,split),has_attachment:image,...(senderAnchor?{sender_anchor_message_id:senderAnchor.getAttribute('data-message-id')!}:{})});
  }
  return {rows,invalid};
}

/** A deferred render may add rows, but must preserve every observed message and its order. */
export function isFacebookInboxExpansion(before: ReturnType<typeof inspectFacebookInboxDom>, after: ReturnType<typeof inspectFacebookInboxDom>, limit: number) {
  if(after.invalid || after.rows.length<=before.rows.length || after.rows.length>limit || new Set(after.rows.map(row=>row.message_id)).size!==after.rows.length)return false;
  let previous=-1;
  return before.rows.every(row=>{
    const index=after.rows.findIndex(next=>next.message_id===row.message_id);
    if(index<=previous || JSON.stringify(after.rows[index])!==JSON.stringify(row))return false;
    previous=index;return true;
  });
}
