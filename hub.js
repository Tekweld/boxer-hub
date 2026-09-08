// Boxer Hub — Funcoes compartilhadas
// Todas as paginas incluem este arquivo: <script src="hub.js"></script>

const SB_URL  = 'https://bmepxcnrsofofoswubuu.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtZXB4Y25yc29mb2Zvc3d1YnV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MTczNzMsImV4cCI6MjA5NTI5MzM3M30.S55ouFczRYlUYNFf5PotYKXBPT5idypTSmbzR-x2Pk0';

let SESSION = null;

// === SUPABASE FETCH ===

async function sb(path, method = 'GET', body = null) {
  const hdrs = {
    'Content-Type': 'application/json',
    'apikey': SB_ANON,
    'Authorization': 'Bearer ' + (SESSION?.access_token || SB_ANON),
    'Accept-Profile': 'comercial',
    'Content-Profile': 'comercial'
  };
  if (method === 'POST') hdrs['Prefer'] = 'return=representation';
  if (method === 'PATCH') hdrs['Prefer'] = 'return=minimal';

  const opts = { method, headers: hdrs };
  if (body) opts.body = JSON.stringify(body);

  const r = await fetch(SB_URL + '/rest/v1' + path, opts);
  if (!r.ok) {
    const e = await r.text();
    throw new Error(e);
  }
  return (method === 'GET' || method === 'POST') ? r.json() : r;
}

// Conta linhas sem baixar os dados -- sb() normal baixa o array inteiro e o
// PostgREST corta silenciosamente em 1000 por padrao, entao contar via
// r.length mente acima disso. count=exact + Range 0-0 devolve so o total.
async function sbCount(path) {
  const r = await fetch(SB_URL + '/rest/v1' + path, {
    method: 'GET',
    headers: {
      'apikey': SB_ANON,
      'Authorization': 'Bearer ' + (SESSION?.access_token || SB_ANON),
      'Accept-Profile': 'comercial',
      'Prefer': 'count=exact',
      'Range': '0-0'
    }
  });
  if (!r.ok) throw new Error(await r.text());
  const range = r.headers.get('content-range');
  return range ? (parseInt(range.split('/')[1], 10) || 0) : 0;
}

async function sbRpc(fn, params = {}) {
  const r = await fetch(SB_URL + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SB_ANON,
      'Authorization': 'Bearer ' + (SESSION?.access_token || SB_ANON),
      'Content-Profile': 'comercial'
    },
    body: JSON.stringify(params)
  });
  if (!r.ok) {
    const e = await r.text();
    throw new Error(e);
  }
  return r.json();
}

// === FUP (previsao de disponibilidade / materiais em transito) ===
// Dados vem de um projeto Supabase separado, protegido por RLS que exige
// login proprio do FUP. Login e feito so no servidor (api/disponibilidade.js)
// — o front nunca ve a credencial nem o token do FUP, so o resultado.

let _dispCache = null;

