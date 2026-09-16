/** Only rendered links and labels in the selected All chats list. No snippets or internal state. */
export function inspectFacebookInboxDirectoryDom() {
  const h={visible(n:Element){return !n.closest('[hidden],[aria-hidden="true"]')&&n.getClientRects().length>0&&getComputedStyle(n).visibility!=='hidden'&&getComputedStyle(n).display!=='none';}};
  const lists=[...document.querySelectorAll('nav[aria-label="对话列表"],[role="navigation"][aria-label="对话列表"]')].filter(h.visible);
  const rows:{thread_id:string;display_name:string;source_url:string}[]=[], seen=new Map<string,string>(), ambiguous=new Set<string>();
  let invalid=0;
  if(lists.length!==1)return {rows,invalid:1,ready:false,empty:false};
  const list=lists[0],tabs=[...list.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]')].filter(h.visible),grids=[...list.querySelectorAll('[role="grid"][aria-label="聊天"]')].filter(h.visible);
  if(tabs.length!==1||tabs[0].innerText.trim()!=='全部'||grids.length!==1)return {rows,invalid:1,ready:false,empty:false};
  const grid=grids[0],items=[...grid.querySelectorAll('[role="row"]')].filter(h.visible);
  for(const item of items){
    const links=[...item.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(h.visible),menus=[...item.querySelectorAll('[role="button"][aria-label],button[aria-label]')].filter(n=>h.visible(n)&&/^.+的更多选项$/.test(n.getAttribute('aria-label')??''));
    if(links.length!==1||menus.length!==1){invalid++;continue;}
    const display_name=menus[0].getAttribute('aria-label')!.slice(0,-'的更多选项'.length).trim();
    try{
      const u=new URL(links[0].href),match=/^\/messages\/e2ee\/t\/([0-9]{1,128})\/$/.exec(u.pathname);
      if(u.origin!=='https://www.facebook.com'||u.username||u.password||u.search||u.hash||!match||!display_name||display_name.length>80||!links[0].innerText.trim().startsWith(display_name)){invalid++;continue;}
      const thread_id=match[1];if(seen.has(thread_id)){if(seen.get(thread_id)!==display_name){ambiguous.add(thread_id);invalid++;}continue;}
      seen.set(thread_id,display_name);rows.push({thread_id,display_name,source_url:u.href});
    }catch{invalid++;}
  }
  const loading=[...grid.querySelectorAll('[role="status"],[role="progressbar"]')].some(h.visible);
  const empty=!items.length&&!loading&&/^没有聊天\s*你的聊天会显示在这里。$/.test((grid as HTMLElement).innerText.trim());
  const verified=rows.filter(row=>!ambiguous.has(row.thread_id));
  return {rows:verified,invalid,ready:!loading&&(verified.length>0||empty),empty};
}

/**
 * The thread composer is located from its own semantic label, never from a blind wait
 * for one exact string. `allow_other_name` says the directory row still shows the
 * placeholder, so the header supplied the only established name and the composer may
 * legitimately carry it; without that, only the resolved peer name qualifies.
 */
export function inspectFacebookInboxComposerDom(expected:{display_name:string;allow_other_name:boolean;operating_identity_id:string;peer_name?:string}) {
  // TSX injects __name into arrow functions passed as callbacks, which breaks page
  // serialization. Every helper below is an object method or a direct local call.
  const h={
    visible(node:Element){
      const rect=node.getBoundingClientRect(),style=getComputedStyle(node);
      return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.display!=='none';
    },
    // The observed placeholder is never a person: a bare or placeholder-derived label
    // must not become chat evidence on its own.
    placeholder(value:string){return value.includes('Facebook 用户');},
    // EXACT_NAME means the label names the resolved peer. NAMED_PREFIX means the label names
    // somebody through a supported prefix; whether that person is the verified peer is decided
    // by `names`, never by the prefix alone. BARE_PREFIX ("发消息给", "Message") names nobody.
    kind(value:string):'EXACT_NAME'|'NAMED_PREFIX'|'BARE_PREFIX'|'OTHER' {
      const compact=value.replace(/\s+/g,'').toLowerCase(),peer=expected.display_name.replace(/\s+/g,'').toLowerCase();
      if(peer&&compact==='发消息给'+peer)return 'EXACT_NAME';
      const bounds=['发消息给','发信息给','sendmessageto','message'];
      for(const bound of bounds)if(compact.startsWith(bound))return compact.length>bound.length?'NAMED_PREFIX':'BARE_PREFIX';
      return 'OTHER';
    },
    // The name a prefix-based label points at, and whether it is the verified peer. A label may
    // only ever name the peer this window already verified: accepting a bare prefix, the
    // placeholder or a label naming somebody else is what the two stages used to disagree about.
    names(value:string,kind:string){
      if(kind==='EXACT_NAME')return true;
      if(kind!=='NAMED_PREFIX')return false;
      const target=(expected.peer_name??expected.display_name).replace(/\s+/g,'').toLowerCase(),compact=value.replace(/\s+/g,'').toLowerCase();
      return ['发消息给','发信息给','sendmessageto','message'].some(bound=>compact.startsWith(bound)&&compact.slice(bound.length)===target);
    },
    reachable(node:Element){return node.getAttribute('aria-disabled')!=='true'&&!(node as HTMLButtonElement).disabled;},
  };
  const mains=[...document.querySelectorAll('main,[role="main"]')].filter(h.visible);
  const inputs=[] as {value:string;kind:'EXACT_NAME'|'NAMED_PREFIX'|'BARE_PREFIX'|'OTHER';reachable:boolean;hit_target:boolean;role:'textbox'|'combobox'|'none';contenteditable:boolean}[];
  for(const main of mains){
    for(const node of main.querySelectorAll<HTMLElement>('[contenteditable="true"],[contenteditable=""],[role="textbox"],[role="combobox"]')){
      if(!h.visible(node)||node.closest('[role="log"]'))continue;
      const rect=node.getBoundingClientRect(),value=node.getAttribute('aria-label')??node.getAttribute('placeholder')??node.getAttribute('data-placeholder')??'';
      inputs.push({value,kind:h.kind(value),reachable:h.reachable(node),hit_target:node.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2)),
        role:node.getAttribute('role')==='combobox'?'combobox':node.getAttribute('role')==='textbox'?'textbox':'none',
        contenteditable:node.getAttribute('contenteditable')==='true'||node.getAttribute('contenteditable')===''});
    }
  }
  // A label that names the verified peer through a supported prefix is the preferred evidence. A
  // label that names somebody else qualifies only while the directory still shows the placeholder,
  // because then the header is the only name source and the incoming avatars are rechecked against
  // this label afterwards. A bare prefix, the placeholder itself or the operating account's
  // identity never qualifies.
  const matched=inputs.filter(input=>(input.kind==='EXACT_NAME'||(expected.allow_other_name&&input.kind==='NAMED_PREFIX'&&h.names(input.value,input.kind)))&&!h.placeholder(input.value)&&!input.value.includes(expected.operating_identity_id));
  // The observation must name the state that was actually seen. Only a real zero-candidate region
  // is ABSENT; more than one candidate is its own ambiguity, because a single candidate plus a
  // conflicting one, or two that carry the same accepted label, is not the same fact as none.
  // Reporting both as ABSENT let a multi-input page satisfy the zero-input read-only condition.
  // Whenever there is exactly one candidate, its own observation is kept instead of a summary.
  const empty={label_kind:'ABSENT' as const,label_length:0,placeholder:false,reachable:false,hit_target:false,role:'none' as const,contenteditable:false};
  const single=inputs.length===1?{label_kind:inputs[0].kind,label_length:inputs[0].value.length,placeholder:!inputs[0].value||h.placeholder(inputs[0].value),reachable:inputs[0].reachable,hit_target:inputs[0].hit_target,role:inputs[0].role,contenteditable:inputs[0].contenteditable}:null;
  const ambiguous=inputs.length>1?{label_kind:'AMBIGUOUS' as const,label_length:0,placeholder:false,reachable:false,hit_target:false,role:'none' as const,contenteditable:false}:null;
  const surface=single??ambiguous??empty;
  return {composer:inputs.length===1&&matched.length===1?matched[0]:null,absent:!inputs.length,candidate_count:inputs.length,surface};
}

