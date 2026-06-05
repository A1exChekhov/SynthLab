/* Channel Splitter — web UI (pywebview) → Python engine bridge */
'use strict';

let API = null;
let ST = null;            // last state
const $ = (id) => document.getElementById(id);

/* ---- module show/hide (chooser + eject) ---- */
function setVis(id, vis){
  const m = $(id); if(!m) return;
  m.style.display = vis ? '' : 'none';
  const d = document.querySelector('#chip-'+id+' .led-dot');
  if(d) d.classList.toggle('on', vis);
  setTimeout(fitWindow, 50);
}
function toggleMod(id){ const m = $(id); setVis(id, m.style.display === 'none'); }
window.setVis = setVis; window.toggleMod = toggleMod;

/* тема: dark / silver (JVC) */
function setTheme(t, persist){
  document.body.classList.toggle('theme-silver', t==='silver');
  document.querySelectorAll('#theme-seg button').forEach(b=>b.classList.toggle('on', b.dataset.t===t));
  if(persist!==false && API) API.set_ui('theme', t);
  setTimeout(fitWindow, 60);
}

/* выбор раскладки: 1 или 2 колонки */
function setCols(n, persist){
  document.body.classList.toggle('cols1', n===1);
  document.querySelectorAll('#cols-seg button').forEach(b=>b.classList.toggle('on', parseInt(b.dataset.c)===n));
  if(persist!==false && API) API.set_ui('cols', n);
  setTimeout(fitWindow, 60);
}

/* подгонка окна ровно под содержимое */
function fitWindow(){
  try{
    const wrap=document.querySelector('.wrap');
    if(!wrap || !API) return;
    let w=Math.ceil(wrap.offsetWidth), h=Math.ceil(wrap.offsetHeight);
    if(window.screen){ w=Math.min(w, screen.availWidth-20); h=Math.min(h, screen.availHeight-70); }
    API.resize_window(w, h);
  }catch(e){}
}

/* ---- helpers ---- */
function el(tag, cls, html){ const e=document.createElement(tag); if(cls)e.className=cls; if(html!=null)e.innerHTML=html; return e; }
function pct(v){ return Math.max(0,Math.min(100, v*100)); }
function dbStr(peak){ if(peak<=0.0001) return '-inf'; const db=20*Math.log10(peak); return (db>0?'+':'')+db.toFixed(1); }

/* generic horizontal fader: container .fader, value 0..1, onchange(v) */
function bindFader(fader, getV, onV){
  const cap = fader.querySelector('.cap');
  function place(v){ cap.style.left = pct(v)+'%'; }
  place(getV());
  let drag=false;
  function fromEvent(ev){
    const r=fader.getBoundingClientRect();
    let x=(ev.clientX - r.left)/r.width; x=Math.max(0,Math.min(1,x));
    place(x); onV(x);
  }
  fader.addEventListener('pointerdown', e=>{drag=true; fader.setPointerCapture(e.pointerId); fromEvent(e);});
  fader.addEventListener('pointermove', e=>{ if(drag) fromEvent(e);});
  fader.addEventListener('pointerup', e=>{drag=false;});
  fader.addEventListener('dblclick', ()=>{ place(getV.def!=null?getV.def:0.75); onV(getV.def!=null?getV.def:0.75);});
  return {place};
}

/* ================= RENDER ================= */
function renderAll(){
  renderOutputs(); renderSources(); renderEQ(); renderFX(); renderPhase(); renderPlayerParams();
  renderTransport(); renderVizColor();
}

function deviceSelect(list, current, cls, onChange){
  const s = el('select', 'devsel '+(cls||''));
  list.forEach(d=>{ const o=el('option',null,d.label); o.value=d.idx; if(d.label===current)o.selected=true; s.appendChild(o); });
  if(current && !list.some(d=>d.label===current)){ const o=el('option',null,current+' (нет)'); o.selected=true; o.value=-1; s.appendChild(o); }
  s.addEventListener('change', ()=>{ const lbl=s.options[s.selectedIndex].text; onChange(lbl); });
  return s;
}

