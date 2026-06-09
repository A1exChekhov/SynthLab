/* Channel Splitter — web UI (pywebview) → Python engine bridge */
'use strict';

let API = null;
let ST = null;            // last state
const $ = (id) => document.getElementById(id);

/* ================= i18n (ru / en) ================= */
let LANG = 'ru';
const I18N = {
  ru: {
    // Лицевые подписи — технические, всегда латиницей (как на hi-fi). Русский только в тултипах и окнах.
    rack:'Rack', theme:'Theme', layout:'Layout',
    tip_mod_player:'Плеер: что играет сейчас, обложка и транспорт',
    tip_mod_out:'Matrix: выходы на колонки — роль L/R/Mono, громкость, задержка',
    tip_mod_src:'Pre-Amp: источники звука — System Audio и микрофоны',
    tip_mod_eq:'Эквалайзер — 12 полос',
    tip_mod_fx:'DSP-эффекты: позиция, тон, моно-бас, компрессор, реверб',
    tip_mod_viz:'Анализатор спектра',
    tip_theme:'Тема оформления: тёмная / серебро',
    tip_layout:'Сколько колонок в раскладке модулей',
    tip_power:'Включить / выключить воспроизведение',
    tip_master:'Общая громкость (мастер)',
    tip_prev:'Предыдущий', tip_play:'Плей / Пауза', tip_next:'Следующий', tip_stop:'Стоп',
    now_playing:'Now Playing',
    add_output:'Output', add_system:'System', add_source:'Source',
    input:'Input', tuner:'Tuner',
    tip_input:'Выбрать вход: микрофон / аудиоинтерфейс / линейный вход',
    tip_add_src:'Добавить ещё источник',
    tip_tuner:'Тюнер — интернет-радио',
    tip_output:'Выбрать/заменить выход на первой позиции',
    tip_add_out:'Добавить новый канал (выход)',
    eq_on:'EQ On', eq_off:'EQ Off', presets:'Presets', reset:'Reset',
    open_gpu:'GPU screen',
    power_on:'ON', power_off:'OFF', stat_stopped:'stopped',
    stat_playing:'playing', out_short:'out',
    master:'Master', sync:'SYNC', phase:'PHASE', hold:'HOLD', ms:'ms', dly:'dly',
    devices:'Devices', calibrate:'Calibrate', effects:'Effects', visualizer:'Visualizer',
    mini:'Mini', tip_mini:'Показать / скрыть мини-плеер',
    mute:'mute', sub:'sub', capture:'src', default_device:'— default device —',
    system_mix:'all system audio',
    none_paren:'(n/a)', no_mic:'(микрофон не найден)',
    remove_output:'Удалить выход', remove_source:'Удалить источник', remove_preset:'Удалить пресет',
    radio_eject:'выгнать радио',
    phase_tip:'Фаза 180°',
    tip_add_src:'Добавить физический вход (микрофон/линейный/CABLE)',
    tip_add_sys:'Добавить системный звук (что играет ПК, loopback)',
    tip_devices:'Пересканировать аудиоустройства',
    tip_viz:'Открыть GPU-цветомузыку (полный экран / 4K)',
    tip_viz_art:'Обложка трека в анализаторе (отжать — спектр на всю полосу)',
    tip_fx:'Показать модуль спецэффектов (DSP)',
    tip_calib:'Авто-выравнивание задержек по микрофону',
    tip_hold:'Зафиксировать текущую синхронизацию и онлайн-удерживать её по микрофону (дрейф BT)',
    tip_sync:'Калибровка синхронизации: тяни, пока звук колонок не совпадёт (сдвиг задержки между ними)',
    tip_delay:'Задержка этого выхода в миллисекундах',
    tip_caldelay:'Точная подстройка задержки выхода (мс)',
    tip_minus:'−1 мс', tip_plus:'+1 мс',
    tip_space:'Пространство: ширина стерео (→) и глубина (↑). Клик по названию — вкл/выкл',
    tip_position:'Позиция: панорама (→) и удалённость источника (↑). Клик по названию — вкл/выкл',
    tip_tone:'Тон: тёплый↔яркий (→) и насыщение/drive (↑). Клик по названию — вкл/выкл',
    tip_comp:'Компрессор: порог срабатывания (дБ). Клик по названию — вкл/выкл',
    tip_bass:'Усиление баса: low-shelf 110 Гц, 0…12 дБ. Клик по названию — вкл/выкл',
    tip_monobass:'Моно-бас: ниже этой частоты бас сводится в моно (плотнее)',
    tip_reverb:'Реверберация: размер (Sz) и доля эффекта (Mx). Клик по названию — вкл/выкл',
    tip_phase_dsp:'Инверсия фазы 180° этого выхода',
    fmt_format:'Format', fmt_rate:'Rate', fmt_bits:'Bits', fmt_ch:'Ch', fmt_stream:'Stream',
    cal_title:'Авто-калибровка',
    cal_intro:'Микрофон выровняет задержки между выходами. Поставь микрофон между колонок и нажми «Калибровать» (прозвучит тихий свип на каждую колонку).',
    cal_mic:'Микрофон', cal_cancel:'Отмена', cal_run:'Калибровать', cal_select:'Выбрать для HOLD',
    cal_selected:'Микрофон выбран для HOLD',
    cal_result:'Результат — задержки выровнены. Подстрой вручную (мс) при необходимости:',
    cal_again:'Заново', cal_done:'Готово',
    cal_measuring:'Измеряю задержки… (тихий свип на каждую колонку)',
    cal_nodata:'нет данных', cal_ok:'Готово',
    preset_title:'Пресеты', preset_ph:'Имя нового пресета…', preset_save:'Сохранить',
    preset_close:'Закрыть', preset_none:'Нет сохранённых пресетов',
    about:'О программе', about_title:'О программе',
    lic_head:'Лицензия', contact:'Связь', donate:'Поддержать',
    lic_body:'© 2026 Errarium™. Лицензионное соглашение Errarium™ (проприетарная лицензия). Разрешено личное некоммерческое использование. Запрещены перепродажа, ребрендинг и удаление уведомлений об авторских правах. ПО предоставляется «как есть», без гарантий.',
    about_desc:'Channel Splitter — премиальный маршрутизатор звука: раздаёт L/R на несколько Bluetooth-колонок и наушники, с EQ, спецэффектами, GPU-цветомузыкой и компенсацией задержки.',
    close:'Закрыть', mini:'Mini',
  },
  en: {
    rack:'Rack', theme:'Theme', layout:'Layout',
    tip_mod_player:'Player: now playing, cover art and transport',
    tip_mod_out:'Matrix: speaker outputs — role L/R/Mono, volume, delay',
    tip_mod_src:'Pre-Amp: audio sources — System Audio and microphones',
    tip_mod_eq:'Equalizer — 12 bands',
    tip_mod_fx:'DSP effects: position, tone, mono-bass, compressor, reverb',
    tip_mod_viz:'Spectrum analyzer',
    tip_theme:'Appearance theme: dark / silver',
    tip_layout:'How many columns in the module layout',
    tip_power:'Start / stop playback',
    tip_master:'Master volume',
    tip_prev:'Previous', tip_play:'Play / Pause', tip_next:'Next', tip_stop:'Stop',
    input:'Input', tuner:'Tuner',
    tip_input:'Choose input: microphone / audio interface / line-in',
    tip_add_src:'Add another source',
    tip_tuner:'Tuner — internet radio',
    tip_output:'Select/replace the first output',
    tip_add_out:'Add a new channel (output)',
    now_playing:'Now Playing',
    add_output:'Output', add_system:'System', add_source:'Source',
    eq_on:'EQ On', eq_off:'EQ Off', presets:'Presets', reset:'Reset',
    open_gpu:'GPU screen',
    power_on:'ON', power_off:'OFF', stat_stopped:'stopped',
    stat_playing:'playing', out_short:'out',
    master:'Master', sync:'SYNC', phase:'PHASE', hold:'HOLD', ms:'ms', dly:'dly',
    devices:'Devices', calibrate:'Calibrate', effects:'Effects', visualizer:'Visualizer',
    mini:'Mini', tip_mini:'Show / hide the mini player',
    mute:'mute', sub:'sub', capture:'capture', default_device:'— default device —',
    system_mix:'all system audio',
    none_paren:'(missing)', no_mic:'(no microphone found)',
    remove_output:'Remove output', remove_source:'Remove source', remove_preset:'Delete preset',
    radio_eject:'eject radio',
    phase_tip:'Phase 180°',
    tip_add_src:'Add a physical input (microphone / line-in / CABLE)',
    tip_add_sys:'Add system audio (what the PC is playing, loopback)',
    tip_devices:'Rescan audio devices',
    tip_viz:'Open GPU visualizer (full screen / 4K)',
    tip_viz_art:'Track cover in the analyzer (off — full-width spectrum)',
    tip_fx:'Show the effects (DSP) module',
    tip_calib:'Auto-align output delays using a microphone',
    tip_hold:'Lock the current sync and keep it online via microphone (BT drift)',
    tip_sync:'Sync calibration: drag until the speakers align (delay offset between them)',
    tip_delay:'Delay of this output in milliseconds',
    tip_caldelay:'Fine-tune the output delay (ms)',
    tip_minus:'−1 ms', tip_plus:'+1 ms',
    tip_space:'Space: stereo width (→) and depth (↑). Click the name to toggle',
    tip_position:'Position: pan (→) and source distance (↑). Click the name to toggle',
    tip_tone:'Tone: warm↔bright (→) and drive (↑). Click the name to toggle',
    tip_comp:'Compressor: threshold (dB). Click the name to toggle',
    tip_bass:'Bass boost: 110 Hz low-shelf, 0…12 dB. Click the name to toggle',
    tip_monobass:'Mono-bass: below this frequency bass is summed to mono',
    tip_reverb:'Reverb: size (Sz) and wet mix (Mx). Click the name to toggle',
    tip_phase_dsp:'Invert phase 180° for this output',
    fmt_format:'Format', fmt_rate:'Rate', fmt_bits:'Bits', fmt_ch:'Ch', fmt_stream:'Stream',
    cal_title:'Auto-Calibration',
    cal_intro:'A microphone aligns the delays between outputs. Place the mic between the speakers and press “Calibrate” (a quiet sweep plays on each speaker).',
    cal_mic:'Microphone', cal_cancel:'Cancel', cal_run:'Calibrate', cal_select:'Use for HOLD',
    cal_selected:'Microphone selected for HOLD',
    cal_result:'Done — delays aligned. Fine-tune manually (ms) if needed:',
    cal_again:'Again', cal_done:'Done',
    cal_measuring:'Measuring delays… (quiet sweep on each speaker)',
    cal_nodata:'no data', cal_ok:'Done',
    preset_title:'Presets', preset_ph:'New preset name…', preset_save:'Save',
    preset_close:'Close', preset_none:'No saved presets',
    about:'About', about_title:'About',
    lic_head:'License', contact:'Contact', donate:'Donate',
    lic_body:'© 2026 Errarium™. Errarium™ License Agreement (proprietary). Personal, non-commercial use is permitted. Resale, rebranding and removal of copyright notices are prohibited. The software is provided “as is”, without warranty.',
    about_desc:'Channel Splitter is a premium audio router: it sends L/R to multiple Bluetooth speakers and headphones, with EQ, effects, a GPU visualizer and latency compensation.',
    close:'Close', mini:'Mini',
  },
};
function t(k){ const d=I18N[LANG]||I18N.ru; return (d[k]!=null?d[k]:(I18N.ru[k]!=null?I18N.ru[k]:k)); }
function applyStaticI18n(){
  document.documentElement.lang = LANG;
  document.querySelectorAll('[data-i18n]').forEach(e=>{ e.textContent = t(e.dataset.i18n); });
  document.querySelectorAll('[data-i18n-title]').forEach(e=>{ e.title = t(e.dataset.i18nTitle); });
  document.querySelectorAll('[data-i18n-ph]').forEach(e=>{ e.placeholder = t(e.dataset.i18nPh); });
}
function setLang(l, persist){
  LANG = (l==='en')?'en':'ru';
  document.querySelectorAll('#lang-seg button').forEach(b=>b.classList.toggle('on', b.dataset.l===LANG));
  applyStaticI18n();
  if(ST) renderAll();
  if(persist!==false && API) API.set_ui('lang', LANG);
  setTimeout(fitWindow, 60);
}
window.setLang = setLang;

