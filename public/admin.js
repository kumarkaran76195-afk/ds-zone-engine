/* Karan — Admin panel */
let admPass = localStorage.getItem('ds_admin_pass') || '';
let allUsers = [];

function admMsg(m) { const el = document.getElementById('admMsg'); if (el) el.textContent = m || ''; setTimeout(() => { if (el && el.textContent === m) el.textContent = ''; }, 2500); }

async function admFetch(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({}, opts.headers, { 'X-Admin-Pass': admPass });
  const r = await fetch(url, opts);
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { showGate('Galat password'); throw new Error('auth'); }
  return d;
}

function showGate(err) {
  document.getElementById('admGate').style.display = 'block';
  document.getElementById('adminApp').style.display = 'none';
  document.getElementById('gateErr').textContent = err || '';
}

function showApp() {
  document.getElementById('admGate').style.display = 'none';
  document.getElementById('adminApp').style.display = 'block';
}

async function loadAll() {
  const st = await admFetch('/api/admin/stats');
  document.getElementById('stTotal').textContent = st.total;
  document.getElementById('stPaid').textContent = st.paid;
  document.getElementById('stActive').textContent = st.active;
  const ud = await admFetch('/api/admin/users');
  allUsers = ud.users || [];
  render(document.getElementById('searchBox').value);
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
}

function render(filter) {
  const f = (filter || '').trim().toLowerCase();
  const list = f ? allUsers.filter(u => u.email.includes(f)) : allUsers;
  const el = document.getElementById('userList');
  if (!list.length) { el.innerHTML = '<div class="empty">Koi user nahi</div>'; return; }
  el.innerHTML = list.map(u => {
    const status = u.paid ? '<span class="badge ok">✓ VERIFIED</span>'
      : u.expired ? '<span class="badge exp">TRIAL KHATAM</span>'
      : '<span class="badge ok">TRIAL ' + u.daysLeft + 'd</span>';
    const live = u.active ? '<span class="badge live">● ONLINE</span>' : '';
    return '<div class="u-row">' +
      '<div class="u-mail">' + u.email + '</div>' +
      '<div class="u-meta">' + fmtDate(u.since) + '</div>' +
      status + live +
      '<button class="tick-btn' + (u.paid ? ' paid' : '') + '" data-email="' + u.email + '" data-paid="' + (u.paid ? 0 : 1) + '" title="Paid verify tick">' + (u.paid ? '✓' : '✓?') + '</button>' +
      '</div>';
  }).join('');
  el.querySelectorAll('.tick-btn[data-email]').forEach(btn => {
    btn.onclick = async () => {
      const email = btn.getAttribute('data-email');
      const paid = btn.getAttribute('data-paid') === '1';
      btn.disabled = true;
      try {
        await admFetch('/api/admin/paid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, paid }) });
        admMsg((paid ? '✓ Verified: ' : 'Tick hataya: ') + email);
        await loadAll();
      } catch (e) { admMsg('Error'); }
      btn.disabled = false;
    };
  });
}

document.getElementById('btnAdmLogin').onclick = async () => {
  const pass = document.getElementById('admPass').value;
  document.getElementById('gateErr').textContent = '';
  try {
    const r = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pass }) });
    const d = await r.json();
    if (!d.ok) { document.getElementById('gateErr').textContent = d.error || 'Error'; return; }
    admPass = pass;
    localStorage.setItem('ds_admin_pass', pass);
    showApp();
    loadAll().catch(() => {});
  } catch (e) { document.getElementById('gateErr').textContent = 'Network error'; }
};
document.getElementById('admPass').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btnAdmLogin').click(); });

document.getElementById('btnLogout').onclick = () => {
  admPass = '';
  localStorage.removeItem('ds_admin_pass');
  showGate('');
};

document.getElementById('btnAddPaid').onclick = async () => {
  const email = document.getElementById('newUser').value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { admMsg('Valid email daalo'); return; }
  try {
    await admFetch('/api/admin/paid', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, paid: true }) });
    document.getElementById('newUser').value = '';
    admMsg('✓ Added & verified: ' + email);
    await loadAll();
  } catch (e) { admMsg('Error'); }
};

document.getElementById('searchBox').addEventListener('input', e => render(e.target.value));

if (admPass) {
  admFetch('/api/admin/stats').then(d => { if (d.ok) { showApp(); loadAll().catch(() => {}); } }).catch(() => {});
} else showGate('');
