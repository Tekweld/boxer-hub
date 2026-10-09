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

let _tabelaCache = null;
const TABELA_CACHE_MS = 5 * 60 * 1000;

// Modo ?target=tabela: previsao de chegada para a tabela de precos (app.boxersoldas.com.br).
// Diferente do modo Hub, so libera equipe interna (comercial_perfis / perfis) e devolve
// apenas o necessario pro calculo (qtd, prevRep, reservas) — nada do restante do FUP.
async function previsaoTabela(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.boxersoldas.com.br');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

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
  const [cp, pf] = await Promise.all([
    fetch(HUB_URL + '/rest/v1/comercial_perfis?user_id=eq.' + caller.id + '&select=role', { headers: svc('comercial') }).then(r => r.json()),
    fetch(HUB_URL + '/rest/v1/perfis?id=eq.' + caller.id + '&select=permissao', { headers: svc() }).then(r => r.json())
  ]);
  if (!(Array.isArray(cp) && cp.length) && !(Array.isArray(pf) && pf.length)) {
    return res.status(403).json({ error: 'Acesso restrito a equipe interna' });
  }

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
    res.setHeader('Cache-Control', 'private, max-age=60');
    return res.status(200).json({ ok: true, porCodigo: _tabelaCache.porCodigo, lastUpdate: _tabelaCache.lastUpdate });
  } catch (e) {
    console.error('Erro previsao tabela (FUP):', e);
    return res.status(502).json({ error: e.message });
  }
}

module.exports = async function handler(req, res) {
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