// Retorna { disponibilidade: {porCodigo, reservasMap, boxerData, lastUpdate},
//           enderecosStatus: {enderecosMap, statusMap, lastUpdateEnderecos, lastUpdateStatus} }
// ou null se falhar.
async function fetchDisponibilidadeEstoque() {
  if (_dispCache) return _dispCache;
  try {
    const r = await fetch('/api/disponibilidade', {
      headers: { 'Authorization': 'Bearer ' + (SESSION?.access_token || '') }
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    _dispCache = data;
    return data;
  } catch (e) {
    console.error('[FUP] Falha ao buscar disponibilidade:', e);
    return null;
  }
}

// Aplica o filtro obrigatorio do painel FUP (stockStatus !== 'ok') sobre
// dashboard_data.all_data. Os demais filtros do painel (busca, categoria,
// status, zero/baixo) sao opcionais de UI — nao entram aqui, so essa base
// para calculo. Retorna [] se a busca falhar.
async function fetchMateriaisEmTransito() {
  const disp = await fetchDisponibilidadeEstoque();
  if (!disp) return [];
  return Object.values(disp.disponibilidade.porCodigo)
    .flat()
    .filter(r => r.stockStatus !== 'ok');
}

// Calcula a data prevista de disponibilidade suficiente para cobrir `deficit`
// unidades, andando pelos registros FUP de um mesmo codigo em ordem crescente
// de prevRep e descontando a fila de reservas em aberto. Retorna string ISO
// (prevRep do registro que satisfaz) ou null se nao houver previsao.
function calcularDisponibilidadePrevista(records, deficit) {
  if (!Array.isArray(records) || !records.length || !(deficit > 0)) return null;

  const toDate = v => {
    const d = v ? new Date(v) : null;
    return d && !isNaN(d) ? d : null;
  };

  const ordenados = [...records].sort((a, b) => {
    const da = toDate(a.prevRep);
    const db = toDate(b.prevRep);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  });

  let reservasRestantes = Number(ordenados[0].reservas) || 0;
  let disponivelAcumulado = 0;

  for (const rec of ordenados) {
    const qty = Number(rec.qtd) || 0;
    if (reservasRestantes > 0) {
      if (qty <= reservasRestantes) {
        reservasRestantes -= qty;
        continue;
      }
      disponivelAcumulado += (qty - reservasRestantes);
      reservasRestantes = 0;
    } else {
      disponivelAcumulado += qty;
    }
    if (disponivelAcumulado >= deficit) return rec.prevRep || null;
  }
  return null;
}

// Busca a disponibilidade prevista para um sku especifico, comparando o
// estoque ATUAL (ZenERP/hub_produtos.estoque_disponivel — passado pelo chamador,
// nao o campo "estoque" do FUP, que fica dessincronizado com o Zen) com a
// quantidade desejada no carrinho. O FUP so e usado aqui para as remessas em
// transito (qtd/prevRep/reservas), que o Zen nao tem. Retorna:
// - null: nao ha deficit (quantidade <= estoque), estoque atual desconhecido, ou falha ao buscar dados — nao exibir nada.
// - { iso: <string> }: deficit coberto pelas remessas em transito na data indicada.
// - { iso: null }: ha deficit mas nao ha remessa que o cubra (seja porque nao ha nenhum
//   embarque desse sku no FUP, seja porque a soma dos que existem nao e suficiente) —
//   exibir "Sem Disponibilidade Prevista".
async function fetchDisponibilidadePrevistaSku(sku, quantidade, estoqueAtual) {
  const disp = await fetchDisponibilidadeEstoque();
  if (!disp) return null;

  const estoque = Number(estoqueAtual);
  if (!Number.isFinite(estoque)) return null;
  const deficit = quantidade - estoque;
  if (deficit <= 0) return null;

  const records = disp.disponibilidade.porCodigo[sku];
  if (!Array.isArray(records) || !records.length) return { iso: null };

  return { iso: calcularDisponibilidadePrevista(records, deficit) };
}

// === AUTH ===

async function doLogin() {
  const email = document.getElementById('loginEmail').value.trim();
  const pass = document.getElementById('loginPass').value;
  const errEl = document.getElementById('loginErr');

  if (!email || !pass) {
    showLoginErr('Preencha todos os campos');
    return;
  }
  hideLoginErr();

  try {
    const res = await fetch(SB_URL + '/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SB_ANON },
      body: JSON.stringify({ email, password: pass })
    });
    const data = await res.json();

    if (data.error || !data.access_token) {
      showLoginErr('Email ou senha incorretos');
      return;
    }

    SESSION = data;
    sessionStorage.setItem('hub_session', JSON.stringify(data));
    onLoginSuccess();
  } catch (e) {
    showLoginErr('Erro de conexao. Tente novamente.');
  }
}

function doLogout() {
  SESSION = null;
  sessionStorage.removeItem('hub_session');
  window.location.href = 'index.html';
}

function restoreSession() {
  const saved = sessionStorage.getItem('hub_session');
  if (!saved) return false;

  try {
    SESSION = JSON.parse(saved);
    if (!SESSION?.access_token) { SESSION = null; return false; }

    const payload = JSON.parse(atob(SESSION.access_token.split('.')[1]));
    if (payload.exp * 1000 < Date.now()) {
      return tryRefresh();
    }

    const timeLeft = payload.exp * 1000 - Date.now();
    if (timeLeft < 5 * 60 * 1000) tryRefresh();

    scheduleRefresh();
    return true;
  } catch {
    SESSION = null;
    return false;
  }
}

async function tryRefresh() {
  if (!SESSION?.refresh_token) return false;
  try {
    const res = await fetch(SB_URL + '/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SB_ANON },
      body: JSON.stringify({ refresh_token: SESSION.refresh_token })
    });
    const data = await res.json();
    if (data.error || !data.access_token) return false;

    SESSION = data;
    sessionStorage.setItem('hub_session', JSON.stringify(data));
    scheduleRefresh();
    return true;
  } catch {
    return false;
  }
}

