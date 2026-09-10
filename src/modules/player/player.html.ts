import { PlayerTrack } from './player.service';

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] as string);
}

export function buildPlayerHtml(track: PlayerTrack): string {
  // Keep metadata out of executable JavaScript. Escape '<' even inside JSON so
  // titles cannot terminate the application/json element with a </script> tag.
  const data = JSON.stringify(track).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return String.raw`<style>
.kt-player{box-sizing:border-box;max-width:480px;margin:12px auto;padding:20px;border:1px solid #255951;border-radius:20px;background:linear-gradient(145deg,#101d25,#10241e);color:#eefcf6;font:14px system-ui,sans-serif;box-shadow:0 12px 30px #0003}
.kt-player *{box-sizing:border-box}.kt-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.kt-brand{color:#70dcaf;font-size:10px;letter-spacing:2px;font-weight:700}.kt-status{font-size:11px;color:#b4d0c3}.kt-title{font-size:20px;line-height:1.3;margin:20px 0 5px;overflow-wrap:anywhere}.kt-artist{color:#a4bcb0;margin:0 0 18px}.kt-progress{width:100%;accent-color:#65dfac}.kt-time{display:flex;justify-content:space-between;font-size:11px;color:#a4bcb0;font-variant-numeric:tabular-nums;margin:4px 0 16px}.kt-controls{display:flex;align-items:center;gap:14px}.kt-play{border:0;border-radius:30px;background:#6ce7b2;color:#07271b;font:700 14px system-ui;padding:12px 24px;cursor:pointer}.kt-play:disabled{opacity:.55;cursor:wait}.kt-detail{font-size:12px;color:#a4bcb0;flex:1}.kt-link{display:inline-block;color:#80e2b7;font-size:11px;margin-top:18px}.kt-expiry{font-size:10px;color:#7c9d8d;margin-top:10px}.kt-player audio{display:none}
</style>
<section class="kt-player" aria-label="Pemutar musik Kotonehara">
<div class="kt-head"><span class="kt-brand">KOTONEHARA · MUSIC</span><span class="kt-status" data-role="status" role="status" aria-live="polite">Siap</span></div>
<h2 class="kt-title">${escapeHtml(track.title)}</h2><p class="kt-artist">${escapeHtml(track.artist)}</p>
<input class="kt-progress" data-role="seek" type="range" min="0" max="100" step="0.1" value="0" disabled aria-label="Posisi lagu">
<div class="kt-time"><span data-role="current">0:00</span><span data-role="duration">0:00</span></div>
<div class="kt-controls"><button class="kt-play" data-role="toggle" type="button">Putar</button><span class="kt-detail" data-role="detail">Ketuk Putar untuk memuat lagu.</span></div>
<a class="kt-link" href="${escapeHtml(track.playerUrl)}" target="_blank" rel="noopener noreferrer">Buka player di browser ↗</a>
<div class="kt-expiry" data-role="expiry"></div><audio preload="metadata" data-role="audio"></audio>
<script type="application/json" data-role="track">${data}</script>
<script>
(function(){
  var script=document.currentScript, root=script&&script.closest('.kt-player');
  if(!root)return;
  var find=function(name){return root.querySelector('[data-role="'+name+'"]');};
  var track=JSON.parse(find('track').textContent), audio=find('audio'), button=find('toggle'), seek=find('seek');
  var status=find('status'), detail=find('detail'), current=find('current'), duration=find('duration');
  var ws=null, loading=false, blobUrl=null, timer=null, attempt=0;
  var maxBytes=24*1024*1024, maxChunks=Math.ceil(maxBytes/65536), expires=Date.parse(track.expiresAt);
  function fmt(n){if(!Number.isFinite(n)||n<0)return '0:00';return Math.floor(n/60)+':'+String(Math.floor(n%60)).padStart(2,'0');}
  duration.textContent=fmt(track.duration);
  find('expiry').textContent='Sesi tersedia hingga '+new Date(expires).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  function stopTransfer(){clearTimeout(timer);timer=null;if(ws){ws.onmessage=ws.onclose=ws.onerror=null;ws.close();ws=null;}}
  function resetAudio(){audio.pause();audio.removeAttribute('src');audio.load();seek.disabled=true;if(blobUrl){URL.revokeObjectURL(blobUrl);blobUrl=null;}}
  function fail(message){attempt++;loading=false;stopTransfer();button.disabled=false;button.textContent='Coba lagi';status.textContent='Gagal';detail.textContent=message;}
  function syncPlayback(){button.textContent=audio.paused?'Putar':'Jeda';status.textContent=audio.ended?'Selesai':audio.paused?'Jeda':'Memutar';}
  async function play(){
    try{await audio.play();syncPlayback();detail.textContent='Lagu siap diputar.';}
    catch(error){button.disabled=false;button.textContent='Putar';status.textContent='Siap';detail.textContent=error&&error.name==='NotAllowedError'?'Ketuk Putar sekali lagi untuk mulai.':'Audio tidak dapat diputar di perangkat ini.';}
  }
  button.onclick=function(){
    if(loading)return;
    if(blobUrl){if(!audio.paused){audio.pause();syncPlayback();}else{if(audio.ended)audio.currentTime=0;void play();}return;}
    if(!Number.isFinite(expires)||Date.now()>=expires){fail('Sesi kedaluwarsa. Jalankan playws lagi.');return;}
    loading=true;button.disabled=true;button.textContent='Memuat…';status.textContent='Menghubungkan';detail.textContent='Menyiapkan audio…';
    var seq=++attempt, started=false, done=false, chunks=[], received=0, bytes=0, expected=0, total=0, mime='audio/mpeg';
    timer=setTimeout(function(){if(seq===attempt)fail('Waktu memuat habis. Silakan coba lagi.');},120000);
    try{ws=new WebSocket(track.wsUrl);ws.binaryType='arraybuffer';}catch(error){fail('Koneksi player tidak dapat dibuka. Coba tautan browser.');return;}
    ws.onopen=function(){status.textContent='Memuat';};
    ws.onmessage=function(event){
      if(seq!==attempt)return;
      try{
        if(typeof event.data==='string'){
          var msg=JSON.parse(event.data);
          if(msg.type==='error'){fail(typeof msg.message==='string'?msg.message:'Sesi tidak tersedia.');return;}
          if(msg.type==='start'){
            if(started||!Number.isInteger(msg.totalChunks)||msg.totalChunks<1||msg.totalChunks>maxChunks||!Number.isInteger(msg.size)||msg.size<1||msg.size>maxBytes||msg.size!==track.size||msg.totalChunks!==Math.ceil(msg.size/65536)||msg.mimeType!==track.mimeType)throw new Error('Invalid start');
            started=true;total=msg.totalChunks;expected=msg.size;mime=msg.mimeType;chunks=new Array(total);return;
          }
          if(msg.type==='end'){
            if(!started||done||received!==total||bytes!==expected)throw new Error('Incomplete audio');
            done=true;loading=false;stopTransfer();blobUrl=URL.createObjectURL(new Blob(chunks,{type:mime}));chunks=[];audio.src=blobUrl;button.disabled=false;status.textContent='Siap';void play();return;
          }
          throw new Error('Unknown message');
        }
        if(!started||done||!(event.data instanceof ArrayBuffer)||event.data.byteLength<5||event.data.byteLength>65540)throw new Error('Invalid frame');
        var index=new DataView(event.data).getUint32(0), part=event.data.slice(4);
        if(index>=total||chunks[index]!==undefined||part.byteLength!==Math.min(65536,expected-index*65536)||bytes+part.byteLength>expected)throw new Error('Invalid chunk');
        chunks[index]=part;received++;bytes+=part.byteLength;detail.textContent='Memuat '+Math.floor(bytes/expected*100)+'%';
      }catch(error){fail('Audio yang diterima tidak lengkap atau tidak valid. Coba lagi.');}
    };
    ws.onerror=function(){if(seq===attempt)fail('Koneksi gagal. Pastikan alamat player dapat diakses, lalu coba tautan browser.');};
    ws.onclose=function(event){if(seq===attempt&&!done)fail(event.code===1008?'Sesi kedaluwarsa atau tidak tersedia. Jalankan playws lagi.':'Koneksi terputus sebelum audio selesai.');};
  };
  audio.onloadedmetadata=function(){duration.textContent=fmt(audio.duration);seek.disabled=!Number.isFinite(audio.duration)||audio.duration<=0;};
  audio.ontimeupdate=function(){current.textContent=fmt(audio.currentTime);if(Number.isFinite(audio.duration)&&audio.duration>0)seek.value=String(audio.currentTime/audio.duration*100);};
  audio.onpause=audio.onplay=syncPlayback;audio.onended=function(){syncPlayback();detail.textContent='Ketuk Putar untuk mengulang.';};
  audio.onerror=function(){resetAudio();fail('Format audio tidak dapat diputar. Coba lagi atau buka player di browser.');};
  seek.oninput=function(){if(!seek.disabled&&Number.isFinite(audio.duration))audio.currentTime=audio.duration*Number(seek.value)/100;};
  window.addEventListener('pagehide',function(){attempt++;stopTransfer();resetAudio();loading=false;button.disabled=false;button.textContent='Putar';status.textContent='Siap';});
})();
</script></section>`;
}