const ROLES=[['L','L'],['R','R'],['Mono','Mono'],['L/R','L/R']];
function renderOutputs(){
  const box=$('rows-out'); box.innerHTML='';
  ST.outputs.forEach(o=>{
    const row=el('div','row');
    // dev cell
    const dev=el('div','dev');
    const dot=el('span','led-dot'); dot.dataset.outpeak=o.id; dev.appendChild(dot);
    const col=el('div'); col.style.minWidth='0'; col.style.flex='1';
    col.appendChild(deviceSelect(ST.out_devices, o.device, '', lbl=>{ API.set_output(o.id,'device',lbl).then(refresh); }));
    const meta=el('div','meta');
    const mute=el('span', o.mute?'mute-on':'', '◼ mute'); mute.style.cursor='pointer';
    mute.onclick=()=>{ API.set_output(o.id,'mute',!o.mute).then(refresh); };
    const sub=el('span', o.sub?'mute-on':'', ' · sub'); sub.style.cursor='pointer';
    sub.onclick=()=>{ API.set_output(o.id,'sub',!o.sub).then(refresh); };
    meta.appendChild(mute); meta.appendChild(sub);
    col.appendChild(meta); dev.appendChild(col);
    row.appendChild(dev);
    // role seg
    const seg=el('div','seg');
    ROLES.forEach(([lbl,val])=>{ const b=el('button', o.role===val?'on':'', lbl); b.onclick=()=>{ API.set_output(o.id,'role',val).then(refresh);}; seg.appendChild(b); });
    row.appendChild(seg);
    // volume fader
    const led=el('div','led', String(Math.round(o.vol*100)));
    const fader=el('div','fader'); fader.innerHTML='<div class="trk"></div><div class="cap"></div>';
    const gv=()=>o.vol/1.5; gv.def=1/1.5;
    bindFader(fader, gv, v=>{ o.vol=v*1.5; API.set_output(o.id,'vol',o.vol); led.textContent=Math.round(o.vol*100); });
    row.appendChild(fader);
    // vu (live level)
    const vu=el('div','vu'); vu.dataset.outvu=o.id; vu.style.setProperty('--v','0%'); row.appendChild(vu);
    // value (set volume %)
    row.appendChild(led);
    // remove output (clear, at row end)
    const rm=el('button','btn rrm','✕'); rm.title='Удалить выход';
    rm.onclick=()=>API.remove_output(o.id).then(refresh); row.appendChild(rm);
    box.appendChild(row);
  });
}

function renderSources(){
  const box=$('rows-src'); box.innerHTML='';
  ST.sources.forEach(s=>{
    const row=el('div','row');
    const dev=el('div','dev');
    const dot=el('span','led-dot amber'); dev.appendChild(dot);
    const col=el('div'); col.style.minWidth='0'; col.style.flex='1';
    if(s.loopback){
      const nm=el('div','nm','System Audio'); col.appendChild(nm);
      const DEF='— устройство по умолчанию —';
      const lbList=[{idx:-1,label:DEF}].concat((ST.lb_speakers||[]).map((name,i)=>({idx:i,label:name})));
      const sel=deviceSelect(lbList, s.lb_name||DEF, '', lbl=>{ API.set_source(s.id,'lb_name', lbl===DEF?'':lbl).then(refresh); });
      const meta=el('div','meta'); meta.appendChild(el('span',null,'захват: ')); meta.appendChild(sel);
      col.appendChild(meta);
    } else {
      col.appendChild(deviceSelect(ST.in_devices, s.device, '', lbl=>{ API.set_source(s.id,'device',lbl).then(refresh); }));
      const meta=el('div','meta');
      const inv=el('span', s.inv?'mute-on':'', 'Ø'); inv.style.cursor='pointer'; inv.onclick=()=>API.set_source(s.id,'inv',!s.inv).then(refresh);
      const mute=el('span', s.mute?'mute-on':'', ' · mute'); mute.style.cursor='pointer'; mute.onclick=()=>API.set_source(s.id,'mute',!s.mute).then(refresh);
      meta.appendChild(inv); meta.appendChild(mute); col.appendChild(meta);
    }
    dev.appendChild(col);
    row.appendChild(dev);
    // balance seg (placeholder column)
    const segc=el('div'); row.appendChild(segc);
    // volume
    const led=el('div','led', String(Math.round(s.vol*100)));
    const fader=el('div','fader'); fader.innerHTML='<div class="trk"></div><div class="cap"></div>';
    const gv=()=>s.vol/1.5; gv.def=1/1.5;
    bindFader(fader, gv, v=>{ s.vol=v*1.5; API.set_source(s.id,'vol',s.vol); led.textContent=Math.round(s.vol*100); });
    row.appendChild(fader);
    const vu=el('div','vu'); vu.dataset.srcvu=s.id; vu.style.setProperty('--v','0%'); row.appendChild(vu);
    row.appendChild(led);
    const rm=el('button','btn rrm','✕'); rm.title='Удалить источник';
    rm.onclick=()=>API.remove_source(s.id).then(refresh); row.appendChild(rm);
    box.appendChild(row);
  });
}