/* ---- module show/hide (chooser + eject) ---- */
function setVis(id, vis, persist){
  const m = $(id); if(!m) return;
  m.style.display = vis ? '' : 'none';
  if(id==='mod-out') document.querySelectorAll('.mod-out-extra').forEach(s=>{ s.style.display = vis ? '' : 'none'; });
  const d = document.querySelector('#chip-'+id+' .led-dot');
  if(d) d.classList.toggle('on', vis);
  // запоминаем выбор свёрнутых блоков между запусками
  if(persist!==false && API && API.set_ui){ ST=ST||{}; ST.ui=ST.ui||{}; ST.ui.mods=ST.ui.mods||{}; ST.ui.mods[id]=vis; API.set_ui('mods', ST.ui.mods); }
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
    // Measure the CONTENT (.wrap) only — never document.body, because body{height:100%}
    // pins its height to the current viewport, which would block the window from ever
    // shrinking (leaving the empty "black strip" below the UI).
    let w=Math.ceil(wrap.offsetWidth);
    let h=Math.ceil(Math.max(wrap.offsetHeight, wrap.scrollHeight));
    if(window.screen){ w=Math.min(w, screen.availWidth-20); h=Math.min(h, screen.availHeight-70); }
    API.resize_window(w, h);
  }catch(e){}
}

// Keep the window glued to the content height: any layout change (adding a source
// module, toggling a panel, switching columns, fonts finishing load) re-fits the
// window so there is never leftover empty space (the "black strip") below the UI.
let _fitTimer=null;
function scheduleFit(){ clearTimeout(_fitTimer); _fitTimer=setTimeout(fitWindow, 40); }
function setupAutoFit(){
  const wrap=document.querySelector('.wrap');
  if(wrap && window.ResizeObserver){ new ResizeObserver(scheduleFit).observe(wrap); }
  window.addEventListener('resize', scheduleFit);
  if(document.fonts && document.fonts.ready){ document.fonts.ready.then(scheduleFit); }
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
  if(current && !list.some(d=>d.label===current)){ const o=el('option',null,current+' '+t('none_paren')); o.selected=true; o.value=-1; s.appendChild(o); }
  s.addEventListener('change', ()=>{ const lbl=s.options[s.selectedIndex].text; onChange(lbl); });
  return s;
}

