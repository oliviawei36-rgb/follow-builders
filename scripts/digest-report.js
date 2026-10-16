export const MODULES = ['X','AI播客','AI 公司博客及产品更新','法律 AI 产品','律所与法务AI实践','中国大模型厂商资讯'];
export function moduleFor(name, config) {
  if (config.x_accounts.some(source=>source.name===name)) return 'X';
  if (config.podcasts.some(source=>source.name===name)) return 'AI播客';
  return config.blogs.find(source=>source.name===name)?.module || 'AI 公司博客及产品更新';
}
export function buildReport({ config, records, excluded = [] }) {
  const sourceKey = module => module==='X' ? 'x' : module==='AI播客' ? 'podcasts' : 'blogs';
  const expected=[...config.x_accounts,...config.podcasts,...config.blogs];
  const sources=expected.map(source=>{
    const module=source.module || moduleFor(source.name,config);
    if (excluded.includes(sourceKey(module))) return {name:source.name,module,status:'not_checked',reason:'Already delivered or not requested in this run'};
    return {name:source.name,module,...(records.find(record=>record.name===source.name) || {status:'unverified',reason:'The shared feed did not supply a per-source fetch result'})};
  });
  const failures=sources.filter(source=>['error','partial'].includes(source.status));
  return { checkedAt:new Date().toISOString(), moduleOrder:MODULES, sources, failures };
}