const EQF=[20,31,62,125,250,500,'1k','2k','4k','8k','16k','20k'];
function renderEQ(){
  const box=$('eq-bands'); box.innerHTML='';
  for(let i=0;i<12;i++){
    const band=el('div','band');
    const vrow=el('div','vrow');
    const m=el('div','vmeter'); m.dataset.eqm=i; m.style.setProperty('--v','0%');
    const slot=el('div','vslot'); slot.innerHTML='<div class="vtrk"></div><div class="vcap"></div>';
    const cap=slot.querySelector('.vcap');
    const g=ST.eq.gains[i]||0; // -12..12 → top% (0dB center=50%)
    const place=(gain)=>{ cap.style.top = (50 - (gain/12)*46)+'%'; };
    place(g);
    // vertical drag
    let drag=false;
    function fromE(ev){ const r=slot.getBoundingClientRect(); let y=(ev.clientY-r.top)/r.height; y=Math.max(0,Math.min(1,y)); const gain=(0.5-y)/0.46*12; const gg=Math.max(-12,Math.min(12,gain)); place(gg); API.set_eq(i, gg); ST.eq.gains[i]=gg; }
    slot.addEventListener('pointerdown',e=>{drag=true;slot.setPointerCapture(e.pointerId);fromE(e);});
    slot.addEventListener('pointermove',e=>{if(drag)fromE(e);});
    slot.addEventListener('pointerup',()=>drag=false);
    slot.addEventListener('dblclick',()=>{place(0);API.set_eq(i,0);ST.eq.gains[i]=0;});
    vrow.appendChild(m); vrow.appendChild(slot);
    band.appendChild(vrow); band.appendChild(el('span',null,EQF[i]));
    box.appendChild(band);
  }
  $('btn-eq-on').textContent = ST.eq.on ? 'EQ On' : 'EQ Off';
  $('btn-eq-on').classList.toggle('on', ST.eq.on);
}