const ROLES=[['L','L'],['R','R'],['Mono','Mono'],['L/R','L/R']];
function renderOutputRow(o){
  const row=el('div','row');
  // dev cell
  const dev=el('div','dev');
  const dot=el('span','led-dot'); dot.dataset.outpeak=o.id; dev.appendChild(dot);
  const col=el('div'); col.style.minWidth='0'; col.style.flex='1';
  col.appendChild(deviceSelect(ST.out_devices, o.device, '', lbl=>{ API.set_output(o.id,'device',lbl).then(refresh); }));
  const meta=el('div','meta');
  const mute=el('span', o.mute?'mute-on':'', '◼ '+t('mute')); mute.style.cursor='pointer';
  mute.onclick=()=>{ API.set_output(o.id,'mute',!o.mute).then(refresh); };
  const sub=el('span', o.sub?'mute-on':'', ' · '+t('sub')); sub.style.cursor='pointer';
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
  const rm=el('button','btn rrm','✕'); rm.title=t('remove_output');
  rm.onclick=()=>API.remove_output(o.id).then(refresh); row.appendChild(rm);
  return row;
}
const ROMAN=['','II','III','IV','V','VI','VII','VIII'];
function renderOutputs(){
  // Каждый блок MX-840 — максимум 3 выхода. Больше — добавляем ещё блок MX-840 · II, · III…
  document.querySelectorAll('.mod-out-extra').forEach(s=>s.remove());
  const box=$('rows-out'); box.innerHTML='';
  const outs=ST.outputs;
  const PER=3;
  for(let i=0;i<Math.min(PER,outs.length);i++) box.appendChild(renderOutputRow(outs[i]));
  if(outs.length<=PER) return;
  const stack=document.querySelector('.stack');
  const hidden = $('mod-out') && $('mod-out').style.display==='none';
  for(let g=PER, n=1; g<outs.length; g+=PER, n++){
    const sec=el('section','mod-out-extra'); sec.style.order='3';
    if(hidden) sec.style.display='none';
    const face=el('div','face mod u-full');
    face.appendChild(el('div','phead',
      '<div class="fp"><span class="marque">Errarium</span><span class="model">MX-840 · '+(ROMAN[n]||(n+1))+'</span><span class="fn">Output Matrix</span></div>'));
    const pbody=el('div','pbody');
    outs.slice(g, g+PER).forEach(o=>pbody.appendChild(renderOutputRow(o)));
    face.appendChild(pbody);
    sec.appendChild(face);
    stack.appendChild(sec);
  }
}

