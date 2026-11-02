/* Agent App Manager UI demo. Data and all actions are mocked, no backend calls. */
const apps = [
  {id:1,name:'Symphony',slug:'symphony',runtime:'Codex',status:'running',icon:'S',tone:'purple',uptime:'4d 12h',desc:'Autonomous development orchestration'},
  {id:2,name:'Scenario Test',slug:'scenario-test',runtime:'Claude Code',status:'running',icon:'T',tone:'blue',uptime:'2d 8h',desc:'Agent-powered API scenario testing'},
  {id:3,name:'Agent Skills',slug:'agent-skills',runtime:'OpenCode',status:'running',icon:'A',tone:'cyan',uptime:'18h 24m',desc:'Reusable engineering skill runner'},
  {id:4,name:'LifeOS',slug:'lifeos',runtime:'Codex',status:'stopped',icon:'L',tone:'pink',uptime:'—',desc:'Personal knowledge workspace'},
  {id:5,name:'Voice Audit',slug:'eva-voice-audit',runtime:'Claude Code',status:'running',icon:'V',tone:'gold',uptime:'6h 15m',desc:'Local speaker analysis workspace'},
  {id:6,name:'Neon Racing',slug:'neon-city-racing',runtime:'OpenCode',status:'stopped',icon:'N',tone:'blue',uptime:'—',desc:'Phaser game development app'}
];
const runtimes = [
  {name:'Codex',initial:'Cx',caption:'OpenAI coding agent runtime',apps:2},
  {name:'Claude Code',initial:'Cl',caption:'Anthropic CLI coding agent',apps:2},
  {name:'OpenCode',initial:'Oc',caption:'Open-source coding agent runtime',apps:2}
];
const events = [
  ['play','Symphony started successfully','Application started · Codex','2 min ago'],
  ['check','Scenario Test finished execution','Task #481 · Completed','18 min ago'],
  ['terminal','Agent Skills connected to runtime','OpenCode · Healthy','52 min ago'],
  ['stop','LifeOS was stopped','Application stopped · Codex','3 hours ago'],
  ['play','Voice Audit restarted','Runtime recovered · Claude Code','Yesterday']
];
const $ = (s) => document.querySelector(s);
const icon = (name,cls='') => `<svg class="ic ${cls}"><use href="#i-${name}"/></svg>`;
const safe = (t) => String(t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function status(a){return `<span class="status ${a.status}">${a.status==='running'?'Running':'Stopped'}</span>`}
function appIcon(a){return `<span class="app-icon ${safe(a.tone)}">${safe(a.icon)}</span>`}
function metric(iconName,title,num,foot,signal=false){return `<div class="metric"><div class="metric-head"><span>${title}</span><span class="metric-icon">${icon(iconName)}</span></div><div class="metric-number">${num}</div><div class="metric-foot">${signal?'<span class="signal">● </span>':''}${foot}</div></div>`}
function renderMetrics(){let active=apps.filter(a=>a.status==='running').length;$('#overviewMetrics').innerHTML=metric('box','Total applications',apps.length,'Managed in this workspace')+metric('play','Running now',active,'Healthy processes',true)+metric('cpu','Agent runtimes',runtimes.length,'All runtimes connected',true)+metric('activity','Executions today','128','Illustrative activity');$('#navAppCount').textContent=String(apps.length).padStart(2,'0')}
function renderFeatured(){const featured=apps.slice(0,4);$('#featuredApps').innerHTML=featured.map(a=>`<div class="featured-app">${appIcon(a)}<div class="featured-detail"><div class="featured-name">${safe(a.name)}</div><div class="featured-meta">${safe(a.runtime)} · ${safe(a.slug)}</div></div><div class="featured-tail">${status(a)}<button class="mini-arrow" aria-label="View ${safe(a.name)}" data-go="applications">${icon('arrow','tiny')}</button></div></div>`).join('')}
function renderEvents(){let out=events.slice(0,4).map(e=>`<div class="event"><span class="event-symbol">${icon(e[0])}</span><div class="event-text"><b>${safe(e[1])}</b><span>${safe(e[2])}</span></div><span class="event-time">${safe(e[3])}</span></div>`).join('');$('#recentEvents').innerHTML=out;$('#activityTimeline').innerHTML=events.concat(events.slice(0,3)).map(e=>`<div class="event"><span class="event-symbol">${icon(e[0])}</span><div class="event-text"><b>${safe(e[1])}</b><span>${safe(e[2])}</span></div><span class="event-time">${safe(e[3])}</span></div>`).join('')}
function renderRuntime(){const summary = runtimes.map(r=>`<div class="runtime-mini"><span class="runtime-symbol">${safe(r.initial)}</span><div class="runtime-text"><b>${safe(r.name)}</b><small>${r.apps} applications</small></div><span class="connector">● Connected</span></div>`).join('');$('#runtimeSummary').innerHTML=summary;$('#runtimeCards').innerHTML=runtimes.map(r=>`<article class="runtime-card"><div class="runtime-card-icon">${safe(r.initial)}</div><h2>${safe(r.name)}</h2><p>${safe(r.caption)} — manage the applications connected to this runtime.</p><div class="runtime-card-bottom"><span>${r.apps} managed apps</span><span class="connector">● Connected</span></div></article>`).join('')}
function renderTable(){let q=$('#appSearch').value.trim().toLowerCase(),filter=$('#statusFilter').value;let filtered=apps.filter(a=>(a.name.toLowerCase().includes(q)||a.slug.includes(q)||a.runtime.toLowerCase().includes(q))&&(filter==='all'||a.status===filter));$('#appListCount').textContent=`${filtered.length} apps`;$('#applicationRows').innerHTML=filtered.length?filtered.map(a=>`<div class="app-table-row"><div class="row-icon-group">${appIcon(a)}<div><b>${safe(a.name)}</b><small>${safe(a.slug)}</small></div></div><div class="cell-muted">${safe(a.runtime)}</div><div>${status(a)}</div><div class="cell-muted">${safe(a.uptime)}</div><div class="row-actions"><button class="tiny-btn" data-toggle="${a.id}">${icon(a.status==='running'?'stop':'play')}${a.status==='running'?'Stop':'Start'}</button></div></div>`).join(''):'<div class="empty-state">No applications match this filter.</div>'}
function renderAll(){renderMetrics();renderFeatured();renderEvents();renderRuntime();renderTable()}
function go(page){document.querySelectorAll('.page').forEach(el=>el.classList.toggle('active',el.id==='page-'+page));document.querySelectorAll('.nav-link').forEach(el=>el.classList.toggle('active',el.dataset.page===page));$('#breadcrumb').textContent=({overview:'Overview',applications:'Applications',runtimes:'Runtimes',activity:'Activity',settings:'Settings'})[page];$('#sidebar').classList.remove('open');window.scrollTo({top:0,behavior:'instant'})}
let toastTimer;function toast(message){const el=$('#toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),2600)}
function setTheme(theme){document.documentElement.dataset.theme=theme;$('#themeIcon').innerHTML=`<use href="#i-${theme==='dark'?'sun':'moon'}"/>`;document.querySelectorAll('[data-theme-select]').forEach(b=>b.classList.toggle('selected',b.dataset.themeSelect===theme));}
document.addEventListener('click',ev=>{const nav=ev.target.closest('[data-page]');if(nav){go(nav.dataset.page);return}const link=ev.target.closest('[data-go]');if(link){go(link.dataset.go);return}const toggle=ev.target.closest('[data-toggle]');if(toggle){const a=apps.find(x=>x.id==Number(toggle.dataset.toggle));if(a){a.status=a.status==='running'?'stopped':'running';a.uptime=a.status==='running'?'Just started':'—';renderAll();toast(`${a.name} ${a.status==='running'?'started':'stopped'} (demo only)`)}return}const set=ev.target.closest('[data-theme-select]');if(set)setTheme(set.dataset.themeSelect)});
$('#themeToggle').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark'));
$('#mobileMenu').addEventListener('click',()=>$('#sidebar').classList.toggle('open'));
$('#appSearch').addEventListener('input',renderTable);$('#statusFilter').addEventListener('change',renderTable);
const modal=$('#newAppModal');document.querySelectorAll('.newAppBtn').forEach(b=>b.addEventListener('click',()=>modal.showModal()));$('#closeModal').onclick=()=>modal.close();$('#cancelModal').onclick=()=>modal.close();
$('#newAppForm').addEventListener('submit',e=>{e.preventDefault();let name=$('#newAppName').value.trim();if(!name)return;const runtime=$('#newAppRuntime').value;apps.push({id:Date.now(),name,slug:name.toLowerCase().replace(/[^a-z0-9]+/g,'-'),runtime,status:'stopped',icon:name.charAt(0).toUpperCase(),tone:'purple',uptime:'—',desc:''});modal.close();$('#newAppForm').reset();$('#appSearch').value='';$('#statusFilter').value='all';renderAll();go('applications');toast(`${name} created (demo only)`)});
renderAll();