function fxFader(id, key, lo, hi, getDisp){
  const f=$('fader-'+id); if(!f) return;
  const fx=ST.fx;
  const gv=()=>(getCur()-lo)/(hi-lo);
  function getCur(){ return fx[key]; }
  bindFader(f, gv, v=>{ const val=lo+v*(hi-lo); fx[key]=val; API.set_fx(key,val); $('led-'+id).textContent=getDisp(val); });
  $('led-'+id).textContent=getDisp(fx[key]);
}
function renderFX(){
  const fx=ST.fx;
  // pads on/off + position
  setupPad('pad-space', fx.spatial_on, ()=>{ const on=!ST.fx.spatial_on; ['spatial_on','threeD_on','surround_on'].forEach(k=>{ST.fx[k]=on;API.set_fx(k,on);}); $('pad-space').classList.toggle('on',on); },
    ()=>[clamp01(fx.spatial/2), clamp01(fx.threeD)], (x,y)=>{ fx.spatial=x*2; fx.threeD=y; fx.surround=y*0.6; API.set_fx('spatial',fx.spatial);API.set_fx('threeD',fx.threeD);API.set_fx('surround',fx.surround); });
  setupPad('pad-pos', fx.pos_on, ()=>{ const on=!ST.fx.pos_on; ST.fx.pos_on=on; API.set_fx('pos_on',on); $('pad-pos').classList.toggle('on',on); },
    ()=>[clamp01(fx.pan/2+0.5), clamp01(1-fx.distance)], (x,y)=>{ fx.pan=(x-0.5)*2; fx.distance=1-y; API.set_fx('pan',fx.pan);API.set_fx('distance',fx.distance); });
  setupPad('pad-tone', fx.tone_on, ()=>{ const on=!ST.fx.tone_on; ST.fx.tone_on=on; API.set_fx('tone_on',on); $('pad-tone').classList.toggle('on',on); },
    ()=>[clamp01(fx.tilt/2+0.5), clamp01(fx.drive)], (x,y)=>{ fx.tilt=(x-0.5)*2; fx.drive=y; API.set_fx('tilt',fx.tilt);API.set_fx('drive',fx.drive); });
  // strips
  fxFader('comp','comp_thresh',-40,0, v=>Math.round(v)+'');
  fxFader('mb','monobass_hz',60,250, v=>Math.round(v)+'');
  fxFader('rev','reverb_mix',0,0.8, v=>Math.round(v*100)+'');
  fxFader('revsize','reverb_size',0,1, v=>Math.round(v*100)+'');
  bindFxToggle('lbl-comp','comp_on','Compressor');
  bindFxToggle('lbl-mb','monobass_on','Mono-Bass');
  bindFxToggle('lbl-rev','reverb_on','Reverb');
}
function bindFxToggle(id,key,name){
  const e=$(id); if(!e)return;
  const upd=()=>{ e.textContent=name+' · '+(ST.fx[key]?'ON':'OFF'); e.classList.toggle('on',ST.fx[key]); };
  upd();
  e.onclick=()=>{ ST.fx[key]=!ST.fx[key]; API.set_fx(key,ST.fx[key]); upd(); };
}
function clamp01(v){return Math.max(0,Math.min(1,v));}
function setupPad(id, on, toggle, getXY, onXY){
  const pad=$(id); if(!pad)return;
  pad.classList.toggle('on',on);
  const handle=pad.querySelector('.handle');
  function place(){ const [x,y]=getXY(); handle.style.left=(x*100)+'%'; handle.style.top=((1-y)*100)+'%'; }
  place();
  pad.querySelector('.pad-t').onclick=()=>{ toggle(); };
  let drag=false;
  function fromE(ev){ const r=pad.getBoundingClientRect(); let x=(ev.clientX-r.left)/r.width, y=1-(ev.clientY-r.top)/r.height; x=clamp01(x);y=clamp01(y); handle.style.left=(x*100)+'%'; handle.style.top=((1-y)*100)+'%'; onXY(x,y); }
  pad.addEventListener('pointerdown',e=>{ if(e.target.classList.contains('pad-t'))return; drag=true; pad.setPointerCapture(e.pointerId); fromE(e);});
  pad.addEventListener('pointermove',e=>{if(drag)fromE(e);});
  pad.addEventListener('pointerup',()=>drag=false);
}

function renderPhase(){
  const seg=$('phase-seg'); seg.innerHTML='';
  ST.outputs.forEach(o=>{
    const nm=(o.device||('Out '+o.id)).split(' · ')[0].slice(0,10);
    const b=el('button', o.inv?'on':'', nm);
    b.onclick=()=>{ API.set_output(o.id,'inv',!o.inv).then(refresh); };
    seg.appendChild(b);
  });
  if(!ST.outputs.length) seg.appendChild(el('button','','—'));
}