/** A numeric profile link in the conversation header is a candidate, then every incoming avatar is rechecked. */
export function inspectFacebookInboxHeaderDom(expected:{thread_id:string;display_name:string}) {
  const url=new URL(location.href);
  if(url.origin!=='https://www.facebook.com'||url.pathname.replace(/\/$/,'')!=='/messages/e2ee/t/'+expected.thread_id||url.search||url.hash)return null;
  const h={visible(n:Element){return !n.closest('[hidden],[aria-hidden="true"]')&&n.getClientRects().length>0&&getComputedStyle(n).visibility!=='hidden';}};
  const mains=[...document.querySelectorAll('main,[role="main"]')].filter(h.visible);if(mains.length!==1)return null;
  const links=[...mains[0].querySelectorAll<HTMLAnchorElement>('a[href]')].filter(a=>h.visible(a)&&!a.closest('[role="log"]')&&a.querySelector('h3,[role="heading"][aria-level="3"]'));
  if(links.length!==1)return null;
  const heading=links[0].querySelector<HTMLElement>('h3,[role="heading"][aria-level="3"]'),name=heading?.innerText.trim();
  // The observed directory can say “Facebook 用户” until the same thread hydrates.
  // Resolve that placeholder from a unique numeric header, never from a name alone;
  // the caller still checks every incoming avatar against this exact profile ID.
  const nameMatches=name&&name.length<=80&&name!=='Facebook 用户'&&(name===expected.display_name||expected.display_name==='Facebook 用户');
  try{const u=new URL(links[0].href),id=/^\/([0-9]{1,128})\/$/.exec(u.pathname);if(u.origin!=='https://www.facebook.com'||u.username||u.password||u.search||u.hash||!id||!nameMatches)return null;return {thread_id:expected.thread_id,peer_id:id[1],display_name:name!};}catch{return null;}
}
