/* ─── DS ZONE — AI AGENT CHAT (mic + text, Hinglish voice) ───────
   Floating 🤖 button — poore app me (chart screen + chain screen,
   localhost + phone app dono) dikhta hai.
   • Mic: SpeechRecognition (hi-IN) — bolo, jawab awaaz me sunao
   • Text: type karke poochho
   • Backend: /api/agent/chat — agent real data se jawab + auto-fix
   ─────────────────────────────────────────────────────────────── */
(function () {
  if (window.__dsChatInit) return;
  window.__dsChatInit = true;

  const css = `
#dsFab{position:fixed;right:12px;bottom:64px;width:52px;height:52px;border-radius:50%;background:#111a2e;border:1px solid #2b3a5e;color:#59c2ff;font-size:24px;display:flex;align-items:center;justify-content:center;cursor:pointer;z-index:9850;box-shadow:0 4px 14px rgba(0,0,0,.5);user-select:none}
#dsFab:active{transform:scale(.94)}
#dsFab .dot{position:absolute;top:2px;right:2px;width:10px;height:10px;border-radius:50%;background:#00D09C;border:2px solid #0a0a0f}
#dsBox{position:fixed;right:8px;bottom:124px;width:min(380px,calc(100vw - 16px));height:min(470px,calc(100vh - 210px));background:#0e0e16;border:1px solid #252535;border-radius:12px;display:none;flex-direction:column;z-index:9860;box-shadow:0 10px 34px rgba(0,0,0,.65);overflow:hidden}
#dsBox.open{display:flex}
.dc-hd{display:flex;align-items:center;gap:8px;padding:9px 11px;background:#111a2e;border-bottom:1px solid #252535;font-size:11px;font-weight:800;letter-spacing:.6px;color:#59c2ff}
.dc-hd .t{flex:1}
.dc-hd button{background:transparent;border:1px solid #2b3a5e;color:#88a;border-radius:6px;padding:3px 8px;font-size:13px;cursor:pointer;line-height:1}
.dc-hd button.on{color:#00D09C;border-color:#00D09C}
.dc-log{flex:1;overflow-y:auto;padding:9px;display:flex;flex-direction:column;gap:7px;background:#0a0a0f}
.dc-msg{max-width:88%;padding:7px 10px;border-radius:10px;font-size:12.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word}
.dc-msg.u{align-self:flex-end;background:#1d3a63;color:#dceaff;border-bottom-right-radius:3px}
.dc-msg.a{align-self:flex-start;background:#13271f;color:#c9f5e4;border-bottom-left-radius:3px;border:1px solid rgba(0,208,156,.25)}
.dc-msg.sys{align-self:center;background:#14141e;color:#667;font-size:10.5px;font-style:italic;text-align:center;max-width:95%}
.dc-typing{align-self:flex-start;color:#59c2ff;font-size:11px;padding:2px 6px}
.dc-chips{display:flex;gap:6px;overflow-x:auto;padding:7px 8px;background:#0e0e16;border-top:1px solid #1a1a28;scrollbar-width:none}
.dc-chips::-webkit-scrollbar{display:none}
.dc-chips button{flex:0 0 auto;background:#141422;border:1px solid #2b3a5e;color:#9ab;border-radius:20px;padding:5px 11px;font-size:11px;cursor:pointer;white-space:nowrap}
.dc-chips button:active{border-color:#00D09C;color:#00D09C}
.dc-in{display:flex;gap:7px;padding:8px;background:#111a2e;border-top:1px solid #252535;align-items:center}
#dsMic{width:40px;height:40px;flex:0 0 40px;border-radius:50%;background:#141422;border:1px solid #2b3a5e;color:#88a;font-size:17px;cursor:pointer;position:relative}
#dsMic.listening{background:#ff4757;border-color:#ff4757;color:#fff;animation:dcPulse 1s infinite}
@keyframes dcPulse{0%{box-shadow:0 0 0 0 rgba(255,71,87,.55)}70%{box-shadow:0 0 0 12px rgba(255,71,87,0)}100%{box-shadow:0 0 0 0 rgba(255,71,87,0)}}
#dsTxt{flex:1;background:#0a0a0f;border:1px solid #252535;color:#d1d4dc;border-radius:8px;padding:9px 10px;font-size:13px;outline:none;min-width:0}
#dsTxt:focus{border-color:#59c2ff}
#dsSend{width:40px;height:40px;flex:0 0 40px;border-radius:50%;background:#00D09C;border:none;color:#04231a;font-size:16px;font-weight:800;cursor:pointer}
.dc-vtip{font-size:9px;color:#556;padding:0 10px 5px;background:#111a2e}
`;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  const wrap = document.createElement('div');
  wrap.innerHTML =
    '<div id="dsFab" title="AI Agent se baat karo"><span>&#129302;</span><span class="dot"></span></div>' +
    '<div id="dsBox">' +
      '<div class="dc-hd"><span>&#129302; AI AGENT · SL DOCTOR</span><span class="t"></span>' +
        '<button id="dsVoice" title="Awaaz ON/OFF">&#128266;</button>' +
        '<button id="dsClose" title="Band karo">&#10005;</button></div>' +
      '<div class="dc-log" id="dsLog"></div>' +
      '<div class="dc-chips">' +
        '<button data-q="SL kyu ho raha hai?">SL kyu ho raha?</button>' +
        '<button data-q="Status batao">Status batao</button>' +
        '<button data-q="SL fix karo">SL fix karo</button>' +
        '<button data-q="आज market क्यों गिरा?">Market kyu gira?</button>' +
        '<button data-q="आज की news kya hai?">Aaj ki news</button>' +
        '<button data-q="FII kya kar raha hai?">FII/DII</button>' +
        '<button data-q="Kal ke events kya hain?">Kal ke events</button>' +
        '<button data-q="Kya tune kiya hai?">Kya tune kiya?</button>' +
        '<button data-q="30 minute ruk jao">30 min ruk jao</button>' +
        '<button data-q="Entry chalu karo">Entry chalu karo</button>' +
        '<button data-q="Reset karo">Reset</button>' +
      '</div>' +
      '<div class="dc-in">' +
        '<button id="dsMic" title="Mic se bolo">&#127908;</button>' +
        '<input id="dsTxt" type="text" placeholder="Ya type karo — SL kyu ho raha?" autocomplete="off">' +
        '<button id="dsSend" title="Bhejo">&#10148;</button>' +
      '</div>' +
      '<div class="dc-vtip" id="dsTip">Mic dabao aur bolo (Hindi/Hinglish) — jawab awaaz me milega</div>' +
    '</div>';
  while (wrap.firstChild) document.body.appendChild(wrap.firstChild);

  const $ = id => document.getElementById(id);
  const fab = $('dsFab'), box = $('dsBox'), log = $('dsLog'), input = $('dsTxt'),
    micBtn = $('dsMic'), sendBtn = $('dsSend'), voiceBtn = $('dsVoice'), closeBtn = $('dsClose'), tip = $('dsTip');

  // ── voice ON/OFF (persist) ──
  let voiceOn = localStorage.getItem('dsChatVoice') !== '0';
  const paintVoice = () => { voiceBtn.innerHTML = voiceOn ? '&#128266;' : '&#128263;'; voiceBtn.classList.toggle('on', voiceOn); };
  paintVoice();
  voiceBtn.onclick = () => {
    voiceOn = !voiceOn;
    localStorage.setItem('dsChatVoice', voiceOn ? '1' : '0');
    paintVoice();
    if (!voiceOn && window.speechSynthesis) speechSynthesis.cancel();
  };

  // ── messages ──
  function addMsg(kind, text) {
    const d = document.createElement('div');
    d.className = 'dc-msg ' + kind;
    d.textContent = text;
    d.style.whiteSpace = 'pre-line';   // STOP LOSS ANALYSIS block (multi-line) sahi dikhe
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    return d;
  }
  let typingEl = null;
  function showTyping() { if (!typingEl) { typingEl = document.createElement('div'); typingEl.className = 'dc-typing'; typingEl.textContent = 'Agent soch raha hai...'; log.appendChild(typingEl); log.scrollTop = log.scrollHeight; } }
  function hideTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  // ── speech OUT: jawab awaaz me bolo (Hindi voice mile to wahi) ──
  let voices = [];
  try {
    if (window.speechSynthesis) {
      voices = speechSynthesis.getVoices() || [];
      speechSynthesis.onvoiceschanged = () => { voices = speechSynthesis.getVoices() || []; };
    }
  } catch (e) {}
  function pickVoice() {
    return voices.find(v => /^hi/i.test(v.lang)) ||
      voices.find(v => /en[-_]IN/i.test(v.lang)) ||
      voices.find(v => /^en/i.test(v.lang)) || null;
  }
  function speak(text) {
    if (!voiceOn || !window.speechSynthesis) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(String(text).replace(/[·•|]/g, '.').slice(0, 450));
      u.lang = 'hi-IN';
      u.rate = 1;
      const v = pickVoice();
      if (v) u.voice = v;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  // ── send ──
  async function send(text) {
    text = String(text != null ? text : input.value).trim();
    if (!text) return;
    input.value = '';
    addMsg('u', text);
    showTyping();
    try {
      const r = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: text, tf: window.__dsTF || '' })
      });
      let j = null;
      try { j = await r.json(); } catch (e) {}
      hideTyping();
      if (r.ok && j && j.ok && j.a) { addMsg('a', j.a); speak(j.a); }
      else if (r.status === 404) addMsg('sys', 'Chat API nahi mila — server purana code chala raha hai. Server restart karo (node server.js), phir se try karo.');
      else addMsg('sys', 'Jawab nahi mila: ' + ((j && (j.error || j.a)) || ('HTTP ' + r.status)));
    } catch (e) {
      hideTyping();
      addMsg('sys', 'Server chalu nahi hai — ' + e.message);
    }
  }
  sendBtn.onclick = () => send();
  input.addEventListener('keydown', e => { if (e.key === 'Enter') send(); });
  document.querySelectorAll('.dc-chips button').forEach(b => { b.onclick = () => send(b.dataset.q); });

  // ── mic: SpeechRecognition (hi-IN) ──
  let rec = null, listening = false;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function stopMic() { try { rec && rec.stop(); } catch (e) {} listening = false; micBtn.classList.remove('listening'); }
  micBtn.onclick = () => {
    if (listening) { stopMic(); return; }
    if (!SR) {
      addMsg('sys', 'Is browser/WebView me mic support nahi — Chrome me kholo ya neeche type karo.');
      tip.textContent = 'Mic support nahi — type karke poochho';
      return;
    }
    try {
      rec = new SR();
      rec.lang = 'hi-IN';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onstart = () => { listening = true; micBtn.classList.add('listening'); tip.textContent = 'Sun raha hoon... bolo'; };
      rec.onresult = e => {
        const said = (e.results[0] && e.results[0][0] && e.results[0][0].transcript) || '';
        tip.textContent = 'Mic dabao aur bolo (Hindi/Hinglish) — jawab awaaz me milega';
        if (said) send(said);
      };
      rec.onerror = e => {
        tip.textContent = 'Mic error: ' + (e.error || '') + ' — permission do ya type karo';
        if (e.error === 'not-allowed' || e.error === 'service-not-allowed') addMsg('sys', 'Mic permission chahiye — browser setting me allow karo, tab tak type kar sakte ho.');
      };
      rec.onend = () => { listening = false; micBtn.classList.remove('listening'); };
      rec.start();
    } catch (e) {
      listening = false; micBtn.classList.remove('listening');
      addMsg('sys', 'Mic start nahi hua: ' + e.message);
    }
  };

  // ── open / close ──
  let greeted = false;
  fab.onclick = () => {
    const open = box.classList.toggle('open');
    fab.style.display = open ? 'none' : 'flex';
    if (open && !greeted) {
      greeted = true;
      addMsg('a', 'Namaste! Main AI SL agent hoon — jo TF kholo uska live zone + SL analysis bhi deta hoon. Mic dabao ya poochho: "1m me kya bana?", "SL kyu hua?" / "root cause bolo" (full STOP LOSS ROOT CAUSE + news check), "आज market क्यों गिरा?" (real news + global + FII/DII se MARKET MOVE ANALYSIS), "आज की news", "FII kya kar raha hai", "kal ke events", "pattern batao", "zone kaise bante hain" (aapki PDF se), "SL fix karo", "Status batao".');
    }
    if (open) setTimeout(() => input.focus(), 60);
  };
  closeBtn.onclick = () => {
    box.classList.remove('open');
    fab.style.display = 'flex';
    stopMic();
    if (window.speechSynthesis) speechSynthesis.cancel();
  };
})();
