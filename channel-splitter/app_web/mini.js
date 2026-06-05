/* Channel Splitter — mini player window (pywebview) */
'use strict';
let API=null;
const $=(id)=>document.getElementById(id);

function wire(){
  $('m-prev').onclick=()=>API.media_prev();
  $('m-play').onclick=()=>API.media_playpause();
  $('m-next').onclick=()=>API.media_next();
  $('m-stop').onclick=()=>API.media_stop();
  $('m-show').onclick=()=>{ if(API.show_main) API.show_main(); };
  $('m-hide').onclick=()=>{ if(API.hide_mini) API.hide_mini(); };
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
  }).catch(()=>{});
}
function boot(){ API=window.pywebview.api; wire(); setInterval(loop, 500); loop(); }
if(window.pywebview && window.pywebview.api){ boot(); }
else { window.addEventListener('pywebviewready', boot); }
