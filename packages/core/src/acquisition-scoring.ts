export function scoreAcquisitionText(text:string,config:{keywords:string[];exclusions:string[]},contextKeywords:string[]=[]){
  // Narrow, evidenced alias: normalize 查8字 without changing the stored source text.
  const normalize=(value:string)=>value.normalize('NFKC').toLocaleLowerCase().replace(/8字/gu,'八字');
  const normalized=normalize(text);
  const matched=[...new Set(config.keywords.filter(k=>normalized.includes(normalize(k))||contextKeywords.includes(k)))];
  const excluded=config.exclusions.some(k=>normalized.includes(normalize(k)));
  // A customer may quote an advertisement when asking a question. Quoted sales copy is
  // neither their own offer nor evidence of their intent; keep it in the original observation.
  const ownText=normalized.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"/gu,' ');
  const sellerCall=/(?:^|[.!?。！？;；\n])\s*(?:(?:可以|欢迎|歡迎|立即|现在|現在|马上|馬上|请|請)\s*)?(?:购买|購買|订购|訂購|报名|報名|选购|選購)\s*(?:我(?:的|嘅)|我们(?:的)?|我們(?:的)?|本店|本公司|本工作室)|(?:^|[.!?;\n])\s*(?:please\s+)?(?:buy|purchase|enroll(?:\s+in)?|enrol(?:\s+in)?|sign\s+up\s+for)\s+(?:my|our)\b/u.test(ownText);
  const sellerOffer=/(?:^|[.!?。！？;；\n])\s*(?:(?:我们|我們|本店|本公司|本工作室)(?:提供|出售|销售|銷售)|(?:we\s+(?:offer|sell|provide)|i\s+(?:offer|sell|provide))\b)/u.test(ownText);
  const sellerContact=/联系我们|聯繫我們|聯絡我們|联系我|聯繫我|私信(?:我|我们)|私訊(?:我|我們)|欢迎(?:私信|咨询|预约)|歡迎(?:私訊|諮詢|預約)|\b(?:contact|message|dm)\s+(?:me|us)\b|\b(?:book|enroll|enrol)\s+now\b/u.test(ownText);
  // The observed paid-reading offer states a fee and invites contact. Fee questions
  // and quoted offers alone remain customer inquiries.
  const paidBaziOffer=/(?:^|[（(，,。.!！;；\n])\s*批\s*八字\s*需(?:要)?\s*卦金(?=\s*[!！。.)）])/u.test(ownText)&&sellerContact;
  // A branded offer needs a seller contact invitation; service terms need a sample/
  // booking invitation. Neither a brand mention nor a customer FAQ alone is an offer.
  const brandedOffer=/(?:^|[.!?;\n])\s*[a-z][a-z0-9&'-]{1,60}\s+(?:offers|sells|provides)\s+(?:private|personal|professional|paid)\b/u.test(ownText);
  const serviceTerms=/(?:^|[.!?;\n])\s*(?:this|our)\s+service\s+(?:covers|includes|does\s+not\s+answer)\b/u.test(ownText);
  const sampleInvitation=/(?:^|[.!?;\n])\s*(?:before\s+deciding,\s*)?(?:view|explore)\s+(?:the|our)\s+(?:illustrative\s+)?sample\b[^.!?\n]{0,160}\b(?:booking|service)\s+details\b/u.test(ownText);
  const serviceEnquiry=/\bfor\s+(?:enquiry|enquiries|inquiry|inquiries)\s+on\b[\s\S]{0,450}\bservices\b/u.test(ownText)&&/\b(?:drop|send)\s+me\s+(?:a\s+)?whatsapp\s+(?:text|message)\b/u.test(ownText);
  const promotion=sellerCall||(sellerOffer||brandedOffer)&&sellerContact||serviceTerms&&sampleInvitation||serviceEnquiry||paidBaziOffer;
  const intent=/\b(price|buy|cost|need|help|looking for|recommend)\b|价格|價格|购买|購買|想买|想買|需要|求助|推荐|推薦/u.test(ownText);
  return {matched,score:excluded||!matched.length||promotion?0:Math.min(100,40+matched.length*10+(intent?25:0)),reason:excluded?'排除词命中':!matched.length?'未命中关键词':promotion?'命中商家自推语句；保留原始观察，不进入新客户候选。规则判断，可人工核对。':`关键词匹配 ${matched.length} 项${intent?'；含咨询相关词':''}。规则评分，不代表购买概率。`};
}