function renderSourceRow(s){
  const row=el('div','row');
  const dev=el('div','dev');
  const dot=el('span','led-dot amber'); dev.appendChild(dot);
  const col=el('div'); col.style.minWidth='0'; col.style.flex='1';
  if(s.radio){
    // Интернет-радио: понятная строка + явная кнопка «выгнать радио из сплиттера».
    const nm=el('div','nm', (_radioStation&&_radioStation.name)||'Radio'); col.appendChild(nm);
    const meta=el('div','meta');
    const f=ST.fmt||{}; const kb=Math.round(f.kbps||0);
    meta.appendChild(el('span',null,'RADIO'+(f.codec?(' · '+f.codec):'')+(kb>0?(' · '+kb+' kbps'):' · LIVE')));
    col.appendChild(meta);
  } else if(s.loopback){
    const nm=el('div','nm','System Audio'); col.appendChild(nm);
    const DEF=t('default_device');
    const lbList=[{idx:-1,label:DEF}].concat((ST.lb_speakers||[]).map((name,i)=>({idx:i,label:name})));
    const meta=el('div','meta'); meta.appendChild(el('span',null,t('capture')+': '));
    if(lbList.length>1){
      // per-device loopback choice available (Windows): keep the dropdown
      const sel=deviceSelect(lbList, s.lb_name||DEF, '', lbl=>{ API.set_source(s.id,'lb_name', lbl===DEF?'':lbl).then(refresh); });
      meta.appendChild(sel);
    } else {
      // native system tap (macOS 14.2+): the whole mix is captured, no device to pick
      const lbl=el('span',null,t('system_mix')); lbl.style.color='#e3e5e1'; meta.appendChild(lbl);
    }
    col.appendChild(meta);
  } else {
    col.appendChild(deviceSelect(ST.in_devices, s.device, '', lbl=>{ API.set_source(s.id,'device',lbl).then(refresh); }));
    const meta=el('div','meta');
    const inv=el('span', s.inv?'mute-on':'', 'Ø'); inv.style.cursor='pointer'; inv.onclick=()=>API.set_source(s.id,'inv',!s.inv).then(refresh);
    const mute=el('span', s.mute?'mute-on':'', ' · '+t('mute')); mute.style.cursor='pointer'; mute.onclick=()=>API.set_source(s.id,'mute',!s.mute).then(refresh);
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
  const rm=el('button','btn rrm','✕'); rm.title=t('remove_source');
  rm.onclick=()=>API.remove_source(s.id).then(refresh); row.appendChild(rm);
  return row;
}

// Each PA-220 stays half-height and holds ONE source. Extra sources spawn their
// own half-height PA-220 · II / III … modules (same pattern as the MX-840 outputs),
// so the module never overflows its fixed 124px cell.
function renderSources(){
  document.querySelectorAll('.mod-src-extra').forEach(s=>s.remove());
  const box=$('rows-src'); box.innerHTML='';
  const srcs=ST.sources;
  const PER=1;
  for(let i=0;i<Math.min(PER,srcs.length);i++) box.appendChild(renderSourceRow(srcs[i]));
  if(srcs.length<=PER) return;
  const stack=document.querySelector('.stack');
  const hidden = $('mod-src') && $('mod-src').style.display==='none';
  for(let g=PER, n=1; g<srcs.length; g+=PER, n++){
    const sec=el('section','mod-src-extra'); sec.style.order='2';
    if(hidden) sec.style.display='none';
    const face=el('div','face mod u-half');
    face.appendChild(el('div','phead',
      '<div class="fp"><span class="marque">Errarium</span><span class="model">PA-220 · '+(ROMAN[n]||(n+1))+'</span><span class="fn">Preamplifier</span></div>'));
    const pbody=el('div','pbody');
    srcs.slice(g, g+PER).forEach(s=>pbody.appendChild(renderSourceRow(s)));
    face.appendChild(pbody);
    sec.appendChild(face);
    stack.appendChild(sec);
  }
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
  $('btn-eq-on').textContent = ST.eq.on ? t('eq_on') : t('eq_off');
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
  fxFader('bass','bass',0,12, v=>Math.round(v)+'');   // Bass Boost (low-shelf 110 Гц), дБ
  fxFader('mb','monobass_hz',60,250, v=>Math.round(v)+'');
  fxFader('rev','reverb_mix',0,0.8, v=>Math.round(v*100)+'');
  fxFader('revsize','reverb_size',0,1, v=>Math.round(v*100)+'');
  bindFxToggle('lbl-comp','comp_on','Compressor');
  bindBassToggle();
  bindFxToggle('lbl-mb','monobass_on','Mono-Bass');
  bindFxToggle('lbl-rev','reverb_on','Reverb');
}
// Bass: включение при ползунке 0 дБ ничего бы не дало — подставляем слышимые +6 дБ
function bindBassToggle(){
  const e=$('lbl-bass'); if(!e) return;
  const upd=()=>{ e.textContent='Bass · '+(ST.fx.bass_on?'ON':'OFF'); e.classList.toggle('on',!!ST.fx.bass_on); };
  upd();
  e.onclick=()=>{
    ST.fx.bass_on=!ST.fx.bass_on;
    if(ST.fx.bass_on && (ST.fx.bass||0)<1){
      ST.fx.bass=6; API.set_fx('bass',6);
      const f=$('fader-bass'); if(f){ const cap=f.querySelector('.cap'); if(cap) cap.style.left=(6/12*100)+'%'; }
      const l=$('led-bass'); if(l) l.textContent='6';
    }
    API.set_fx('bass_on',ST.fx.bass_on);
    upd();
  };
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
  const seg=$('phase-seg'); if(!seg) return; seg.innerHTML='';
  ST.outputs.forEach(o=>{
    const nm=(o.device||('Out '+o.id)).split(' · ')[0].slice(0,10);
    const b=el('button', o.inv?'on':'', nm);
    b.title=t('tip_phase_dsp')+' — '+nm;
    b.onclick=()=>{ API.set_output(o.id,'inv',!o.inv).then(refresh); };
    seg.appendChild(b);
  });
  if(!ST.outputs.length) seg.appendChild(el('button','','—'));
}

function renderPlayerParams(){
  const box=$('player-params'); if(!box) return;
  // реальный формат источника (снимается движком: ST.fmt = {rate, ch, codec})
  const f=ST.fmt||{};
  const chMap={1:'mono',2:'stereo',3:'2.1',4:'4.0',6:'5.1',8:'7.1'};
  const rateHz=Math.round(f.rate||0);
  const rate=rateHz>0 ? (rateHz>=1000 ? (rateHz/1000).toFixed(1)+'k' : String(rateHz)) : '—';
  const chN=parseInt(f.ch);
  const ch=(!isNaN(chN)&&chN>0)?(chMap[chN]||(chN+' ch')):'—';
  const codec=(f.codec||'').trim()||'—';
  // bits: для PCM-захвата движка (Float→32f, "N-bit"→N); сжатые кодеки (AAC/MP3/…) — нет «бит»
  let bits='—';
  if(/float|pcm/i.test(codec)) bits='32f';   // PCM-захват движка — float32 (32F)
  else { const mb=codec.match(/(\d+)\s*-?\s*bit/i); if(mb) bits=mb[1]; }
  // stream: реальный битрейт (только радио); иначе LIVE для потока, либо —
  const kbps=Math.round(f.kbps||0);
  const stream = kbps>0 ? (kbps+' kbps') : (/stream/i.test(codec)?'LIVE':'—');
  const rows=[[t('fmt_format'),codec],[t('fmt_rate'),rate],[t('fmt_bits'),bits],[t('fmt_ch'),ch],[t('fmt_stream'),stream]];
  box.innerHTML='';
  rows.forEach(([k,v])=>{ const c=el('div','chip'); c.innerHTML=k+' <b>'+v+'</b>'; box.appendChild(c); });
}

function shortName(o){ return (o.device||('Out'+o.id)).split(' · ')[0].replace('Speakers ','').slice(0,11); }
function phaseBtn(o){
  const ph=el('button','btn ico'+(o.inv?' on':''),'Ø'); ph.title=t('phase_tip')+' — '+shortName(o);
  ph.onclick=()=>{ o.inv=!o.inv; ph.classList.toggle('on',o.inv); API.set_output(o.id,'inv',o.inv); };
  return ph;
}
function holdMic(){
  if(ST.ui && ST.ui.hold_mic) return ST.ui.hold_mic;
  const sel=$('calib-mic');
  if(sel && sel.options.length && sel.selectedIndex>=0) return sel.options[sel.selectedIndex].text;
  return (ST.mic_devices && ST.mic_devices[0]) ? ST.mic_devices[0].label : '';
}
function renderHold(){
  const hb=$('transport-hold'); if(!hb) return; hb.innerHTML='';
  const hold=el('button','btn'+(ST.hold?' on':'')); hold.textContent=t('hold');
  hold.style.minWidth='62px'; hold.style.height='24px'; hold.style.fontSize='11px';
  hold.title=t('tip_hold');
  hold.onclick=()=>{ API.hold_toggle(holdMic()).then(on=>{ ST.hold=!!on; hold.classList.toggle('on',!!on); }); };
  hb.appendChild(hold);
}
function renderTransportDelays(){
  // ЕДИНСТВЕННЫЙ регулятор задержки — SYNC между двумя колонками (первые два выхода).
  // Сколько бы выходов ни было, слот ВСЕГДА один и стоит на месте (никаких сдвигов).
  // Выравнивание 3+ выходов — будущая версия (2D-дисплей с точками-колонками).
  const box=$('transport-delays'); if(!box) return; box.innerHTML='';
  const outs=ST.outputs;
  if(outs.length>=2){
    const a=outs[0], b=outs[1];
    const wrap=el('div','td');
    const val=el('span','tdval','0'); val.style.minWidth='62px';
    const fader=el('div','fader'); fader.style.width='180px'; fader.title=t('tip_sync'); fader.innerHTML='<div class="trk"></div><div class="cap"></div>';
    const apply=v=>{
      const pos=Math.round((v-0.5)*500);   // −250..+250 мс
      if(pos>0){ b.delay=pos; a.delay=0; val.textContent='▶ '+pos+' '+t('ms'); }
      else if(pos<0){ a.delay=-pos; b.delay=0; val.textContent='◀ '+(-pos)+' '+t('ms'); }
      else { a.delay=0; b.delay=0; val.textContent='0'; }
      API.set_output(a.id,'delay',a.delay); API.set_output(b.id,'delay',b.delay);
    };
    const initPos=(b.delay>0? b.delay : -(a.delay||0));
    const gv=()=>(initPos/500+0.5); gv.def=0.5;
    bindFader(fader, gv, apply); apply(initPos/500+0.5);
    wrap.appendChild(el('span','tdlbl',t('sync')));
    wrap.appendChild(fader);
    wrap.appendChild(val);
    box.appendChild(wrap);
  }
  renderHold();
}
function renderTransportPhase(){
  const box=$('transport-phase'); if(!box) return; box.innerHTML='';
  box.appendChild(el('span','lbl',t('phase')+' Ø'));
  if(!ST.outputs.length){ box.appendChild(el('span','tdname','—')); return; }
  ST.outputs.forEach((o,i)=>{
    const b=phaseBtn(o);   // тултип кнопки содержит имя устройства
    const w=el('div','td'); w.style.gap='4px';
    const lbl=el('span','tdname','in '+(i+1)); lbl.style.maxWidth='34px';
    w.appendChild(b); w.appendChild(lbl);
    box.appendChild(w);
  });
}

function renderTransport(){
  const run=ST.running;
  $('power-led').classList.toggle('on',run);
  $('power-txt').textContent= run?t('power_on'):t('power_off');
  $('transport-stat').textContent = run ? (t('stat_playing')+' · '+ST.outputs.length+' '+t('out_short')) : t('stat_stopped');
  const mf=$('master-fader');
  if(mf && !mf.dataset.bound){ mf.dataset.bound='1';
    const gv=()=>ST.master/1.5; gv.def=1/1.5;
    bindFader(mf, gv, v=>{ ST.master=v*1.5; $('master-led').textContent=Math.round(ST.master*100); API.set_master(ST.master); });
  } else if(mf){ mf.querySelector('.cap').style.left=pct(ST.master/1.5)+'%'; }
  $('master-led').textContent=Math.round(ST.master*100);
  renderTransportDelays();
  renderTransportPhase();
}

let vizGpu=false;   // окно анализатора показывает цветомузыку (WebGL) вместо столбиков
// Color / GPU — РЕЖИМ показа (взаимоисключающие). B&W — независимый тумблер ч/б,
// применяется к текущему показу (столбики ИЛИ цветомузыка), горит пока включён.
function renderVizColor(){
  const bw=((ST&&ST.viz&&ST.viz.color_mode)||0)===1;
  const c=$('btn-viz-color'), b=$('btn-viz-bw'), g=$('btn-viz-gpu');
  if(c) c.classList.toggle('on', !vizGpu);
  if(g) g.classList.toggle('on', vizGpu);
  if(b) b.classList.toggle('on', bw);
}
// Переключение окна анализатора: столбики ⇄ цветомузыка (iframe viz.html).
function setVizGpu(on){
  vizGpu=on;
  const f=$('viz-gl'), c=$('viz-canvas');
  if(on && f && !f.getAttribute('src')) f.setAttribute('src','viz.html');   // ленивая загрузка
  if(f) f.style.display=on?'block':'none';
  if(c) c.style.display=on?'none':'block';
  renderVizColor(); setArtEls();
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
    ST = ST||{};
    // реальный формат источника (снимается движком) — перерисовываем параметры при изменении
    if(m.fmt){ const pf=ST.fmt||{};
      if(pf.rate!==m.fmt.rate||pf.ch!==m.fmt.ch||pf.codec!==m.fmt.codec||pf.kbps!==m.fmt.kbps){ ST.fmt=m.fmt; renderPlayerParams(); } }
    // авто-переключение источника в движке (приоритет последнего) — подтягиваем новое состояние
    if(m.src_sig!==undefined && m.src_sig!==_srcSig){ _srcSig=m.src_sig; if(typeof refresh==='function') refresh(); }
    // Радио управляется ПРАВДОЙ движка: если радио в движке больше нет (убрали/переключили
    // источник) — сбрасываем радио-данные в плеере, чтобы старое не «застревало».
    if(m.radio_active){ _radioWasActive=true; }
    else if(_radioWasActive){ _radioWasActive=false; clearRadioState(); }
    const src0=(ST.sources&&ST.sources[0])||{};
    if(_radioUrl && _radioStation && m.radio_active){   // радио — станция + трек из ICY, а не системный now-playing
      const song=((m.radio_title)||'').trim();
      if(song!==_radioSong){ _radioSong=song; _radioCover=null; _lastArtId=null;
        if(song) fetchRadioCover(song).then(u=>{ if(_radioSong===song){ _radioCover=u; _lastArtId=null; } });
      }
      // STOP = сброс: время на 0:00 и счётчик обнуляется; на паузе — замирает.
      const now=Date.now();
      let curTxt;
      if(m.radio_stopped){
        _radioStart=now; _radioPauseAt=0; _radioPausedAccum=0; curTxt='0:00';
      } else {
        if(m.radio_paused){ if(_radioPauseAt===0) _radioPauseAt=now; }
        else if(_radioPauseAt){ _radioPausedAccum+=now-_radioPauseAt; _radioPauseAt=0; }
        const frozen = _radioPauseAt ? _radioPauseAt : now;
        const e=Math.max(0,(frozen-_radioStart-_radioPausedAccum)/1000), mm=Math.floor(e/60), ss=Math.floor(e%60);
        curTxt=mm+':'+(ss<10?'0':'')+ss;
      }
      updateNP({ title: song||_radioStation.name||'Radio',
                 sub: (m.radio_stopped?'⏹ ':(m.radio_paused?'⏸ ':''))+(song?(_radioStation.name||'RADIO'):'RADIO'),
                 cur:curTxt, total:'LIVE', posfrac:0, art_id:'radio:'+_radioUrl });
      // передаём текущую обложку песни в движок — чтобы мини-плеер показывал её, а не лого станции
      const cover=_radioCover||(_radioStation&&_radioStation.favicon)||'';
      if(cover!==_radioCoverPushed && API && API.set_radio_cover){ _radioCoverPushed=cover; API.set_radio_cover(cover); }
    } else if(src0.loopback){         // системный звук / приложение — now-playing из системной медиа-сессии
      // На Windows захват идёт по УСТРОЙСТВУ (изоляция приложения недоступна), поэтому
      // показываем системный now-playing всегда — обложка подхватывается из любого плеера.
      updateNP(m.np||{ title:'', sub:'', cur:'', total:'', posfrac:0, art_id:'' });
    } else {                          // физический вход или нет источника — now-playing неприменим, очищаем
      updateNP({ title: src0.device||src0.name||'—', sub:'INPUT', cur:'', total:'', posfrac:0, art_id:'' });
    }
    if(vizGpu){
      const f=$('viz-gl');
      if(f&&f.contentWindow) f.contentWindow.postMessage({viz:m.viz||{}, running:m.running, color_mode:(ST.viz&&ST.viz.color_mode)||0}, '*');
    } else {
      drawViz(m.bands || m.spectrum, m.wave, m.level, m.beat);
    }
  }).catch(()=>{});
}
function setMarquee(rowId, mqId, text){
  const row=$(rowId), mq=$(mqId); if(!row||!mq) return;
  if(mq.textContent!==text){ mq.textContent=text; }
  // measure on next frame so layout is settled, then enable scroll only on overflow
  requestAnimationFrame(()=>{
    const over=mq.scrollWidth - row.clientWidth;
    if(over>4){
      row.style.setProperty('--mqshift', (-over-8)+'px');
      row.style.setProperty('--mqdur', Math.max(6, (over+row.clientWidth)/26)+'s');
      row.classList.add('scroll');
    } else { row.classList.remove('scroll'); row.style.removeProperty('--mqshift'); }
  });
}
function updateNP(np){
  setMarquee('np-title','np-title-mq', np.title || '—');
  if($('np-sub')) $('np-sub').style.display = '';
  setMarquee('np-sub','np-sub-mq', np.sub || '');
  if($('np-src')) $('np-src').textContent = np.source ? (t('now_playing')+' · '+np.source) : t('now_playing');
  if($('np-led')) $('np-led').classList.toggle('on', !!np.title);
  if($('np-cur')) $('np-cur').textContent = np.cur || '0:00';
  if($('np-tot')) $('np-tot').textContent = np.total || '0:00';
  if($('np-bar')) $('np-bar').style.width = Math.max(0,Math.min(100,(np.posfrac||0)*100))+'%';
  updateArt(np.art_id||'');
}
// Обложка трека: показывается в плеере (#pl-art) и в анализаторе (#viz-art, по тумблеру
// Cover). Большая картинка тянется отдельным методом только при смене трека (art_id).
let _lastArtId=null, _artUrl=null;
let vizArtOn=true;   // тумблер «Cover» в анализаторе (нажат → обложка; отжат → спектр на всю полосу)
function setArtEls(){
  const v=$('viz-art');
  if(v){ if(_artUrl && vizArtOn){ v.src=_artUrl; v.style.display='block'; } else { v.removeAttribute('src'); v.style.display='none'; } }
  const p=$('pl-art'), c=$('pl-cover');
  if(p&&c){ if(_artUrl){ p.src=_artUrl; c.style.display='block'; } else { p.removeAttribute('src'); c.style.display='none'; } }
}
function applyVizArtToggle(){
  const b=$('btn-viz-art'); if(b) b.classList.toggle('on', vizArtOn);
  setArtEls();
}
function updateArt(artId){
  // Радио — обложка трека (iTunes) или лого станции (управляется в meterLoop через _radioCover).
  if(_radioUrl && _radioStation){
    const u=_radioCover||_radioStation.favicon||null;
    if(u!==_artUrl){ _artUrl=u; setArtEls(); }
    _lastArtId=artId; return;
  }
  if(artId===_lastArtId){
    // тот же трек (в т.ч. пауза) — НЕ перезапрашиваем обложку (иначе мигает);
    // только дотягиваем, если она ещё не загрузилась.
    if(artId && !_artUrl && API && API.now_playing_art){
      API.now_playing_art().then(url=>{ if(url){ _artUrl=url; setArtEls(); } }).catch(()=>{});
    }
    return;
  }
  _lastArtId=artId;
  if(!artId){ _artUrl=null; setArtEls(); return; }
  _artUrl=null; setArtEls();   // новый трек — очистить, пока не пришла его обложка
  if(API && API.now_playing_art){
    // не сбрасываем уже показанную обложку при пустом ответе — ставим только когда есть url.
    API.now_playing_art().then(url=>{ if(url){ _artUrl=url; setArtEls(); } }).catch(()=>{});
  }
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
      const v=Math.min(1,spec[i]*2.0); const bh=Math.pow(v,0.82)*h*0.96;
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
  $('btn-add-out').onclick=()=>API.add_output().then(refresh);   // «+» — добавить новый канал
  const bOut=$('btn-output'); if(bOut) bOut.onclick=()=>openOutputMenu(bOut);
  $('btn-add-src').onclick=()=>API.add_source().then(refresh);   // «+» — добавить источник
  $('btn-add-sys').onclick=()=>API.add_loopback().then(refresh); // System — системный звук
  const bIn=$('btn-input'); if(bIn) bIn.onclick=()=>openInputMenu(bIn);
  const bTun=$('btn-tuner'); if(bTun) bTun.onclick=()=>openTuner();
  const bEj=$('btn-radio-eject'); if(bEj) bEj.onclick=()=>{ clearRadioState(); if(API.tuner_stop) API.tuner_stop().then(refresh); }; // выгнать радио
  $('md-prev').onclick=()=>API.media_prev();
  $('md-play').onclick=()=>API.media_playpause();
  $('md-next').onclick=()=>API.media_next();
  $('md-stop').onclick=()=>API.media_stop();
  document.querySelectorAll('#cols-seg button').forEach(b=>{ b.onclick=()=>{ setCols(parseInt(b.dataset.c)); }; });
  document.querySelectorAll('#theme-seg button').forEach(b=>{ b.onclick=()=>{ setTheme(b.dataset.t); }; });
  const fa=$('foot-about'); if(fa) fa.onclick=openAbout;
  const ac=$('about-close'); if(ac) ac.onclick=()=>{ $('about-modal').style.display='none'; };
  const cc=$('about-contact'); if(cc) cc.onclick=(e)=>{ e.preventDefault(); if(API.open_url) API.open_url('mailto:errarium_ai@gmail.com'); };
  const dp=$('about-donate-pp'); if(dp) dp.onclick=()=>{ if(API.open_url) API.open_url('https://www.paypal.com/paypalme/errarium'); };
  const dc=$('about-donate-cr'); if(dc) dc.onclick=()=>{ if(API.open_url) API.open_url('https://errarium.example/donate'); };
  $('btn-eq-on').onclick=()=>{ ST.eq.on=!ST.eq.on; API.set_eq_on(ST.eq.on).then(()=>renderEQ()); };
  $('btn-eq-reset').onclick=()=>API.eq_reset().then(refresh);
  $('btn-eq-presets').onclick=openPresets;
  $('preset-close').onclick=()=>{ $('preset-modal').style.display='none'; };
  $('preset-save').onclick=()=>{ const n=$('preset-name').value.trim(); if(n) API.eq_save(n).then(openPresets); };
  $('btn-power').onclick=()=>API.toggle().then(refresh);
  $('btn-devices').onclick=()=>{ const b=$('btn-devices'); b.textContent='…'; API.refresh_devices().then(()=>refresh()).then(()=>{ b.textContent=t('devices'); }); };
  $('btn-viz').onclick=()=>API.open_viz();
  $('btn-viz-open').onclick=()=>API.open_viz();
  $('btn-fx').onclick=()=>{ const m=$('mod-fx'); if(m.style.display==='none'){ setVis('mod-fx',true);} m.scrollIntoView({behavior:'smooth'}); };
  $('btn-calib').onclick=openCalib;
  const bm=$('btn-mini'); if(bm) bm.onclick=()=>{ if(API.toggle_mini) API.toggle_mini(); };
  $('calib-cancel').onclick=()=>{ $('calib-modal').style.display='none'; };
  $('calib-run').onclick=()=>{
    const sel=$('calib-mic'); const lbl=sel.options.length?sel.options[sel.selectedIndex].text:'';
    $('calib-status').textContent=t('cal_measuring');
    $('calib-run').disabled=true;
    API.calibrate(lbl).then(res=>{
      $('calib-run').disabled=false;
      $('calib-status').textContent=(res&&res.msg)||t('cal_ok');
      renderCalibResults((res&&res.items)||[]);
      $('calib-setup').style.display='none';
      $('calib-results').style.display='';
      refresh();
    });
  };
  $('calib-select').onclick=()=>{
    const sel=$('calib-mic'); if(!sel.options.length) return;
    const lbl=sel.options[sel.selectedIndex].text;
    ST.ui=ST.ui||{}; ST.ui.hold_mic=lbl;
    if(API.set_ui) API.set_ui('hold_mic', lbl);
    $('calib-status').textContent=t('cal_selected')+': '+lbl;
  };
  $('calib-again').onclick=()=>{ $('calib-results').style.display='none'; $('calib-setup').style.display=''; $('calib-status').textContent=''; };
  $('calib-done').onclick=()=>{ $('calib-modal').style.display='none'; refresh(); };
  // Color — столбики (и сбрасывает ч/б в цвет); GPU — цветомузыка (повтор → следующий режим);
  // B&W — независимый тумблер ч/б поверх текущего показа (не меняет режим).
  const cb=$('btn-viz-color'); if(cb) cb.onclick=()=>{ ST.viz.color_mode=0; API.set_viz('color_mode',0); setVizGpu(false); };
  const bwb=$('btn-viz-bw'); if(bwb) bwb.onclick=()=>{ const v=((ST.viz&&ST.viz.color_mode)||0)===1?0:1; ST.viz.color_mode=v; API.set_viz('color_mode',v); renderVizColor(); };
  const gpub=$('btn-viz-gpu'); if(gpub) gpub.onclick=()=>{ if(!vizGpu) setVizGpu(true); else { const f=$('viz-gl'); if(f&&f.contentWindow) f.contentWindow.postMessage({cmd:'next'},'*'); } };
  vizArtOn = !(ST && ST.ui && ST.ui.viz_art===false);   // ST ещё null при wire() → по умолчанию вкл.
  applyVizArtToggle();
  const ab=$('btn-viz-art');
  if(ab) ab.onclick=()=>{ vizArtOn=!vizArtOn; applyVizArtToggle(); if(API.set_ui)API.set_ui('viz_art',vizArtOn); };
}

