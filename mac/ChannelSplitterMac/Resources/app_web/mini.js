/* Channel Splitter — mini player window */
'use strict';
let API=null;
const $=(id)=>document.getElementById(id);
let lastArt=null;

function wire(){
  $('m-prev').onclick=()=>API.media_prev();
  $('m-play').onclick=()=>API.media_playpause();
  $('m-next').onclick=()=>API.media_next();
  $('m-stop').onclick=()=>API.media_stop();
  $('m-show').onclick=()=>{ if(API.show_main) API.show_main(); };
  $('m-hide').onclick=()=>{ if(API.hide_mini) API.hide_mini(); };

  // Свободное перетаскивание окна (WKWebView не понимает -webkit-app-region:drag,
  // поэтому двигаем окно через мост по дельте курсора в экранных координатах).
  const drag=document.querySelector('.drag');
  let on=false, lx=0, ly=0;
  drag.addEventListener('pointerdown', e=>{
    if(e.target.closest('button')) return;        // кнопки не перетаскивают
    on=true; lx=e.screenX; ly=e.screenY;
    try{ drag.setPointerCapture(e.pointerId); }catch(_){}
  });
  drag.addEventListener('pointermove', e=>{
    if(!on) return;
    const dx=e.screenX-lx, dy=e.screenY-ly; lx=e.screenX; ly=e.screenY;
    if(dx||dy){ if(API&&API.mini_move) API.mini_move(dx,dy); }
  });
  const stop=()=>{ on=false; };
  drag.addEventListener('pointerup', stop);
  drag.addEventListener('pointercancel', stop);
}

function setArt(url){
  const im=$('m-art'); if(!im) return;
  if(url){ im.src=url; im.style.display='block'; } else { im.removeAttribute('src'); im.style.display='none'; }
}
function updateArt(artId){
  if(artId===lastArt) return; lastArt=artId;
  if(!artId){ setArt(null); return; }
  if(API.now_playing_art) API.now_playing_art().then(setArt).catch(()=>{});
}

function loop(){
  if(!API) return;
  API.meters().then(m=>{
    if(!m||!m.np) return;
    const np=m.np;
    $('m-title').textContent = np.title || '—';
    $('m-sub').textContent = np.sub || '';
    $('m-cur').textContent = np.cur || '0:00';
    $('m-tot').textContent = np.total || '0:00';
    $('m-dot').classList.toggle('on', !!np.title);
    updateArt(np.art_id || '');
  }).catch(()=>{});
}
function boot(){ API=window.pywebview.api; wire(); setInterval(loop, 500); loop(); }
if(window.pywebview && window.pywebview.api){ boot(); }
else { window.addEventListener('pywebviewready', boot); }