function renderPlayerParams(){
  const box=$('player-params'); if(!box) return;
  const np=ST.np||{};
  const rows=[['Format',np.codec||'—'],['Rate',np.rate||'—'],['Bits',np.bits||'—'],['Ch',np.ch||'—'],['Stream',np.kbps||'—']];
  box.innerHTML='';
  rows.forEach(([k,v])=>{ const c=el('div','chip'); c.innerHTML=k+' <b>'+v+'</b>'; box.appendChild(c); });
}

function shortName(o){ return (o.device||('Out'+o.id)).split(' · ')[0].replace('Speakers ','').slice(0,11); }
function phaseBtn(o){
  const ph=el('button','btn ico'+(o.inv?' on':''),'Ø'); ph.title='Фаза 180° — '+shortName(o);
  ph.onclick=()=>{ o.inv=!o.inv; ph.classList.toggle('on',o.inv); API.set_output(o.id,'inv',o.inv); };
  return ph;
}
function renderTransportDelays(){
  const box=$('transport-delays'); if(!box) return; box.innerHTML='';
  const outs=ST.outputs;
  if(outs.length===2){
    // один ползунок-синхрон на 2 колонки: центр=синхронно, тянешь → задержка соседней
    const a=outs[0], b=outs[1];
    const wrap=el('div','td');
    const val=el('span','tdval','0'); val.style.minWidth='64px';
    const fader=el('div','fader'); fader.style.width='200px'; fader.innerHTML='<div class="trk"></div><div class="cap"></div>';
    const apply=v=>{
      const pos=Math.round((v-0.5)*500);   // −250..+250 мс
      if(pos>=0){ b.delay=pos; a.delay=0; val.textContent=(pos? shortName(b)+' +'+pos : '0')+' мс'; }
      else { a.delay=-pos; b.delay=0; val.textContent=shortName(a)+' +'+(-pos)+' мс'; }
      API.set_output(a.id,'delay',a.delay); API.set_output(b.id,'delay',b.delay);
    };
    const initPos=(b.delay>0? b.delay : -(a.delay||0));
    const gv=()=>(initPos/500+0.5); gv.def=0.5;
    bindFader(fader, gv, apply); apply(initPos/500+0.5);
    wrap.appendChild(el('span','tdlbl','СИНХРОН'));
    wrap.appendChild(phaseBtn(a)); wrap.appendChild(el('span','tdname',shortName(a)));
    wrap.appendChild(fader);
    wrap.appendChild(el('span','tdname',shortName(b))); wrap.appendChild(phaseBtn(b));
    wrap.appendChild(val);
    box.appendChild(wrap);
    return;
  }
  outs.forEach(o=>{
    const wrap=el('div','td');
    const nm=el('span','tdname', shortName(o));
    const val=el('span','tdval', String(Math.round(o.delay)));
    const fader=el('div','fader'); fader.style.width='130px'; fader.innerHTML='<div class="trk"></div><div class="cap"></div>';
    const gv=()=>o.delay/250; gv.def=0;
    bindFader(fader, gv, v=>{ o.delay=Math.round(v*250); val.textContent=o.delay; API.set_output(o.id,'delay',o.delay); });
    wrap.appendChild(nm); wrap.appendChild(el('span','tdlbl','dly'));
    wrap.appendChild(fader); wrap.appendChild(val); wrap.appendChild(el('span','tdlbl','мс'));
    wrap.appendChild(phaseBtn(o));
    box.appendChild(wrap);
  });
}

function renderTransport(){
  const run=ST.running;
  $('power-led').classList.toggle('on',run);
  $('power-txt').textContent= run?'ON':'OFF';
  $('transport-stat').textContent = run ? ('playing · '+ST.outputs.length+' out') : 'stopped';
  const mf=$('master-fader');
  if(mf && !mf.dataset.bound){ mf.dataset.bound='1';
    const gv=()=>ST.master/1.5; gv.def=1/1.5;
    bindFader(mf, gv, v=>{ ST.master=v*1.5; $('master-led').textContent=Math.round(ST.master*100); API.set_master(ST.master); });
  } else if(mf){ mf.querySelector('.cap').style.left=pct(ST.master/1.5)+'%'; }
  $('master-led').textContent=Math.round(ST.master*100);
  renderTransportDelays();
}