function openCalib(){
  const sel=$('calib-mic'); sel.innerHTML='';
  const saved=(ST.ui&&ST.ui.hold_mic)||'';
  (ST.mic_devices||[]).forEach(d=>{ const o=el('option',null,d.label); o.value=d.idx; if(d.label===saved)o.selected=true; sel.appendChild(o); });
  if(!sel.options.length){ sel.appendChild(el('option',null,t('no_mic'))); }
  $('calib-status').textContent='';
  $('calib-setup').style.display=''; $('calib-results').style.display='none';
  $('calib-modal').style.display='flex';
}
function renderCalibResults(items){
  const box=$('calib-rows'); box.innerHTML='';
  if(!items.length){ box.appendChild(el('div',null,t('cal_nodata'))); return; }
  items.forEach(it=>{
    const r=el('div'); r.style.cssText='display:flex;align-items:center;gap:10px';
    const nm=el('div',null,it.name); nm.style.cssText='width:160px;min-width:0;font-family:var(--cond);font-size:12px;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const dec=el('button','btn ico','−'); dec.title=t('tip_minus');
    const fader=el('div','fader'); fader.style.flex='1'; fader.title=t('tip_caldelay'); fader.innerHTML='<div class="trk"></div><div class="cap"></div>';
    const inc=el('button','btn ico','+'); inc.title=t('tip_plus');
    const val=el('span','led',String(it.delay)); val.style.cssText='min-width:42px;text-align:right';
    const fobj={place:null};
    const apply=v=>{ v=Math.max(0,Math.min(250,Math.round(v))); it.delay=v; val.textContent=v; if(fobj.place)fobj.place(v/250); API.set_output(it.id,'delay',v); };
    const gv=()=>it.delay/250; gv.def=0;
    const f=bindFader(fader, gv, v=>apply(v*250)); fobj.place=f.place;
    dec.onclick=()=>apply(it.delay-1);
    inc.onclick=()=>apply(it.delay+1);
    r.appendChild(nm); r.appendChild(dec); r.appendChild(fader); r.appendChild(inc); r.appendChild(val); r.appendChild(el('span',null,t('ms')));
    box.appendChild(r);
  });
}