function scheduleRefresh() {
  if (!SESSION?.access_token) return;
  try {
    const payload = JSON.parse(atob(SESSION.access_token.split('.')[1]));
    const refreshIn = Math.max((payload.exp * 1000 - Date.now()) - 5 * 60 * 1000, 60000);
    setTimeout(tryRefresh, refreshIn);
  } catch {}
}

function requireAuth() {
  if (!restoreSession()) {
    window.location.href = 'index.html';
    return false;
  }
  return true;
}

function getUserEmail() {
  return SESSION?.user?.email || '';
}

function getUserId() {
  return SESSION?.user?.id || '';
}

// O carrinho e por usuario E por revenda: um representante que troca de
// revenda no meio do caminho nao pode levar o carrinho da anterior junto.
function cartKey() {
  return 'hub_cart_' + getUserId() + '_' + (getClienteAtivo() || 'self');
}

// === ATUAR EM NOME DE UMA REVENDA ===
//
// Dealer so opera para si. Representante e funcionario escolhem uma revenda e
// passam a ver preco e a montar pedido em nome dela — que e como a venda
// acontece de verdade (o rep transmite o pedido do cliente).
//
// Nada aqui concede acesso: quem decide e a RLS e hub_pode_acessar_cliente no
// banco (rep so enxerga a carteira dele, staff enxerga todos). Isto e so a
// escolha de contexto na tela.

function clienteAtivoKey() {
  return 'hub_cliente_ativo_' + getUserId();
}

function getClienteAtivo() {
  if (getUserTipo() === 'cliente') return getUserClienteId();
  try {
    return JSON.parse(sessionStorage.getItem(clienteAtivoKey()) || 'null')?.id || null;
  } catch { return null; }
}

function getClienteAtivoNome() {
  if (getUserTipo() === 'cliente') return null;
  try {
    return JSON.parse(sessionStorage.getItem(clienteAtivoKey()) || 'null')?.nome || null;
  } catch { return null; }
}

function setClienteAtivo(id, nome) {
  sessionStorage.setItem(clienteAtivoKey(), JSON.stringify({ id, nome }));
  window.location.reload();
}

function limparClienteAtivo() {
  sessionStorage.removeItem(clienteAtivoKey());
  window.location.reload();
}

async function abrirSeletorCliente() {
  openModal(`
    <h3 style="font-size:18px;margin-bottom:6px;color:#1d327b">Atuar em nome de uma revenda</h3>
    <p style="font-size:13px;color:#718096;margin-bottom:14px">Preco e pedido passam a seguir as regras da revenda escolhida.</p>
    <input id="buscaCliente" placeholder="Buscar por nome ou CNPJ..." autocomplete="off"
           style="width:100%;padding:10px 12px;border:1px solid #c3cfe2;border-radius:8px;font-family:Outfit;font-size:14px;outline:none">
    <div id="listaClientes" style="margin-top:12px;max-height:50vh;overflow-y:auto"></div>
    <div class="form-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;padding-top:14px;border-top:1px solid #e2e8f0">
      ${getClienteAtivo() ? '<button class="btn btn-outline" onclick="limparClienteAtivo()">Sair da revenda</button>' : ''}
      <button class="btn btn-outline" onclick="closeModal()">Fechar</button>
    </div>
  `);

  const input = document.getElementById('buscaCliente');
  input.addEventListener('input', debounce(() => buscarClientes(input.value), 300));
  input.focus();
  buscarClientes('');
}