function renderVizColor(){
  document.querySelectorAll('#viz-color button').forEach(b=>{
    b.classList.toggle('on', parseInt(b.dataset.cm)===(ST.viz.color_mode||0));
  });
}

function renderChooser(){
  ['mod-player','mod-out','mod-src','mod-eq','mod-fx','mod-viz'].forEach(id=>{
    const m=$(id); const vis = m && m.style.display!=='none';
    const d=document.querySelector('#chip-'+id+' .led-dot'); if(d) d.classList.toggle('on', vis);
  });
}

/* ================= STATE ================= */
function refresh(){ return API.get_state().then(s=>{ ST=s; renderAll(); setTimeout(fitWindow, 60); }); }

/* ================= METERS LOOP ================= */
let vizCtx=null, vizCanvas=null;
function meterLoop(){
  if(!API){ return; }
  API.meters().then(m=>{
    if(!m) return;
    for(const id in m.outs){ const v=$('rows-out')?document.querySelector('[data-outvu="'+id+'"]'):null;
      const peak=m.outs[id];
      const vu=document.querySelector('[data-outvu="'+id+'"]'); if(vu) vu.style.setProperty('--v', pct(Math.min(1,peak*1.4))+'%');
      const dot=document.querySelector('[data-outpeak="'+id+'"]'); if(dot) dot.classList.toggle('on', m.running);
    }
    for(const id in m.srcs){ const lr=m.srcs[id]; const pk=Math.max(lr[0],lr[1]);
      const vu=document.querySelector('[data-srcvu="'+id+'"]'); if(vu) vu.style.setProperty('--v', pct(Math.min(1,pk*1.4))+'%'); }
    if(m.spectrum){ for(let i=0;i<12;i++){ const mm=document.querySelector('[data-eqm="'+i+'"]'); if(mm){ const v=Math.min(1, (m.spectrum[i]||0)); mm.style.setProperty('--v', pct(v)+'%'); } } }
    if(m.np){ ST = ST||{}; updateNP(m.np); }
    drawViz(m.bands || m.spectrum, m.wave, m.level, m.beat);
  }).catch(()=>{});
}
function updateNP(np){
  if($('np-title')) $('np-title').textContent = np.title || '—';
  if($('np-sub')) { $('np-sub').style.display = ''; $('np-sub').textContent = np.sub || ''; }
  if($('np-src')) $('np-src').textContent = np.source ? ('Now Playing · '+np.source) : 'Now Playing';
  if($('np-led')) $('np-led').classList.toggle('on', !!np.title);
  if($('np-cur')) $('np-cur').textContent = np.cur || '0:00';
  if($('np-tot')) $('np-tot').textContent = np.total || '0:00';
  if($('np-bar')) $('np-bar').style.width = Math.max(0,Math.min(100,(np.posfrac||0)*100))+'%';
  if(np.codec!==undefined){ ST.np=np; renderPlayerParams(); }
}
function drawViz(spec, wave, level, beat){
  if(!vizCanvas){ vizCanvas=$('viz-canvas'); if(!vizCanvas) return; vizCtx=vizCanvas.getContext('2d'); }
  const c=vizCanvas, ctx=vizCtx; const w=c.clientWidth, h=c.clientHeight;
  if(c.width!==w||c.height!==h){ c.width=w; c.height=h; }
  // feedback-style fade
  ctx.globalCompositeOperation='source-over';
  ctx.fillStyle='rgba(5,6,7,0.22)'; ctx.fillRect(0,0,w,h);
  ctx.globalCompositeOperation='lighter';
  const cm=ST&&ST.viz?ST.viz.color_mode:0;
  if(spec){
    const n=spec.length, bw=w/n;
    for(let i=0;i<n;i++){
      const v=Math.min(1,spec[i]*1.2); const bh=v*h*0.9;
      let col;
      if(cm===1) col='rgba(220,220,210,'+(0.3+0.6*v)+')';
      else if(cm===2){ col='hsla(45,70%,'+(40+40*v)+'%,'+(0.3+0.6*v)+')'; }
      else col='hsla('+(i/n*260)+',85%,'+(45+25*v)+'%,'+(0.35+0.6*v)+')';
      ctx.fillStyle=col;
      ctx.fillRect(i*bw+1, h-bh, bw-1, bh);
    }
  }
  if(beat>0.5){ ctx.fillStyle='rgba(232,176,75,0.10)'; ctx.fillRect(0,0,w,h); }
}