function openPresets(){
  API.eq_presets().then(names=>{
    const box=$('preset-list'); box.innerHTML='';
    if(!names.length){ const e=el('div',null,t('preset_none')); e.style.color='var(--sub)'; e.style.fontSize='11px'; e.style.padding='6px 2px'; box.appendChild(e); }
    names.forEach(n=>{
      const r=el('div'); r.style.display='flex'; r.style.gap='8px'; r.style.alignItems='center';
      const ap=el('button','btn',n); ap.style.flex='1'; ap.style.justifyContent='flex-start';
      ap.onclick=()=>{ API.eq_apply(n).then(()=>{ refresh(); $('preset-modal').style.display='none'; }); };
      const dl=el('button','btn rrm','✕'); dl.title=t('remove_preset');
      dl.onclick=()=>API.eq_delete(n).then(openPresets);
      r.appendChild(ap); r.appendChild(dl); box.appendChild(r);
    });
    $('preset-name').value='';
    $('preset-modal').style.display='flex';
  });
}

function openAbout(){
  applyStaticI18n();
  $('about-modal').style.display='flex';
}
window.openAbout=openAbout;

/* ================= BOOT ================= */
// ── выпадающее меню (в границах окна) ──
function closeMenu(){ const m=document.querySelector('.dropmenu'); if(m) m.remove(); document.removeEventListener('mousedown',_menuOutside,true); }
function _menuOutside(e){ const m=document.querySelector('.dropmenu'); if(m && !m.contains(e.target)) closeMenu(); }
function openMenu(anchor, items){
  closeMenu();
  const m=el('div','dropmenu');
  items.forEach(it=>{ if(it.sep){ m.appendChild(el('div','dropsep')); return; }
    const d=el('div','dropitem', it.label); d.onclick=()=>{ closeMenu(); it.onClick(); }; m.appendChild(d); });
  document.body.appendChild(m);
  const r=anchor.getBoundingClientRect();
  let left=Math.max(8, Math.min(r.left, innerWidth-m.offsetWidth-8));
  let top=r.bottom+4; if(top+m.offsetHeight>innerHeight-8) top=Math.max(8, r.top-m.offsetHeight-4);
  m.style.left=left+'px'; m.style.top=top+'px';
  setTimeout(()=>document.addEventListener('mousedown',_menuOutside,true),0);
}
function openInputMenu(anchor){
  const items=[{label:'🔊 '+t('system_mix'), onClick:()=>{ clearRadioState(); API.set_input('system','').then(refresh); }}];
  (ST.lb_speakers||[]).forEach(name=>items.push({label:'▸ '+name, onClick:()=>{ clearRadioState(); API.set_input('app',name).then(refresh); }}));
  const ins=(ST.in_devices||[]); if(ins.length) items.push({sep:true});
  ins.forEach(d=>items.push({label:'🎤 '+d.label, onClick:()=>{ clearRadioState(); API.set_input('device',d.label).then(refresh); }}));
  openMenu(anchor, items);
}
function openOutputMenu(anchor){
  const outs=(ST.out_devices||[]); const first=(ST.outputs||[])[0];
  const items=outs.map(d=>({label:d.label, onClick:()=>{ if(first) API.set_output(first.id,'device',d.label).then(refresh); }}));
  if(!items.length) items.push({label:'—', onClick:()=>{}});
  openMenu(anchor, items);
}