async function buscarClientes(termo) {
  const wrap = document.getElementById('listaClientes');
  if (!wrap) return;
  wrap.innerHTML = '<div style="padding:16px;color:#718096;font-size:13px">Buscando...</div>';

  // A RLS ja limita: representante so ve a carteira dele, staff ve todos.
  let url = '/hub_clientes?ativo=eq.true&select=id,nome_exibicao,cnpj,razao_social,uf,canal,bloqueado'
          + '&order=nome_exibicao.asc&limit=40';
  const t = (termo || '').trim();
  if (t) {
    // Busca em tres campos ao mesmo tempo: nome fantasia (nome_exibicao), razao
    // social e CNPJ. Andre bateu nisso ao procurar "Via Norte Comercio", que era
    // a razao social -- o fantasia cadastrado era "Via Norte Parafusos", entao
    // o cliente sumia mesmo sendo dele. Se o termo parecer CNPJ (>=6 digitos),
    // filtra so por CNPJ para nao poluir; caso contrario, texto casa em nome OU
    // razao social. Chars especiais do RSQL (`(), *`) sao removidos por seguranca.
    const seguro = t.replace(/[(),*]/g, '');
    const soDigitos = t.replace(/\D/g, '');
    const parcelas = soDigitos.length >= 6
      ? ['cnpj.ilike.*' + soDigitos + '*']
      : ['nome_exibicao.ilike.*' + seguro + '*',
         'razao_social.ilike.*' + seguro + '*'];
    url += '&or=(' + parcelas.join(',') + ')';
  }

  try {
    const linhas = await sb(url);
    if (!linhas.length) {
      wrap.innerHTML = '<div style="padding:16px;color:#718096;font-size:13px">Nenhuma revenda encontrada.</div>';
      return;
    }
    wrap.innerHTML = linhas.map(c => {
      const nome = (c.nome_exibicao || '').replace(/'/g, '&#39;').replace(/</g, '&lt;');
      return `<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px;border-bottom:1px solid #e2e8f0">
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:600;color:#1a202c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${nome}</div>
          <div style="font-size:11px;color:#718096">${fmtCnpj(c.cnpj)} ${c.uf ? '· ' + c.uf : ''} ${c.canal ? '· ' + c.canal : ''}</div>
        </div>
        ${c.bloqueado
          ? '<span style="font-size:11px;color:#991b1b;background:#fee2e2;padding:3px 8px;border-radius:10px;white-space:nowrap">bloqueada</span>'
          : `<button class="btn btn-primary btn-sm" style="white-space:nowrap" onclick="setClienteAtivo('${c.id}', '${nome}')">Atuar</button>`}
      </div>`;
    }).join('');
  } catch (e) {
    wrap.innerHTML = '<div style="padding:16px;color:#dc2626;font-size:13px">Erro ao buscar revendas.</div>';
  }
}

// === LOGIN UI HELPERS ===

function showLoginErr(msg) {
  const el = document.getElementById('loginErr');
  if (el) { el.textContent = msg; el.style.display = 'block'; }
}

function hideLoginErr() {
  const el = document.getElementById('loginErr');
  if (el) el.style.display = 'none';
}

// === PERFIL ===

let PERFIL = null;

async function loadPerfil() {
  if (!SESSION) return null;
  try {
    const rows = await sb('/hub_perfis?user_id=eq.' + getUserId() + '&ativo=eq.true&select=*');
    PERFIL = rows[0] || null;
    return PERFIL;
  } catch {
    return null;
  }
}

function getUserRole() { return PERFIL?.role || ''; }
function getUserTipo() { return PERFIL?.tipo || ''; }
function getUserNome() { return PERFIL?.nome || getUserEmail(); }
function getUserClienteId() { return PERFIL?.cliente_id || null; }
function getUserRepresentanteId() { return PERFIL?.representante_id || null; }

// === TOPBAR ===

function renderTopbar(titulo) {
  const role = getUserRole();
  const slug = location.pathname.split('/').pop().replace('.html', '') || 'index';
  const currentPage = slug === 'index' ? 'index.html' : slug + (slug.includes('.') ? '' : '.html');

  const tipo = getUserTipo();
  const navItems = [
    { href: 'catalogo.html', label: 'Catalogo', icon: '&#9783;' },
    { href: 'pedidos.html', label: 'Pedidos', icon: '&#9776;' }
  ];
  if (tipo === 'cliente' || tipo === 'representante') {
    navItems.push({ href: 'financeiro.html', label: 'Financeiro', icon: '&#36;' });
    navItems.push({ href: 'cadastro.html', label: 'Cadastro', icon: '&#9881;' });
  }
  navItems.push({ href: 'pesquisas.html', label: 'Pesquisas', icon: '&#9998;' });
  if (['admin', 'manager', 'analyst'].includes(role)) {
    navItems.push({ href: 'admin.html', label: 'Admin', icon: '&#9878;' });
  }

  const navHtml = navItems.map(n => {
    const active = currentPage === n.href ? ' hub-nav-active' : '';
    return `<a href="${n.href}" class="hub-nav-link${active}">${n.icon} ${n.label}</a>`;
  }).join('');

  const html = `
    <div class="topbar">
      <div class="topbar-left">
        <svg width="32" height="32" viewBox="0 0 200 200">
          <rect x="10" y="10" width="180" height="180" rx="30" fill="#e30613"/>
          <line x1="30" y1="30" x2="82" y2="95" stroke="#fff" stroke-width="10" stroke-linecap="round"/>
          <polygon points="100,38 108,80 145,55 118,88 158,92 120,105 148,138 108,118 100,162 92,118 52,138 80,105 42,92 82,88 55,55 92,80" fill="#fff"/>
        </svg>
        <h1>${titulo}</h1>
      </div>
      <div class="topbar-right">
        ${tipo !== 'cliente' ? (
          getClienteAtivo()
            ? `<span class="atuando-chip" onclick="abrirSeletorCliente()" title="Trocar de revenda">
                 Atuando por <strong>${(getClienteAtivoNome() || 'revenda').replace(/</g,'&lt;')}</strong>
               </span>`
            : `<span class="atuando-chip atuando-vazio" onclick="abrirSeletorCliente()">Selecionar revenda</span>`
        ) : ''}
        <span class="notif-badge" id="notifBadge" style="display:none" title="Notificacoes pendentes"></span>
        <span class="user-badge" id="userBadgeDesktop"><strong id="userName"></strong></span>
        <span class="logout-btn" id="logoutDesktop" onclick="doLogout()">Sair</span>
        <button class="hub-menu-btn" id="hubMenuBtn" onclick="toggleMobileMenu()" aria-label="Menu">&#9776;</button>
      </div>
    </div>
    <nav class="hub-nav" id="hubNav">${navHtml}</nav>
    <div class="hub-mobile-user" id="hubMobileUser">
      <span style="font-size:13px;color:#4a5568"><strong>${getUserNome()}</strong></span>
      <span class="logout-btn" onclick="doLogout()" style="font-size:12px;padding:4px 10px;border:1px solid #c3cfe2;border-radius:6px;cursor:pointer;color:#4a5568">Sair</span>
    </div>
    <style>
      .hub-nav{background:#fff;border-bottom:1px solid #d0d8e8;padding:0 24px;display:flex;gap:0;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
      .hub-nav-link{padding:10px 16px;font-family:Outfit,sans-serif;font-size:13px;font-weight:500;color:#4a5568;text-decoration:none;border-bottom:2px solid transparent;white-space:nowrap;transition:color .15s,border-color .15s}
      .hub-nav-link:hover{color:#1d327b;border-bottom-color:#25bbee}
      .hub-nav-active{color:#1d327b;border-bottom-color:#1d327b;font-weight:600}
      .atuando-chip{background:rgba(255,255,255,.12);border:1px solid #25bbee;color:#cfe9f7;font-size:12px;padding:5px 12px;border-radius:14px;cursor:pointer;white-space:nowrap;max-width:280px;overflow:hidden;text-overflow:ellipsis}
      .atuando-chip strong{color:#fff}
      .atuando-chip:hover{background:rgba(255,255,255,.2)}
      .atuando-vazio{border-style:dashed;border-color:rgba(255,255,255,.45);color:#93b4d4}
      @media(max-width:768px){.atuando-chip{max-width:150px;font-size:11px;padding:4px 9px}}
      .hub-menu-btn{display:none;background:none;border:1px solid rgba(255,255,255,.3);color:#fff;font-size:20px;padding:4px 10px;border-radius:6px;cursor:pointer;font-family:Outfit;line-height:1}
      .hub-mobile-user{display:none}
      @media(max-width:768px){
        .topbar h1{font-size:15px}
        #userBadgeDesktop,#logoutDesktop{display:none}
        .hub-menu-btn{display:block}
        .hub-nav{display:none;flex-direction:column;padding:0;border-bottom:1px solid #d0d8e8}
        .hub-nav.open{display:flex}
        .hub-nav-link{padding:12px 20px;border-bottom:none;border-left:3px solid transparent;font-size:14px}
        .hub-nav-active{border-left-color:#1d327b;border-bottom-color:transparent;background:#f0f4f8}
        .hub-mobile-user{display:none;padding:10px 20px;background:#f7fafc;border-bottom:1px solid #d0d8e8;justify-content:space-between;align-items:center}
        .hub-mobile-user.open{display:flex}
      }
    </style>`;

  document.body.insertAdjacentHTML('afterbegin', html);
  const nameEl = document.getElementById('userName');
  if (nameEl) nameEl.textContent = getUserNome();
  loadNotifCount();
}

async function loadNotifCount() {
  try {
    const rows = await sb('/hub_v_notif_pendentes?select=id&limit=1', 'GET');
    const badge = document.getElementById('notifBadge');
    if (badge && rows.length > 0) {
      badge.style.display = 'inline-block';
    }
  } catch {}
}

// === TOAST ===

function toast(msg, tipo = 'success') {
  const d = document.createElement('div');
  d.className = 'toast toast-' + tipo;
  d.textContent = msg;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 3500);
}

