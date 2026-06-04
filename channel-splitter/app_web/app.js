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
}
function toggleMod(id){ const m = $(id); setVis(id, m.style.display === 'none'); }
window.setVis = setVis; window.toggleMod = toggleMod;

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
    const dly=el('span',null,' · dly '); const di=el('input'); di.type='number'; di.min=0; di.max=500; di.value=o.delay; di.style.width='42px'; di.style.background='#0c0d0f'; di.style.color='#9a9d98'; di.style.border='1px solid #000';
    di.onchange=()=>API.set_output(o.id,'delay',parseFloat(di.value)||0);
    const sub=el('span', o.sub?'mute-on':'', ' · sub'); sub.style.cursor='pointer';
    sub.onclick=()=>{ API.set_output(o.id,'sub',!o.sub).then(refresh); };
    meta.appendChild(mute); meta.appendChild(dly); meta.appendChild(di); meta.appendChild(sub);
    col.appendChild(meta); dev.appendChild(col);
    const rm=el('button','btn eject','✕'); rm.style.position='static'; rm.style.width='22px'; rm.style.height='22px';
    rm.onclick=()=>API.remove_output(o.id).then(refresh); dev.appendChild(rm);
    row.appendChild(dev);
    // role seg
    const seg=el('div','seg');
    ROLES.forEach(([lbl,val])=>{ const b=el('button', o.role===val?'on':'', lbl); b.onclick=()=>{ API.set_output(o.id,'role',val).then(refresh);}; seg.appendChild(b); });
    row.appendChild(seg);
    // volume fader
    const fader=el('div','fader'); fader.innerHTML='<div class="trk"></div><div class="cap"></div>';
    const gv=()=>o.vol/1.5; gv.def=1/1.5;
    bindFader(fader, gv, v=>{ o.vol=v*1.5; API.set_output(o.id,'vol',o.vol); });
    row.appendChild(fader);
    // vu
    const vu=el('div','vu'); vu.dataset.outvu=o.id; vu.style.setProperty('--v','0%'); row.appendChild(vu);
    // value (dB peak)
    const led=el('div','led','-inf'); led.dataset.outdb=o.id; row.appendChild(led);
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
      const nm=el('div','nm', s.name||'System Audio');
      const meta=el('div','meta','loopback');
      col.appendChild(nm); col.appendChild(meta);
    } else {
      col.appendChild(deviceSelect(ST.in_devices, s.device, '', lbl=>{ API.set_source(s.id,'device',lbl).then(refresh); }));
      const meta=el('div','meta');
      const inv=el('span', s.inv?'mute-on':'', 'Ø'); inv.style.cursor='pointer'; inv.onclick=()=>API.set_source(s.id,'inv',!s.inv).then(refresh);
      const mute=el('span', s.mute?'mute-on':'', ' · mute'); mute.style.cursor='pointer'; mute.onclick=()=>API.set_source(s.id,'mute',!s.mute).then(refresh);
      meta.appendChild(inv); meta.appendChild(mute); col.appendChild(meta);
    }
    dev.appendChild(col);
    const rm=el('button','btn eject','✕'); rm.style.position='static'; rm.style.width='22px'; rm.style.height='22px';
    rm.onclick=()=>API.remove_source(s.id).then(refresh); dev.appendChild(rm);
    row.appendChild(dev);
    // balance seg (placeholder column) — show pan as small text for now
    const segc=el('div'); row.appendChild(segc);
    // volume
    const fader=el('div','fader'); fader.innerHTML='<div class="trk"></div><div class="cap"></div>';
    const gv=()=>s.vol/1.5; gv.def=1/1.5;
    bindFader(fader, gv, v=>{ s.vol=v*1.5; API.set_source(s.id,'vol',s.vol); });
    row.appendChild(fader);
    const vu=el('div','vu'); vu.dataset.srcvu=s.id; vu.style.setProperty('--v','0%'); row.appendChild(vu);
    const led=el('div','led', String(Math.round(s.vol*100))); led.dataset.srcvol=s.id; row.appendChild(led);
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
function refresh(){ return API.get_state().then(s=>{ ST=s; renderAll(); }); }

/* ================= METERS LOOP ================= */
let vizCtx=null, vizCanvas=null;
function meterLoop(){
  if(!API){ return; }
  API.meters().then(m=>{
    if(!m) return;
    for(const id in m.outs){ const v=$('rows-out')?document.querySelector('[data-outvu="'+id+'"]'):null;
      const peak=m.outs[id];
      const vu=document.querySelector('[data-outvu="'+id+'"]'); if(vu) vu.style.setProperty('--v', pct(Math.min(1,peak*1.4))+'%');
      const db=document.querySelector('[data-outdb="'+id+'"]'); if(db) db.textContent=dbStr(peak);
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
  if($('np-sub')) $('np-sub').textContent = np.sub || '';
  if($('np-src')) $('np-src').textContent = np.source ? ('Now Playing · '+np.source) : 'Now Playing';
  if($('np-led')) $('np-led').classList.toggle('on', !!np.title);
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
  $('btn-add-src').onclick=()=>API.add_source().then(refresh);
  $('btn-add-sys').onclick=()=>API.add_loopback().then(refresh);
  $('btn-eq-on').onclick=()=>{ ST.eq.on=!ST.eq.on; API.set_eq_on(ST.eq.on).then(()=>renderEQ()); };
  $('btn-eq-reset').onclick=()=>API.eq_reset().then(refresh);
  $('btn-eq-presets').onclick=presetMenu;
  $('btn-power').onclick=()=>API.toggle().then(refresh);
  $('btn-devices').onclick=()=>API.refresh_devices().then(refresh);
  $('btn-viz').onclick=()=>API.open_viz();
  $('btn-viz-open').onclick=()=>API.open_viz();
  $('btn-fx').onclick=()=>{ const m=$('mod-fx'); if(m.style.display==='none'){ setVis('mod-fx',true);} m.scrollIntoView({behavior:'smooth'}); };
  $('btn-calib').onclick=()=>{ API.calibrate().then(r=>{ alert(r||'Калибровка завершена'); refresh(); }); };
  document.querySelectorAll('#viz-color button').forEach(b=>{ b.onclick=()=>{ const cm=parseInt(b.dataset.cm); ST.viz.color_mode=cm; API.set_viz('color_mode',cm); renderVizColor(); }; });
}

function presetMenu(){
  API.eq_presets().then(names=>{
    let msg='Пресеты:\n'+(names.length?names.join('\n'):'(нет)')+'\n\nВведи имя для ПРИМЕНЕНИЯ, или новое имя + "!" для СОХРАНЕНИЯ:';
    const inp=prompt(msg,'');
    if(!inp) return;
    if(inp.endsWith('!')){ API.eq_save(inp.slice(0,-1).trim()).then(refresh); }
    else { API.eq_apply(inp.trim()).then(refresh); }
  });
}

/* ================= BOOT ================= */
function boot(){
  API = window.pywebview.api;
  wire();
  refresh().then(()=>{ renderChooser(); });
  setInterval(meterLoop, 50);
}
if(window.pywebview && window.pywebview.api){ boot(); }
else { window.addEventListener('pywebviewready', boot); }