// ── Tuner: дашборд интернет-радио (данные/логотипы — Radio Browser) ──
let _tunerBuilt=false, _tunerSearchT=null;
const TUNER_MAX=24;   // 6 колонок × 4 ряда
let _radioGroups=null, _radioActive='A', _radioSelected=null;

function tunerLoadGroups(){
  const saved = ST && ST.ui && ST.ui.radio_groups;
  if(saved && typeof saved==='object' && saved.A){ _radioGroups=saved; }
  else { _radioGroups={A:{name:'A',list:[]},B:{name:'B',list:[]},C:{name:'C',list:[]}}; }
  _radioActive = (ST&&ST.ui&&ST.ui.radio_group) || 'A';
  if(!_radioGroups[_radioActive]) _radioActive='A';
  // последняя станция (запоминается между запусками) — выбрана по умолчанию
  if(!_radioSelected && ST&&ST.ui&&ST.ui.radio_last) _radioSelected = ST.ui.radio_last;
}
function tunerSaveGroups(){ if(API&&API.set_ui){ API.set_ui('radio_groups',_radioGroups); API.set_ui('radio_group',_radioActive); } }

function openTuner(){
  buildTunerModal();
  tunerLoadGroups();
  $('tuner-modal').style.display='flex';
  $('tuner-search').value='';
  renderTunerTabs();
  renderSavedGroup();
}
function closeTuner(){ const m=$('tuner-modal'); if(m) m.style.display='none'; }
function buildTunerModal(){
  if(_tunerBuilt) return; _tunerBuilt=true;
  const modal=el('div'); modal.id='tuner-modal';
  modal.innerHTML='<div class="tuner-panel">'
    +'<div class="tuner-head"><span class="tuner-title">Tuner</span>'
    +'<div class="tuner-tabs" id="tuner-tabs"></div>'
    +'<input class="tuner-search" id="tuner-search" placeholder="Поиск станции для добавления…">'
    +'<button class="tuner-play" id="tuner-play" title="Играть выбранную станцию">▶ Играть</button>'
    +'<button class="tuner-close" id="tuner-close" title="Закрыть">✕</button></div>'
    +'<div class="tuner-grid" id="tuner-grid"></div>'
    +'<div class="tuner-undo" id="tuner-undo" style="display:none"></div></div>';
  document.body.appendChild(modal);
  modal.addEventListener('mousedown', e=>{ if(e.target===modal) closeTuner(); });
  $('tuner-close').onclick=closeTuner;
  $('tuner-play').onclick=()=>{ if(_radioSelected) tunerPlay(_radioSelected); };
  $('tuner-search').addEventListener('input', e=>{ clearTimeout(_tunerSearchT); const q=e.target.value.trim();
    _tunerSearchT=setTimeout(()=>loadTunerStations(q), 350); });
  document.addEventListener('keydown', e=>{ if(e.key==='Escape' && $('tuner-modal') && $('tuner-modal').style.display==='flex') closeTuner(); });
}
function renderTunerTabs(){
  const c=$('tuner-tabs'); if(!c) return; c.innerHTML='';
  Object.keys(_radioGroups).forEach(k=>{
    const b=el('button','tuner-tab'+(k===_radioActive?' on':''), _radioGroups[k].name||k);
    b.title='Двойной клик — переименовать группу';
    b.onclick=()=>{ _radioActive=k; tunerSaveGroups(); renderTunerTabs(); $('tuner-search').value=''; renderSavedGroup(); };
    b.ondblclick=()=>tunerRenameTab(b,k);
    c.appendChild(b);
  });
}
function tunerRenameTab(btn,k){
  const inp=el('input','tuner-tab-edit'); inp.value=_radioGroups[k].name||k; inp.maxLength=14;
  btn.replaceWith(inp); inp.focus(); inp.select();
  let done=false;
  const finish=(save)=>{ if(done)return; done=true; if(save){ _radioGroups[k].name=(inp.value.trim()||k); tunerSaveGroups(); } renderTunerTabs(); };
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter') finish(true); if(e.key==='Escape') finish(false); });
  inp.addEventListener('blur',()=>finish(true));
}
// поиск пуст → сохранённые станции группы; есть запрос → результаты Radio Browser (добавление)
async function loadTunerStations(query){
  const grid=$('tuner-grid'); if(!grid) return;
  if(!query){ renderSavedGroup(); return; }
  grid.innerHTML='<div class="tuner-loading">…</div>';
  const url='https://de1.api.radio-browser.info/json/stations/search?hidebroken=true&order=votes&reverse=true&limit='+TUNER_MAX+'&name='+encodeURIComponent(query);
  try{ const r=await fetch(url); const list=await r.json(); renderTunerSearch(Array.isArray(list)?list:[]); }
  catch(e){ grid.innerHTML='<div class="tuner-loading">Нет сети или сервис недоступен</div>'; }
}
function tunerTile(station, opts){
  const tile=el('div','tuner-tile'+(opts.add?' add':''));
  const letter=((station.name||'?').trim()[0]||'?').toUpperCase();
  if(station.favicon){
    const img=el('img','tuner-logo'); img.src=station.favicon;
    img.onerror=()=>{ img.remove(); tile.classList.add('no-logo'); tile.dataset.letter=letter; };
    tile.appendChild(img);
  } else { tile.classList.add('no-logo'); tile.dataset.letter=letter; }
  tile.appendChild(el('div','tuner-name', station.name||'—'));
  if(opts.country) tile.appendChild(el('div','tuner-country', station.country||''));
  if(opts.removable){ const rm=el('button','tuner-rm','✕'); rm.onclick=(e)=>{ e.stopPropagation(); opts.onRemove(); }; tile.appendChild(rm); }
  tile.onclick=opts.onClick;
  // Двойной клик по сохранённой станции — сразу Play и закрытие дашборда.
  if(!opts.add){ tile.ondblclick=()=>{ tunerPlay(station); closeTuner(); }; }
  return tile;
}
function renderSavedGroup(){
  const grid=$('tuner-grid'); if(!grid) return; grid.innerHTML='';
  const g=_radioGroups[_radioActive]; const list=(g&&g.list)||[];
  if(!list.length){ grid.innerHTML='<div class="tuner-loading">Группа пуста. Найдите станции в поиске выше и нажмите, чтобы добавить.</div>'; return; }
  list.forEach((s,idx)=>{
    const tile=tunerTile(s,{ removable:true,
      onRemove:()=>tunerRemoveStation(_radioActive, idx),
      onClick:()=>{ _radioSelected=s; renderSavedGroup(); }   // клик = выбрать
    });
    const u=s.url_resolved||s.url;
    if(_radioSelected&&(_radioSelected.url_resolved||_radioSelected.url)===u) tile.classList.add('sel');
    if(u===_radioUrl) tile.classList.add('playing');
    grid.appendChild(tile);
  });
}
function renderTunerSearch(list){
  const grid=$('tuner-grid'); grid.innerHTML='';
  if(!list.length){ grid.innerHTML='<div class="tuner-loading">Ничего не найдено</div>'; return; }
  list.slice(0,TUNER_MAX).forEach(r=>{
    const station={ name:r.name||'—', url:r.url_resolved||r.url||'', favicon:r.favicon||'', country:r.countrycode||r.country||'' };
    grid.appendChild(tunerTile(station,{ add:true, country:true, onClick:()=>tunerAddToGroup(station) }));
  });
}
let _radioUndoTimer=null;
function tunerRemoveStation(key, idx){
  const g=_radioGroups[key]; if(!g||!g.list[idx]) return;
  const st=g.list[idx];
  const u=st.url_resolved||st.url;
  if(_radioSelected&&(_radioSelected.url_resolved||_radioSelected.url)===u) _radioSelected=null;
  g.list.splice(idx,1); tunerSaveGroups(); renderSavedGroup();
  showTunerUndo(st, key, idx);
}
function showTunerUndo(st, key, idx){
  const bar=$('tuner-undo'); if(!bar) return;
  bar.innerHTML=''; bar.style.display='flex';
  bar.appendChild(el('span',null,'Удалено: '));
  bar.appendChild(el('b',null, st.name||'станция'));
  const u=el('button',null,'Вернуть');
  u.onclick=()=>{ const g=_radioGroups[key]; if(g){ g.list.splice(Math.min(idx,g.list.length),0,st); tunerSaveGroups(); renderSavedGroup(); } hideTunerUndo(); };
  bar.appendChild(u);
  clearTimeout(_radioUndoTimer); _radioUndoTimer=setTimeout(hideTunerUndo, 6000);
}
function hideTunerUndo(){ const bar=$('tuner-undo'); if(bar){ bar.style.display='none'; bar.innerHTML=''; } clearTimeout(_radioUndoTimer); }
function tunerAddToGroup(station){
  const g=_radioGroups[_radioActive]; if(!g) return;
  if(g.list.some(x=>x.url===station.url)){ $('tuner-search').value=''; renderSavedGroup(); return; }
  if(g.list.length>=TUNER_MAX){ alert('В группе уже '+TUNER_MAX+' станций'); return; }
  g.list.push(station); tunerSaveGroups();
  $('tuner-search').value=''; renderSavedGroup();
}
let _radioUrl=null, _radioStation=null, _radioStart=0, _radioSong='', _radioCover=null;
let _srcSig=null;   // сигнатура активного источника (для авто-обновления после auto-follow)
let _radioWasActive=false;   // было ли радио активно (для сброса данных при его остановке)
let _radioCoverPushed=null;  // последняя обложка, переданная в движок (для мини-плеера)
let _radioPauseAt=0, _radioPausedAccum=0;   // учёт пауз радио для счётчика времени
// Сброс состояния радио в UI — вызывается при выборе обычного источника, чтобы
// в окне now-playing/формата не висели старые радио-данные (станция/обложка/трек).
function clearRadioState(){ _radioUrl=null; _radioStation=null; _radioSong=''; _radioCover=null; _lastArtId=null; _radioCoverPushed=null; }
async function fetchRadioCover(song){
  // Запрос к iTunes делаем в Python (в WebView fetch к iTunes блокируется CORS).
  try{
    if(API && API.radio_cover){ const u=await API.radio_cover(song); return u||null; }
  }catch(e){}
  return null;
}
function tunerPlay(s){
  const url=s.url_resolved||s.url; if(!url) return;
  if(_radioUrl===url){            // повторный клик по играющей станции — стоп/пауза
    _radioUrl=null; _radioStation=null;
    if(API&&API.tuner_stop) API.tuner_stop().then(refresh).catch(()=>{});
    renderSavedGroup();
    return;
  }
  _radioUrl=url; _radioStation=s; _radioStart=Date.now(); _radioPauseAt=0; _radioPausedAccum=0;
  _radioSelected=s;
  if(API&&API.set_ui) API.set_ui('radio_last', s);   // запомнить последнюю станцию
  // имя станции + лого передаём в движок — чтобы радио-now-playing был и у мини-плеера
  if(API&&API.tuner_play) API.tuner_play(url, s.name||'', s.favicon||'', s.codec||'', s.bitrate||0).then(refresh).catch(()=>{});
  renderSavedGroup();
}

function boot(){
  API = window.pywebview.api;
  wire();
  setupAutoFit();
  refresh().then(()=>{
    const u=(ST&&ST.ui)||{};
    // восстановить свёрнутые блоки
    const mods=u.mods||{};
    ['mod-player','mod-out','mod-src','mod-eq','mod-fx','mod-viz'].forEach(id=>{ if(mods[id]===false) setVis(id,false,false); });
    renderChooser();
    setLang(u.lang||'ru', false);
    setTheme(u.theme||'dark', false);
    setCols(u.cols||2, false);
    vizArtOn = !(u.viz_art===false);   // восстановить состояние тумблера обложки
    applyVizArtToggle();
  });
  setInterval(meterLoop, 80);   // 12.5 Гц — плавно для индикаторов, но меньше нагрузка на мост/аудио
}
if(window.pywebview && window.pywebview.api){ boot(); }
else { window.addEventListener('pywebviewready', boot); }