/* ================= WIRE BUTTONS ================= */
function wire(){
  $('btn-add-out').onclick=()=>API.add_output().then(refresh);
  $('btn-add-src').title='Добавить физический вход (микрофон/линейный/CABLE)';
  $('btn-add-src').onclick=()=>API.add_source().then(refresh);
  $('btn-add-sys').title='Добавить системный звук (что играет ПК, loopback)';
  $('btn-add-sys').onclick=()=>API.add_loopback().then(refresh);
  $('md-prev').onclick=()=>API.media_prev();
  $('md-play').onclick=()=>API.media_playpause();
  $('md-next').onclick=()=>API.media_next();
  document.querySelectorAll('#cols-seg button').forEach(b=>{ b.onclick=()=>{ setCols(parseInt(b.dataset.c)); }; });
  document.querySelectorAll('#theme-seg button').forEach(b=>{ b.onclick=()=>{ setTheme(b.dataset.t); }; });
  $('btn-eq-on').onclick=()=>{ ST.eq.on=!ST.eq.on; API.set_eq_on(ST.eq.on).then(()=>renderEQ()); };
  $('btn-eq-reset').onclick=()=>API.eq_reset().then(refresh);
  $('btn-eq-presets').onclick=openPresets;
  $('preset-close').onclick=()=>{ $('preset-modal').style.display='none'; };
  $('preset-save').onclick=()=>{ const n=$('preset-name').value.trim(); if(n) API.eq_save(n).then(openPresets); };
  $('btn-power').onclick=()=>API.toggle().then(refresh);
  $('btn-devices').title='Пересканировать аудиоустройства';
  $('btn-devices').onclick=()=>{ const b=$('btn-devices'); b.textContent='…'; API.refresh_devices().then(()=>refresh()).then(()=>{ b.textContent='Devices'; }); };
  $('btn-viz').title='Открыть GPU-цветомузыку (полный экран / 4K)';
  $('btn-viz').onclick=()=>API.open_viz();
  $('btn-viz-open').onclick=()=>API.open_viz();
  $('btn-fx').title='Показать модуль спецэффектов (DSP)';
  $('btn-fx').onclick=()=>{ const m=$('mod-fx'); if(m.style.display==='none'){ setVis('mod-fx',true);} m.scrollIntoView({behavior:'smooth'}); };
  $('btn-calib').title='Авто-выравнивание задержек по микрофону';
  $('btn-calib').onclick=openCalib;
  $('calib-cancel').onclick=()=>{ $('calib-modal').style.display='none'; };
  $('calib-run').onclick=()=>{
    const sel=$('calib-mic'); const lbl=sel.options.length?sel.options[sel.selectedIndex].text:'';
    $('calib-status').textContent='Измеряю задержки… (тихий свип на каждую колонку)';
    $('calib-run').disabled=true;
    API.calibrate(lbl).then(res=>{
      $('calib-run').disabled=false;
      $('calib-status').textContent=(res&&res.msg)||'Готово';
      renderCalibResults((res&&res.items)||[]);
      $('calib-setup').style.display='none';
      $('calib-results').style.display='';
      refresh();
    });
  };
  $('calib-again').onclick=()=>{ $('calib-results').style.display='none'; $('calib-setup').style.display=''; $('calib-status').textContent=''; };
  $('calib-done').onclick=()=>{ $('calib-modal').style.display='none'; refresh(); };
  document.querySelectorAll('#viz-color button').forEach(b=>{ b.onclick=()=>{ const cm=parseInt(b.dataset.cm); ST.viz.color_mode=cm; API.set_viz('color_mode',cm); renderVizColor(); }; });
}

