const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const FUP_URL = 'https://agtzfllruggjbscuwdyi.supabase.co';
// Anon key do projeto FUP — publica por definicao (protegida por RLS), pode
// ficar no codigo do servidor. O que NAO pode viajar e o login (FUP_EMAIL/
// FUP_SENHA), que abre acesso de authenticated e libera as linhas na RLS.
const FUP_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFndHpmbGxydWdnamJzY3V3ZHlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NDQyMTcsImV4cCI6MjA5NzEyMDIxN30.A-u9ezGh7c921sf-L8Q6XVgUjU412mAAdkcID1Ajk8g';

async function loginFup(email, senha) {
  const r = await fetch(FUP_URL + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': FUP_ANON },
    body: JSON.stringify({ email, password: senha })
  });
  const data = await r.json();
  if (!r.ok || !data.access_token) throw new Error('Falha ao autenticar no FUP: ' + (data.error_description || r.status));
  return data.access_token;
}

async function fupSelect(token, table, select) {
  const r = await fetch(`${FUP_URL}/rest/v1/${table}?select=${select}&limit=1`, {
    headers: { apikey: FUP_ANON, Authorization: 'Bearer ' + token }
  });
  if (!r.ok) throw new Error(`Erro ao buscar ${table}: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0] || null;
}

// Mesma regra do hub.js (calcularDisponibilidadePrevista): anda pelas remessas por data prevista,
// desconta a fila de reservas e devolve a data em que o deficit passa a estar coberto.
function calcularPrevisao(records, deficit) {
  if (!Array.isArray(records) || !records.length || !(deficit > 0)) return null;
  const toDate = v => { const d = v ? new Date(v) : null; return d && !isNaN(d) ? d : null; };
  const ordenados = [...records].sort((a, b) => {
    const da = toDate(a.prevRep), db = toDate(b.prevRep);
    if (!da && !db) return 0;
    if (!da) return 1;
    if (!db) return -1;
    return da - db;
  });
  let reservasRestantes = Number(ordenados[0].reservas) || 0;
  let acumulado = 0;
  for (const rec of ordenados) {
    const qty = Number(rec.qtd) || 0;
    if (reservasRestantes > 0) {
      if (qty <= reservasRestantes) { reservasRestantes -= qty; continue; }
      acumulado += (qty - reservasRestantes);
      reservasRestantes = 0;
    } else {
      acumulado += qty;
    }
    if (acumulado >= deficit) return rec.prevRep || null;
  }
  return null;
}

let _tabelaCache = null;
const TABELA_CACHE_MS = 5 * 60 * 1000;

// Modo ?target=tabela: previsao de chegada para a tabela de precos (app.boxersoldas.com.br).
// Diferente do modo Hub, so libera equipe interna (comercial_perfis / perfis) e devolve
// apenas o necessario pro calculo (qtd, prevRep, reservas) — nada do restante do FUP.
async function previsaoTabela(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.boxersoldas.com.br');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  const fupEmail = process.env.FUP_EMAIL;
  const fupSenha = process.env.FUP_SENHA;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });
  if (!fupEmail || !fupSenha) return res.status(500).json({ error: 'FUP_EMAIL/FUP_SENHA nao configurados' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Autenticacao necessaria' });

  const userRes = await fetch(HUB_URL + '/auth/v1/user', {
    headers: { 'Authorization': authHeader, 'apikey': SB_SERVICE }
  });
  const caller = await userRes.json();
  if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

  const svc = (profile) => ({
    'apikey': SB_SERVICE,
    'Authorization': 'Bearer ' + SB_SERVICE,
    ...(profile ? { 'Accept-Profile': profile } : {})
  });
  // Libera equipe interna (comercial_perfis / perfis) E pessoas aprovadas na tela de acessos (tabela_usuarios, ativas e dentro da validade)
  const liberado = await fetch(HUB_URL + '/rest/v1/rpc/tabela_email_liberado', {
    method: 'POST', headers: { ...svc(), 'Content-Type': 'application/json' }, body: JSON.stringify({ p_email: String(caller.email || '').toLowerCase() })
  }).then(r => r.json()).catch(() => false);
  if (liberado !== true) {
    return res.status(403).json({ error: 'Acesso restrito a pessoas liberadas' });
  }

  // GET ?itens=codigo:qtd,... (consulta por quantidade)  |  POST {codigos:[...]} (lista toda, quantidade 1, para exportacao)
  const LISTA_MAX = 1500;
  let itens;
  if (req.method === 'POST') {
    let corpo = req.body;
    if (typeof corpo === 'string') { try { corpo = JSON.parse(corpo); } catch (e) { corpo = {}; } }
    itens = (Array.isArray(corpo && corpo.codigos) ? corpo.codigos : []).slice(0, LISTA_MAX)
      .map(c => ({ codigo: String(c || '').trim().toUpperCase(), qtd: 1 }))
      .filter(i => /^[A-Z0-9_-]{1,20}$/.test(i.codigo));
    if (!itens.length) return res.status(400).json({ error: 'codigos invalidos' });
  } else {
    itens = String(req.query.itens || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 80).map(s => {
      const [c, q] = s.split(':');
      return { codigo: String(c || '').trim().toUpperCase(), qtd: parseInt(q, 10) };
    }).filter(i => /^[A-Z0-9_-]{1,20}$/.test(i.codigo) && i.qtd > 0 && i.qtd <= 100000);
    if (!itens.length) return res.status(400).json({ error: 'itens invalidos (use codigo:qtd,codigo:qtd)' });
  }
  const codigos = [...new Set(itens.map(i => i.codigo))];

  try {
    if (!_tabelaCache || Date.now() - _tabelaCache.em > TABELA_CACHE_MS) {
      const fupToken = await loginFup(fupEmail, fupSenha);
      const dashboard = await fupSelect(fupToken, 'dashboard_data', 'all_data,last_update');
      const porCodigo = {};
      (dashboard?.all_data || []).forEach(item => {
        if (!item?.codigo) return;
        const k = String(item.codigo).trim().toUpperCase();
        (porCodigo[k] = porCodigo[k] || []).push({
          qtd: Number(item.qtd) || 0,
          prevRep: item.prevRep || null,
          reservas: Number(item.reservas) || 0
        });
      });
      _tabelaCache = { em: Date.now(), porCodigo, lastUpdate: dashboard?.last_update || null };
    }
    // O estoque nunca sai daqui: o navegador manda "codigo:qtd" e recebe so o veredito
    // (ok / previsao com data / sem previsao). Nenhum numero de saldo ou de remessa trafega.
    const lotes = [];
    for (let i = 0; i < codigos.length; i += 100) lotes.push(codigos.slice(i, i + 100));
    const respostas = await Promise.all(lotes.map(lote => {
      const lista = lote.map(c => '"' + c + '"').join(',');
      return Promise.all([
        fetch(HUB_URL + '/rest/v1/hub_produtos?select=sku,estoque_disponivel&ativo=eq.true&sku=in.(' + lista + ')', { headers: svc('comercial') }).then(r => r.ok ? r.json() : []),
        fetch(HUB_URL + '/rest/v1/estoque_zenerp?select=codigo,quantity_balance&codigo=in.(' + lista + ')', { headers: svc() }).then(r => r.ok ? r.json() : [])
      ]);
    }));
    const hubRows = respostas.flatMap(r => r[0]);
    const zenRows = respostas.flatMap(r => r[1]);
    const estoque = {};
    (Array.isArray(zenRows) ? zenRows : []).forEach(z => { estoque[String(z.codigo).trim().toUpperCase()] = Math.max(Number(z.quantity_balance) || 0, 0); });
    (Array.isArray(hubRows) ? hubRows : []).forEach(h => { if (h.estoque_disponivel != null) estoque[String(h.sku).trim().toUpperCase()] = Number(h.estoque_disponivel) || 0; });

    const resultados = {};
    itens.forEach(({ codigo, qtd }) => {
      const q = estoque[codigo];
      let r;
      if (q === undefined) r = { tipo: 'sem_info' };
      else if (q >= qtd) r = { tipo: 'ok' };
      else {
        const iso = calcularPrevisao(_tabelaCache.porCodigo[codigo], qtd - q);
        r = iso ? { tipo: 'prev', iso } : { tipo: 'sem_prev' };
      }
      resultados[codigo + '|' + qtd] = r;
    });
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json({ ok: true, resultados, consultado_em: new Date().toISOString(), fup_em: _tabelaCache.lastUpdate });
  } catch (e) {
    console.error('Erro previsao tabela (FUP):', e);
    return res.status(502).json({ error: e.message });
  }
}

// Modo ?target=acesso (POST): login por codigo de email + solicitacao de acesso, para a tela da tabela de precos.
// Responde o status do email (enviado / nao_cadastrado / pendente / expirado / revogado) para a pessoa nao ficar esperando
// um codigo que nunca chega. Para limitar enumeracao: limite de tentativas por IP e por email.
const ACESSO_ORIGEM = 'https://app.boxersoldas.com.br';
const RE_EMAIL = /^[a-z0-9._%+'-]{1,64}@[a-z0-9.-]{1,190}\.[a-z]{2,}$/;
const RE_BOXER = /^[a-z0-9._%+-]{1,64}@boxersoldas\.com\.br$/;

function escHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

async function resendEnviar(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.warn('RESEND_API_KEY nao configurada — email nao enviado'); return false; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify({ from: 'Boxer Tabela de Preços <noreply@boxersoldas.com.br>', to: Array.isArray(to) ? to : [to], subject, html })
  });
  if (!r.ok) console.error('Resend erro:', await r.text());
  return r.ok;
}

function emailShell(inner) {
  return '<div style="font-family:Arial,sans-serif;background:#f0f4f8;padding:24px"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d0d8e8;border-radius:12px;padding:28px">' + inner +
    '</div><p style="text-align:center;font-size:11px;color:#a0aec0;margin-top:14px">Boxer Soldas — mensagem automática</p></div>';
}

async function acessoTabela(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ACESSO_ORIGEM);
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'servico indisponivel' });
  const H = { 'apikey': SB_SERVICE, 'Authorization': 'Bearer ' + SB_SERVICE, 'Content-Type': 'application/json' };
  const body = (typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (e) { return {}; } })() : req.body) || {};
  const acao = body.acao;
  const email = String(body.email || '').trim().toLowerCase();
  const generico = { ok: true, status: 'enviado' };
  const ip = String((req.headers['x-forwarded-for'] || '')).split(',')[0].trim().slice(0, 45) || 'desconhecido';
  const respostaStatus = (status) => res.status(200).json({ ok: true, status });

  const logEvento = (evento, em, detalhe) => fetch(HUB_URL + '/rest/v1/tabela_acessos_log', {
    method: 'POST', headers: { ...H, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ user_id: null, email: em || null, evento, detalhe: detalhe || null })
  }).catch(() => {});
  const contar = async (path) => {
    const r = await fetch(HUB_URL + '/rest/v1/' + path, { headers: { ...H, 'Prefer': 'count=exact', 'Range': '0-0' } });
    const cr = r.headers.get('content-range') || '';
    return parseInt(cr.split('/')[1], 10) || 0;
  };

  if (!RE_EMAIL.test(email)) return res.status(400).json({ error: 'email invalido' });

  try {
    if (acao === 'codigo') {
      const desde = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const enviados = await contar('tabela_acessos_log?select=id&email=eq.' + encodeURIComponent(email) + '&evento=eq.codigo_enviado&criado_em=gte.' + encodeURIComponent(desde));
      if (enviados >= 5) { await logEvento('codigo_limite', email, { ip }); return respostaStatus('limite'); }
      const tentativasIp = await contar('tabela_acessos_log?select=id&evento=in.(codigo_enviado,codigo_negado)&detalhe-%3E%3Eip=eq.' + encodeURIComponent(ip) + '&criado_em=gte.' + encodeURIComponent(new Date(Date.now() - 10 * 60 * 1000).toISOString()));
      if (tentativasIp >= 20) { await logEvento('codigo_limite', email, { ip, motivo: 'ip' }); return respostaStatus('limite'); }

      let liberado = await fetch(HUB_URL + '/rest/v1/rpc/tabela_email_liberado', { method: 'POST', headers: H, body: JSON.stringify({ p_email: email }) }).then(r => r.json());
      if (liberado !== true && RE_BOXER.test(email)) {
        const ins = await fetch(HUB_URL + '/rest/v1/tabela_usuarios', {
          method: 'POST', headers: { ...H, 'Prefer': 'return=minimal' },
          body: JSON.stringify({ email, tipo: 'interno', origem: 'dominio', criado_por: 'automatico (dominio Boxer)' })
        });
        if (ins.ok || ins.status === 409) { liberado = true; await logEvento('acesso_auto_dominio', email); }
      }
      if (liberado !== true) {
        let motivo = 'nao_cadastrado';
        const u = await fetch(HUB_URL + '/rest/v1/tabela_usuarios?select=ativo,validade&email=eq.' + encodeURIComponent(email) + '&limit=1', { headers: H }).then(r => r.json()).catch(() => []);
        if (Array.isArray(u) && u[0]) motivo = !u[0].ativo ? 'revogado' : 'expirado';
        else if (await contar('tabela_solicitacoes?select=id&email=eq.' + encodeURIComponent(email) + '&status=eq.pendente') > 0) motivo = 'pendente';
        await logEvento('codigo_negado', email, { ip, motivo });
        return respostaStatus(motivo);
      }

      // garante o usuario no Auth (ignora "ja existe") e gera o codigo sem o Supabase mandar email
      await fetch(HUB_URL + '/auth/v1/admin/users', { method: 'POST', headers: H, body: JSON.stringify({ email, email_confirm: true }) }).catch(() => {});
      const lk = await fetch(HUB_URL + '/auth/v1/admin/generate_link', { method: 'POST', headers: H, body: JSON.stringify({ type: 'magiclink', email }) });
      const lkj = await lk.json();
      const codigo = lkj && lkj.email_otp;
      if (!lk.ok || !codigo) { console.error('generate_link falhou', lk.status, JSON.stringify(lkj).slice(0, 200)); await logEvento('codigo_erro', email, { ip }); return respostaStatus('erro'); }

      const ok = await resendEnviar(email, 'Seu código de acesso — Tabela de Preços Boxer',
        emailShell('<p style="font-size:15px;color:#1a202c;margin:0 0 14px">Seu código de acesso à <strong>Tabela de Preços Boxer</strong>:</p>' +
          '<p style="text-align:center;margin:18px 0"><span style="display:inline-block;font-size:32px;letter-spacing:8px;font-weight:700;color:#1d327b;background:#f0f4f8;border:1px solid #d0d8e8;border-radius:10px;padding:12px 22px">' + escHtml(codigo) + '</span></p>' +
          '<p style="font-size:13px;color:#4a5568;margin:0 0 8px">Digite esse código na tela de acesso. Ele vale por pouco tempo e só pode ser usado uma vez.</p>' +
          '<p style="font-size:12px;color:#718096;margin:0">Não foi você? Ignore este email — ninguém entra sem o código.</p>'));
      await logEvento(ok ? 'codigo_enviado' : 'codigo_erro', email, { ip });
      return ok ? res.status(200).json(generico) : respostaStatus('erro');
    }

    if (acao === 'solicitar') {
      if (body.website) return respostaStatus('solicitado'); // honeypot
      const nome = String(body.nome || '').trim().slice(0, 120);
      const empresa = String(body.empresa || '').trim().slice(0, 160);
      const mensagem = String(body.mensagem || '').trim().slice(0, 600);
      if (nome.length < 2) return res.status(400).json({ error: 'informe o nome' });

      const jaLiberado = await fetch(HUB_URL + '/rest/v1/rpc/tabela_email_liberado', { method: 'POST', headers: H, body: JSON.stringify({ p_email: email }) }).then(r => r.json()).catch(() => false);
      if (jaLiberado === true || RE_BOXER.test(email)) return respostaStatus('ja_liberado');
      const dia = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const recentes = await contar('tabela_solicitacoes?select=id&email=eq.' + encodeURIComponent(email) + '&criado_em=gte.' + encodeURIComponent(dia));
      if (recentes >= 3) return respostaStatus('limite');
      const pend = await contar('tabela_solicitacoes?select=id&email=eq.' + encodeURIComponent(email) + '&status=eq.pendente');
      if (pend > 0) return respostaStatus('pendente');

      const ins = await fetch(HUB_URL + '/rest/v1/tabela_solicitacoes', {
        method: 'POST', headers: { ...H, 'Prefer': 'return=minimal' },
        body: JSON.stringify({ nome, email, empresa: empresa || null, mensagem: mensagem || null })
      });
      if (!ins.ok) { console.error('insert solicitacao falhou', await ins.text()); return res.status(200).json(generico); }
      await logEvento('solicitacao_acesso', email, { nome, empresa });

      const admins = await fetch(HUB_URL + '/rest/v1/rpc/tabela_emails_admin', { method: 'POST', headers: H, body: '{}' }).then(r => r.json()).catch(() => []);
      if (Array.isArray(admins) && admins.length) {
        await resendEnviar(admins, 'Nova solicitação de acesso — Tabela de Preços',
          emailShell('<p style="font-size:15px;color:#1a202c;margin:0 0 12px"><strong>' + escHtml(nome) + '</strong> pediu acesso à Tabela de Preços Boxer.</p>' +
            '<table style="width:100%;font-size:13px;border-collapse:collapse;margin-bottom:14px"><tr><td style="color:#718096;padding:4px 0">Email</td><td>' + escHtml(email) + '</td></tr>' +
            '<tr><td style="color:#718096;padding:4px 0">Empresa</td><td>' + escHtml(empresa || '—') + '</td></tr>' +
            '<tr><td style="color:#718096;padding:4px 0;vertical-align:top">Mensagem</td><td>' + escHtml(mensagem || '—') + '</td></tr></table>' +
            '<p style="text-align:center;margin:18px 0"><a href="https://app.boxersoldas.com.br/admin_supabase.html" style="background:#1d327b;color:#fff;text-decoration:none;padding:11px 24px;border-radius:8px;font-size:14px;font-weight:600">Abrir painel admin → aba Acessos</a></p>'));
      }
      return respostaStatus('solicitado');
    }

    return res.status(400).json({ error: 'acao invalida' });
  } catch (e) {
    console.error('Erro acesso tabela:', e);
    return respostaStatus('erro');
  }
}

module.exports = async function handler(req, res) {
  if (req.query && req.query.target === 'acesso') return acessoTabela(req, res);
  if (req.query && req.query.target === 'tabela') return previsaoTabela(req, res);
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  const fupEmail = process.env.FUP_EMAIL;
  const fupSenha = process.env.FUP_SENHA;

  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });
  if (!fupEmail || !fupSenha) return res.status(500).json({ error: 'FUP_EMAIL/FUP_SENHA nao configurados' });

  // Qualquer usuario autenticado do Hub pode ver a previsao de disponibilidade —
  // nao ha restricao por role, so exige estar logado.
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Autenticacao necessaria' });

  const userRes = await fetch(HUB_URL + '/auth/v1/user', {
    headers: { 'Authorization': authHeader, 'apikey': SB_SERVICE }
  });
  const caller = await userRes.json();
  if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

  try {
    const fupToken = await loginFup(fupEmail, fupSenha);

    const [dashboard, sales2] = await Promise.all([
      fupSelect(fupToken, 'dashboard_data', 'all_data,reservas_map,boxer_data,last_update'),
      fupSelect(fupToken, 'sales2_data', 'enderecos_map,status_map,last_update_enderecos,last_update_status')
    ]);

    const porCodigo = {};
    (dashboard?.all_data || []).forEach(item => {
      if (!item?.codigo) return;
      porCodigo[item.codigo] = porCodigo[item.codigo] || [];
      porCodigo[item.codigo].push(item);
    });

    return res.status(200).json({
      ok: true,
      disponibilidade: {
        porCodigo,
        reservasMap: dashboard?.reservas_map || {},
        boxerData: dashboard?.boxer_data || [],
        lastUpdate: dashboard?.last_update || null
      },
      enderecosStatus: {
        enderecosMap: sales2?.enderecos_map || {},
        statusMap: sales2?.status_map || {},
        lastUpdateEnderecos: sales2?.last_update_enderecos || null,
        lastUpdateStatus: sales2?.last_update_status || null
      }
    });
  } catch (e) {
    console.error('Erro ao buscar disponibilidade FUP:', e);
    return res.status(502).json({ error: e.message });
  }
};
