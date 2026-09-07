/*!
 * Throttled In Bond — shared VIN-TAGe label scanner
 * ONE source of truth for the camera scanner + photo-upload OCR, used by BOTH the main
 * site and the /TIB-VIP/ page. Edit this file once and bump ?v= in each page's <script>
 * tag to roll the update everywhere.
 *
 * Each page provides only:
 *   - a global function  vinFill(code)            (fills the decoder / renders the report)
 *   - an element         #vin-ocr-status          (status line for the photo-upload path)
 *   - an element         #label-input (file)      (optional; pickLabel() clicks it)
 * Everything else (the scan modal markup, styles, OCR pipeline) lives here.
 *
 * Public (window) functions, callable from inline onclick / page buttons:
 *   scanStart()  scanStop()  scanTick(manual)  toggleTorch()  pickLabel()  handleLabel(file)
 */
(function(){
  if (window.__TIB_SCANNER__) return;   // guard against double-loading
  window.__TIB_SCANNER__ = true;
  var VER = 'v10';

  /* ---------- valid releases (self-contained; the resolver's only data) ---------- */
  var SCAN_CODES = {
    'TIB 26 FS G1 00001': { proof:'117.8', mashBill:[{k:'C',p:74},{k:'R',p:18},{k:'W',p:0},{k:'MB',p:8}] },
    'TIB 26 CS G1 00002': { proof:'108.2', mashBill:[{k:'C',p:64},{k:'R',p:24},{k:'W',p:0},{k:'MB',p:12}] },
    'TIB 26 BF G1 00003': { proof:'PNDG',  mashBill:[{k:'C',p:0}, {k:'R',p:0}, {k:'W',p:0},{k:'MB',p:0}] }
  };

  /* ---------- inject styles (hardcoded colors so it works on any page) ---------- */
  var CSS = [
    ".scan-modal{position:fixed;inset:0;z-index:999;background:rgba(10,10,9,.94);display:none;align-items:center;justify-content:center;padding:16px;}",
    ".scan-modal.open{display:flex;}",
    ".scan-box{position:relative;width:min(520px,96vw);background:#242220;border:1px solid #3E3B35;border-top:2px solid #C8952A;overflow:hidden;font-family:inherit;}",
    ".scan-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #3E3B35;}",
    ".scan-title{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#C8952A;font-weight:600;}",
    ".scan-close{background:none;border:none;color:#D6CCBA;font-size:22px;line-height:1;cursor:pointer;padding:0 4px;}",
    ".scan-close:hover{color:#C8952A;}",
    ".scan-vidwrap{position:relative;background:#000;width:100%;aspect-ratio:3/4;max-height:58vh;overflow:hidden;}",
    ".scan-vidwrap video{width:100%;height:100%;object-fit:cover;display:block;}",
    ".scan-frame{position:absolute;left:5%;right:5%;top:28%;height:44%;border:2px solid #E8B84B;border-radius:14px;box-shadow:0 0 0 2000px rgba(0,0,0,.28);pointer-events:none;transition:border-color .2s;}",
    "@keyframes scanpulse{0%,100%{border-color:rgba(232,184,75,.55);box-shadow:0 0 0 2000px rgba(0,0,0,.35),0 0 0 0 rgba(232,184,75,0);}50%{border-color:#F0D488;box-shadow:0 0 0 2000px rgba(0,0,0,.30),0 0 16px 2px rgba(232,184,75,.55);}}",
    ".scan-frame.scanning{animation:scanpulse 1.15s ease-in-out infinite;}",
    ".scan-frame:before{content:'Get the VIN-TAGe code inside the box';position:absolute;left:0;right:0;top:-22px;text-align:center;font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:#E8B84B;text-shadow:0 1px 3px rgba(0,0,0,.9);}",
    ".scan-progress{position:absolute;left:0;right:0;bottom:12px;text-align:center;font-size:clamp(12px,3.6vw,16px);font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#E8B84B;text-shadow:0 1px 6px rgba(0,0,0,.95);opacity:0;pointer-events:none;}",
    ".scan-frame.scanning ~ .scan-progress{animation:scanprog 1.3s ease-in-out infinite;}",
    "@keyframes scanprog{0%,100%{opacity:.12}50%{opacity:.55}}",
    ".scan-torch{display:none;}",
    ".scan-foot{padding:12px 14px;}",
    ".scan-status{font-size:12px;color:#E8B84B;min-height:16px;margin-bottom:10px;text-align:center;line-height:1.5;}",
    ".scan-status.ok{color:#8FD891;font-weight:600;}",
    ".scan-status.err{color:#E88A6A;}",
    ".scan-actions{display:flex;gap:8px;}",
    ".scan-btn{flex:1;font-family:inherit;font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;padding:12px 10px;cursor:pointer;border:1px solid #C8952A;background:#C8952A;color:#1A1917;}",
    ".scan-btn:hover{background:#E8B84B;border-color:#E8B84B;}",
    ".scan-btn.ghost{background:transparent;color:#C8952A;}",
    ".scan-btn.ghost:hover{background:transparent;color:#E8B84B;border-color:#E8B84B;}",
    ".scan-note{font-size:9px;color:#9A9186;text-transform:uppercase;letter-spacing:.08em;text-align:center;margin-top:10px;}"
  ].join("");
  var st = document.createElement('style'); st.setAttribute('data-tib-scanner', VER); st.textContent = CSS;
  document.head.appendChild(st);

  /* ---------- inject the scan modal ---------- */
  var MODAL_HTML =
    '<div class="scan-modal" id="scan-modal">' +
    ' <div class="scan-box">' +
    '  <div class="scan-head"><span class="scan-title">Scan Bottle Label</span>' +
    '   <button class="scan-close" onclick="scanStop()" aria-label="Close">&times;</button></div>' +
    '  <div class="scan-vidwrap">' +
    '   <video id="scan-video" playsinline muted autoplay></video>' +
    '   <div class="scan-frame"></div>' +
    '   <div class="scan-progress">VIN-TAGe Scan In Progress</div>' +
    '  </div>' +
    '  <div class="scan-foot">' +
    '   <div class="scan-status" id="scan-status">Starting camera&hellip;</div>' +
    '   <div class="scan-actions">' +
    '    <button class="scan-btn" onclick="scanTick(true)">Capture Now</button>' +
    '    <button class="scan-btn ghost scan-torch" id="scan-torch" onclick="toggleTorch()">Light</button>' +
    '    <button class="scan-btn ghost" onclick="scanStop()">Cancel</button>' +
    '   </div>' +
    '   <div class="scan-note">Runs on your device &middot; the photo is not uploaded or saved &middot; scanner ' + VER + '</div>' +
    '  </div>' +
    ' </div>' +
    '</div>';
  function injectModal(){
    if (document.getElementById('scan-modal')) return;
    var d = document.createElement('div'); d.innerHTML = MODAL_HTML;
    document.body.appendChild(d.firstChild);
  }
  if (document.body) injectModal(); else document.addEventListener('DOMContentLoaded', injectModal);

  /* ---------- Tesseract loader ---------- */
  var _tessLoading = null;
  function loadTesseract(){
    if (window.Tesseract) return Promise.resolve();
    if (_tessLoading) return _tessLoading;
    _tessLoading = new Promise(function(res,rej){ var s=document.createElement('script'); s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js'; s.onload=res; s.onerror=rej; document.head.appendChild(s); });
    return _tessLoading;
  }

  /* ---------- forgiving resolver (snap OCR text to a valid VIN-TAGe) ---------- */
  function scanCanon(s){
    return String(s||'').toUpperCase().replace(/[^A-Z0-9]/g,'')
      .replace(/[OQ]/g,'0').replace(/[IL*|]/g,'1').replace(/S/g,'5').replace(/B/g,'8').replace(/Z/g,'2');
  }
  function _lev(a,b){
    var m=a.length,n=b.length; if(!m)return n; if(!n)return m;
    var prev=new Array(n+1),cur=new Array(n+1),i,j;
    for(j=0;j<=n;j++)prev[j]=j;
    for(i=1;i<=m;i++){ cur[0]=i; for(j=1;j<=n;j++){ var c=a.charAt(i-1)===b.charAt(j-1)?0:1; cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+c); } var t=prev;prev=cur;cur=t; }
    return prev[n];
  }
  function bestMatch(ocrText){
    var codes=Object.keys(SCAN_CODES);
    var t=scanCanon(ocrText); if(t.length<4) return null;
    var best=null,bestD=99;
    codes.forEach(function(code){
      var c=scanCanon(code),L=c.length,w,i,d;
      for(w=Math.max(4,L-1);w<=L+1;w++){ for(i=0;i+w<=t.length;i++){ d=_lev(t.substr(i,w),c); if(d<bestD){bestD=d;best=code;} } }
      d=_lev(t,c); if(d<bestD){bestD=d;best=code;}
    });
    return bestD<=3 ? best : null;
  }
  function _proofDigits(p){ return String(p||'').replace(/[^0-9]/g,''); }
  function _sig(code){
    var b=SCAN_CODES[code], toks=[], pf=_proofDigits(b.proof);
    if(pf.length>=3) toks.push({t:scanCanon(pf),w:2});
    (b.mashBill||[]).forEach(function(g){ if(g.p>0) toks.push({t:scanCanon(g.k+g.p),w:1}); });
    return toks;
  }
  function resolveRelease(text){
    var code=bestMatch(text); if(code) return code;
    var t=scanCanon(text); if(t.length<4) return null;
    var codes=Object.keys(SCAN_CODES), best=null, bestS=0, second=0;
    codes.forEach(function(c){
      var s=0; _sig(c).forEach(function(o){ if(o.t && t.indexOf(o.t)>=0) s+=o.w; });
      if(s>bestS){ second=bestS; bestS=s; best=c; } else if(s>second){ second=s; }
    });
    return (bestS>=2 && bestS>second) ? best : null;
  }

  /* ---------- image preprocessing ---------- */
  function _otsu(d){
    var hist=new Array(256),i; for(i=0;i<256;i++)hist[i]=0;
    var tot=d.length/4; for(i=0;i<d.length;i+=4) hist[d[i]]++;
    var sum=0; for(i=0;i<256;i++) sum+=i*hist[i];
    var sumB=0,wB=0,wF,mB,mF,v,mx=0,thr=127;
    for(i=0;i<256;i++){ wB+=hist[i]; if(!wB)continue; wF=tot-wB; if(!wF)break; sumB+=i*hist[i]; mB=sumB/wB; mF=(sum-sumB)/wF; v=wB*wF*(mB-mF)*(mB-mF); if(v>mx){mx=v;thr=i;} }
    return thr;
  }
  function _rotCanvasDeg(src,deg){
    if(!deg) return src;
    var rad=deg*Math.PI/180,s=Math.abs(Math.sin(rad)),c=Math.abs(Math.cos(rad));
    var w=src.width,h=src.height,W=Math.round(w*c+h*s),H=Math.round(w*s+h*c);
    var o=document.createElement('canvas'); o.width=W; o.height=H;
    var x=o.getContext('2d'); x.fillStyle='#808080'; x.fillRect(0,0,W,H);
    x.translate(W/2,H/2); x.rotate(rad); x.drawImage(src,-w/2,-h/2); return o;
  }
  function _cropCanvasFrom(source,sw,sh,fx,fy,fw,fh,targetW,prep,rotDeg){
    if(!sw||!sh) return null;
    var cx=Math.round(sw*fx),cw=Math.round(sw*fw),cy=Math.round(sh*fy),ch=Math.round(sh*fh);
    var scale=targetW/cw; if(scale>2)scale=2; if(scale<0.4)scale=0.4;
    var W=Math.max(48,Math.round(cw*scale)),H=Math.max(24,Math.round(ch*scale));
    var cvs=document.createElement('canvas'); cvs.width=W; cvs.height=H;
    var ctx=cvs.getContext('2d'); ctx.imageSmoothingEnabled=true; ctx.imageSmoothingQuality='high';
    ctx.drawImage(source,cx,cy,cw,ch,0,0,W,H);
    var img=ctx.getImageData(0,0,W,H),d=img.data,i,g,mn=255,mx=0;
    for(i=0;i<d.length;i+=4){ g=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])|0; d[i]=d[i+1]=d[i+2]=g; if(g<mn)mn=g; if(g>mx)mx=g; }
    if(prep==='otsu'){ var thr=_otsu(d); for(i=0;i<d.length;i+=4){ g=d[i]>thr?255:0; d[i]=d[i+1]=d[i+2]=g; } }
    else { var rng=(mx-mn)||1; for(i=0;i<d.length;i+=4){ g=((d[i]-mn)*255/rng)|0; d[i]=d[i+1]=d[i+2]=g; } }
    ctx.putImageData(img,0,0);
    return rotDeg?_rotCanvasDeg(cvs,rotDeg):cvs;
  }
  function _cropCanvas(v,fx,fy,fw,fh,targetW,prep,rotDeg){
    return _cropCanvasFrom(v,v.videoWidth,v.videoHeight,fx,fy,fw,fh,targetW,prep,rotDeg);
  }

  /* ---------- attempt recipes ---------- */
  var _scanPi=0,_scanEi=0,_scanPsm='6';
  var SCAN_PRIMARY=[
    {fy:0.42,fh:0.14,prep:'otsu',  psm:'11',rot:0},
    {fy:0.42,fh:0.16,prep:'minmax',psm:'6', rot:0},
    {fy:0.42,fh:0.14,prep:'minmax',psm:'11',rot:0}
  ];
  var SCAN_ATTEMPTS=[
    {fy:0.42,fh:0.14,prep:'otsu',  psm:'11',rot:0},
    {fy:0.42,fh:0.14,prep:'minmax',psm:'11',rot:0},
    {fy:0.42,fh:0.16,prep:'minmax',psm:'6', rot:0},
    {fy:0.42,fh:0.20,prep:'otsu',  psm:'6', rot:0},
    {fy:0.30,fh:0.14,prep:'otsu',  psm:'11',rot:0},
    {fy:0.54,fh:0.14,prep:'minmax',psm:'11',rot:0},
    {fy:0.18,fh:0.14,prep:'otsu',  psm:'11',rot:0},
    {fy:0.66,fh:0.14,prep:'minmax',psm:'11',rot:0},
    {fy:0.42,fh:0.14,prep:'otsu',  psm:'6', rot:-12},
    {fy:0.42,fh:0.14,prep:'otsu',  psm:'6', rot:12},
    {fy:0.10,fh:0.14,prep:'otsu',  psm:'11',rot:0}
  ];

  /* ---------- camera scanner ---------- */
  var _scanStream=null,_scanTimer=null,_scanBusy=false,_scanWorker=null,_torchTrack=null,_torchOn=false,_scanDone=false;
  function _scanFrame(){ return document.querySelector('.scan-frame'); }
  function setScanStatus(t,err){ var e=document.getElementById('scan-status'); if(e){ e.className='scan-status'+(err?' err':''); e.textContent=t; } }

  async function scanStart(){
    var modal=document.getElementById('scan-modal'); if(!modal){ injectModal(); modal=document.getElementById('scan-modal'); }
    modal.classList.add('open');
    setScanStatus('Starting camera…');
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ setScanStatus('This browser can’t open the camera. Use “Upload a Photo Instead.”',true); return; }
    try{ _scanStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'},width:{ideal:1920},height:{ideal:1080}},audio:false}); }
    catch(e){ setScanStatus('Camera blocked. Allow camera access, or use “Upload a Photo Instead.”',true); return; }
    var v=document.getElementById('scan-video'); v.srcObject=_scanStream; try{ await v.play(); }catch(e){}
    try{ _torchTrack=_scanStream.getVideoTracks()[0]; var caps=(_torchTrack&&_torchTrack.getCapabilities)?_torchTrack.getCapabilities():{}; var tb=document.getElementById('scan-torch'); if(tb) tb.style.display=(caps&&caps.torch)?'block':'none'; _torchOn=false; }catch(e){}
    try{
      await loadTesseract();
      if(!_scanWorker){ setScanStatus('Loading scanner…'); _scanWorker=await Tesseract.createWorker('eng'); await _scanWorker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ',tessedit_pageseg_mode:'6'}); }
    }catch(e){ setScanStatus('Scanner couldn’t load (needs internet). Use “Upload a Photo Instead.”',true); return; }
    _scanDone=false;
    var fr=_scanFrame(); if(fr){ fr.classList.remove('ok'); fr.classList.add('scanning'); }
    setScanStatus('Scanning… get the VIN-TAGe code inside the box');
    if(_scanTimer) clearInterval(_scanTimer);
    _scanTimer=setInterval(function(){ scanTick(false); }, 350);
  }

  async function _scanAttemptRun(v,a){
    if(a.psm!==_scanPsm){ try{ await _scanWorker.setParameters({tessedit_pageseg_mode:a.psm}); _scanPsm=a.psm; }catch(e){} }
    var c=_cropCanvas(v,0.05,a.fy,0.90,a.fh,1500,a.prep,a.rot||0);
    if(!c) return {code:null,raw:''};
    var r=await _scanWorker.recognize(c); var raw=(r&&r.data&&r.data.text)||'';
    return {code:resolveRelease(raw),raw:raw};
  }

  async function scanTick(manual){
    if(_scanBusy || !_scanWorker || _scanDone) return;
    var v=document.getElementById('scan-video'); if(!v||!v.videoWidth) return;
    _scanBusy=true;
    try{
      var lastRaw='', queue;
      if(manual){ queue=SCAN_PRIMARY.concat(SCAN_ATTEMPTS); }
      else { queue=[ SCAN_PRIMARY[_scanPi++ % SCAN_PRIMARY.length], SCAN_ATTEMPTS[_scanEi++ % SCAN_ATTEMPTS.length] ]; }
      for(var k=0;k<queue.length && !_scanDone;k++){
        var res=await _scanAttemptRun(v,queue[k]); if(res.raw) lastRaw=res.raw;
        if(res.code){ onDecoded(res.code); break; }
      }
      if(!_scanDone && manual){ var dbg=(lastRaw||'').replace(/\s+/g,' ').trim().slice(0,44); setScanStatus('Couldn’t match it yet. Read: “'+(dbg||'(nothing)')+'” — get the VIN-TAGe code inside the box, hold steady, avoid glare.',true); }
    }catch(e){ if(manual) setScanStatus('Scan error — try again.',true); }
    finally{ _scanBusy=false; }
  }

  function onDecoded(code){
    if(_scanDone) return; _scanDone=true;
    if(_scanTimer){ clearInterval(_scanTimer); _scanTimer=null; }
    if(_scanStream){ _scanStream.getTracks().forEach(function(t){ t.stop(); }); _scanStream=null; }
    var fr=_scanFrame(); if(fr){ fr.classList.remove('scanning'); fr.classList.add('ok'); }
    var st2=document.getElementById('scan-status'); if(st2){ st2.className='scan-status ok'; st2.textContent='Decoded ✓  '+code; }
    setTimeout(function(){ finalizeScan(code); }, 850);
  }
  function finalizeScan(code){
    var modal=document.getElementById('scan-modal'); if(modal) modal.classList.remove('open');
    var fr=_scanFrame(); if(fr) fr.classList.remove('ok');
    var v=document.getElementById('scan-video'); if(v) v.srcObject=null;
    _torchTrack=null; _torchOn=false; var tb=document.getElementById('scan-torch'); if(tb){ tb.style.display='none'; tb.textContent='Light'; }
    var os=document.getElementById('vin-ocr-status'); if(os){ os.className='vin-ocr-status'; os.textContent='Decoded ✓  '+code; }
    if(typeof window.vinFill==='function') window.vinFill(code);
  }
  function toggleTorch(){
    if(!_torchTrack) return; _torchOn=!_torchOn;
    try{ _torchTrack.applyConstraints({advanced:[{torch:_torchOn}]}); }catch(e){}
    var tb=document.getElementById('scan-torch'); if(tb) tb.textContent=_torchOn?'Light On':'Light';
  }
  function scanStop(){
    _scanDone=true;
    if(_scanTimer){ clearInterval(_scanTimer); _scanTimer=null; }
    if(_scanStream){ _scanStream.getTracks().forEach(function(t){ t.stop(); }); _scanStream=null; }
    _torchTrack=null; _torchOn=false;
    var tb=document.getElementById('scan-torch'); if(tb){ tb.style.display='none'; tb.textContent='Light'; }
    var fr=_scanFrame(); if(fr){ fr.classList.remove('scanning'); fr.classList.remove('ok'); }
    var v=document.getElementById('scan-video'); if(v) v.srcObject=null;
    var modal=document.getElementById('scan-modal'); if(modal) modal.classList.remove('open');
  }

  /* ---------- photo-upload path ---------- */
  function pickLabel(){ var el=document.getElementById('label-input'); if(el) el.click(); }
  async function _ocrImageResolve(base){
    await loadTesseract();
    if(!_scanWorker){ _scanWorker=await Tesseract.createWorker('eng'); await _scanWorker.setParameters({tessedit_char_whitelist:'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ',tessedit_pageseg_mode:'6'}); _scanPsm='6'; }
    var sw=base.width, sh=base.height, i, a, c, r, code;
    for(i=0;i<SCAN_ATTEMPTS.length;i++){
      a=SCAN_ATTEMPTS[i];
      if(a.psm!==_scanPsm){ try{ await _scanWorker.setParameters({tessedit_pageseg_mode:a.psm}); _scanPsm=a.psm; }catch(e){} }
      c=_cropCanvasFrom(base,sw,sh,0.05,a.fy,0.90,a.fh,1500,a.prep,a.rot||0);
      if(!c) continue;
      r=await _scanWorker.recognize(c); code=resolveRelease((r&&r.data&&r.data.text)||'');
      if(code) return code;
    }
    try{ await _scanWorker.setParameters({tessedit_pageseg_mode:'11'}); _scanPsm='11'; }catch(e){}
    c=_cropCanvasFrom(base,sw,sh,0,0,1,1,1900,'otsu',0);
    if(c){ r=await _scanWorker.recognize(c); code=resolveRelease((r&&r.data&&r.data.text)||''); if(code) return code; }
    return null;
  }
  function handleLabel(file){
    if(!file) return;
    var status=document.getElementById('vin-ocr-status');
    if(status){ status.className='vin-ocr-status'; status.textContent='Reading the label on your device…'; }
    var url=URL.createObjectURL(file);
    var img=new Image();
    img.onerror=function(){ URL.revokeObjectURL(url); if(status){ status.className='vin-ocr-status err'; status.textContent='Couldn’t open that image. Try another photo, or type the code above.'; } };
    img.onload=function(){
      var maxW=2200, sc=(img.naturalWidth>maxW)?(maxW/img.naturalWidth):1;
      var cw=Math.max(1,Math.round(img.naturalWidth*sc)), ch=Math.max(1,Math.round(img.naturalHeight*sc));
      var base=document.createElement('canvas'); base.width=cw; base.height=ch;
      base.getContext('2d').drawImage(img,0,0,cw,ch);
      URL.revokeObjectURL(url);
      _ocrImageResolve(base).then(function(code){
        if(code){ if(status){ status.className='vin-ocr-status'; status.textContent='Read ✓  '+code; } if(typeof window.vinFill==='function') window.vinFill(code); }
        else if(status){ status.className='vin-ocr-status err'; status.textContent='Couldn’t read the VIN-TAGe clearly. Try a straighter, closer photo of just the code and avoid glare — or type it above.'; }
      }).catch(function(){
        if(status){ status.className='vin-ocr-status err'; status.textContent='Label reader couldn’t load (needs an internet connection). You can still type the code above.'; }
      });
    };
    img.src=url;
  }

  /* ---------- expose the functions pages / inline handlers call ---------- */
  window.scanStart=scanStart; window.scanStop=scanStop; window.scanTick=scanTick;
  window.toggleTorch=toggleTorch; window.pickLabel=pickLabel; window.handleLabel=handleLabel;
  window.TIBScannerVersion=VER;
})();