// === MODAL ===

// Nem toda pagina declara o overlay no HTML (catalogo e pesquisas nao tinham),
// e o seletor de revenda na topbar vale para todas. Criar sob demanda evita
// repetir o mesmo bloco em cada arquivo.
function garantirModal() {
  if (document.getElementById('modalOverlay')) return;
  document.body.insertAdjacentHTML('beforeend', `
    <div id="modalOverlay" class="modal-overlay" onclick="if(event.target===this)closeModal()">
      <div class="modal" id="modalContent"></div>
    </div>
    <style>
      .modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);z-index:1000;align-items:center;justify-content:center}
      .modal-overlay.show{display:flex}
      .modal{background:#fff;border-radius:12px;padding:24px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.2);margin:16px;font-family:Outfit,sans-serif}
    </style>`);
}

function openModal(html) {
  garantirModal();
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('modalOverlay').classList.add('show');
}

function closeModal() {
  const ov = document.getElementById('modalOverlay');
  if (ov) ov.classList.remove('show');
}

// === MOBILE MENU ===

function toggleMobileMenu() {
  document.getElementById('hubNav').classList.toggle('open');
  document.getElementById('hubMobileUser').classList.toggle('open');
}

// === PASSWORD RECOVERY ===

async function sendPasswordReset(email) {
  const res = await fetch(SB_URL + '/auth/v1/recover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': SB_ANON },
    body: JSON.stringify({ email })
  });
  if (!res.ok) throw new Error('Falha ao enviar reset de senha');
  return true;
}

// === UTILS ===

function fmtMoeda(v) {
  return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtData(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('pt-BR');
}

function fmtCnpj(c) {
  if (!c) return '—';
  return c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
}

function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