function openCalib(){
  const sel=$('calib-mic'); sel.innerHTML='';
  (ST.mic_devices||[]).forEach(d=>{ const o=el('option',null,d.label); o.value=d.idx; sel.appendChild(o); });
  if(!sel.options.length){ sel.appendChild(el('option',null,'(микрофон не найден)')); }
  $('calib-status').textContent='';
  $('calib-setup').style.display=''; $('calib-results').style.display='none';
  $('calib-modal').style.display='flex';
}
function renderCalibResults(items){
  const box=$('calib-rows'); box.innerHTML='';
  if(!items.length){ box.appendChild(el('div',null,'нет данных')); return; }
  items.forEach(it=>{
    const r=el('div'); r.style.cssText='display:flex;align-items:center;gap:10px';
    const nm=el('div',null,it.name); nm.style.cssText='width:160px;min-width:0;font-family:var(--cond);font-size:12px;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const dec=el('button','btn ico','−'); dec.title='−1 мс';
    const fader=el('div','fader'); fader.style.flex='1'; fader.innerHTML='<div class="trk"></div><div class="cap"></div>';
    const inc=el('button','btn ico','+'); inc.title='+1 мс';
    const val=el('span','led',String(it.delay)); val.style.cssText='min-width:42px;text-align:right';
    const fobj={place:null};
    const apply=v=>{ v=Math.max(0,Math.min(250,Math.round(v))); it.delay=v; val.textContent=v; if(fobj.place)fobj.place(v/250); API.set_output(it.id,'delay',v); };
    const gv=()=>it.delay/250; gv.def=0;
    const f=bindFader(fader, gv, v=>apply(v*250)); fobj.place=f.place;
    dec.onclick=()=>apply(it.delay-1);
    inc.onclick=()=>apply(it.delay+1);
    r.appendChild(nm); r.appendChild(dec); r.appendChild(fader); r.appendChild(inc); r.appendChild(val); r.appendChild(el('span',null,'мс'));
    box.appendChild(r);
  });
}

function openPresets(){
  API.eq_presets().then(names=>{
    const box=$('preset-list'); box.innerHTML='';
    if(!names.length){ const e=el('div',null,'Нет сохранённых пресетов'); e.style.color='var(--sub)'; e.style.fontSize='11px'; e.style.padding='6px 2px'; box.appendChild(e); }
    names.forEach(n=>{
      const r=el('div'); r.style.display='flex'; r.style.gap='8px'; r.style.alignItems='center';
      const ap=el('button','btn',n); ap.style.flex='1'; ap.style.justifyContent='flex-start';
      ap.onclick=()=>{ API.eq_apply(n).then(()=>{ refresh(); $('preset-modal').style.display='none'; }); };
      const dl=el('button','btn rrm','✕'); dl.title='Удалить пресет';
      dl.onclick=()=>API.eq_delete(n).then(openPresets);
      r.appendChild(ap); r.appendChild(dl); box.appendChild(r);
    });
    $('preset-name').value='';
    $('preset-modal').style.display='flex';
  });
}

/* ================= BOOT ================= */
function boot(){
  API = window.pywebview.api;
  wire();
  refresh().then(()=>{ renderChooser(); const u=(ST&&ST.ui)||{}; setTheme(u.theme||'dark', false); setCols(u.cols||2, false); });
  setInterval(meterLoop, 50);
}
if(window.pywebview && window.pywebview.api){ boot(); }
else { window.addEventListener('pywebviewready', boot); }
