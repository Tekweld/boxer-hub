const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const ZEN_BASE = 'https://api.zenerp.app.br';

function normSku(v) {
  return v == null ? '' : String(v).trim().toUpperCase();
}

async function chamarApiJson(label, url, options) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      console.error(`[${label}] HTTP ${res.status}`);
      return { ok: false, data: null };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    console.error(`[${label}] Falha na chamada:`, e);
    return { ok: false, data: null };
  }
}

// Loga no ZenERP e retorna um token novo — o token e um JWT de curta duracao,
// nao pode ser hardcoded (expira e nao deve viajar pelo frontend).
async function loginZenerp(email, senha) {
  const authRes = await fetch(ZEN_BASE + '/system/security/tokenOpRequest', {
    method: 'POST',
    headers: { 'Tenant': 'boxer', 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: senha })
  });
  if (!authRes.ok) throw new Error('Falha ao autenticar no ZenERP: ' + authRes.status);
  return (await authRes.text()).trim().replace(/"/g, '');
}

// Busca o ESTOQUE_ATUAL no ZenERP para cada codigo informado, via stockAvailabilityCube
// (usa quantity_balance; valores negativos sao zerados antes de ir pro banco).
async function fetchEstoqueZenerp(zenToken, codigos) {
  const jsonBodyEstoque = {
    code: "/salesbreath/stockAvailabilityCube",
    parameters: {
      SHOW_PRODUCT: true,
      SHOW_PRODUCT_PACKING: true,
      SHOW_SCHEDULE: true
    }
  };

  const resultadoEstoque = await chamarApiJson(
    'Relatorio Estoque',
    ZEN_BASE + '/system/data/dataSourceOpRead',
    {
      method: 'POST',
      headers: {
        'Tenant': 'boxer',
        'Authorization': 'Bearer ' + zenToken,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(jsonBodyEstoque)
    }
  );

  if (!resultadoEstoque.ok) return null;

  const json = resultadoEstoque.data;
  if (!Array.isArray(json)) {
    console.error('[Estoque] Resposta da API nao veio como lista (formato inesperado):', json);
    return null;
  }
  console.log(`[Estoque] API ZenERP retornou ${json.length} linha(s).`);

  let matched = 0;
  const naoEncontrados = [];
  const porSku = {};
  codigos.forEach(codigo => {
    const linhas = json.filter(row => normSku(row.product_code) === codigo);
    if (!linhas.length) {
      naoEncontrados.push(codigo);
      porSku[codigo] = 0;
      return;
    }
    matched++;
    const soma = linhas.reduce((s, row) => s + (Number(row.quantity_balance) || 0), 0);
    porSku[codigo] = Math.max(soma, 0);
  });

  console.log(`[Estoque] ${matched}/${codigos.length} codigo(s) encontrados na resposta do ZenERP.`);
  if (naoEncontrados.length) {
    console.warn(`[Estoque] ${naoEncontrados.length} codigo(s) NAO encontrados na resposta do ZenERP.`);
  }

  return { porSku, matched, total: codigos.length, naoEncontrados };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  const zenEmail = process.env.ZEN_EMAIL;
  const zenSenha = process.env.ZEN_SENHA;

  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });
  if (!zenEmail || !zenSenha) return res.status(500).json({ error: 'ZEN_EMAIL/ZEN_SENHA nao configurados' });

  function hubH(method) {
    return {
      'Content-Type': 'application/json',
      'apikey': SB_SERVICE,
      'Authorization': 'Bearer ' + SB_SERVICE,
      'Accept-Profile': 'comercial',
      'Content-Profile': 'comercial',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
    };
  }

  const cronSecret = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;

  // O Vercel Cron chama sozinho mandando "Authorization: Bearer $CRON_SECRET".
  // O header x-cron-secret e a forma manual, usada em teste.
  const viaVercelCron = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;

  if (cronSecret) {
    if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'CRON_SECRET invalido' });
    }
  } else if (viaVercelCron) {
    // autorizado pelo proprio agendador do Vercel
  } else if (authHeader) {
    const userRes = await fetch(HUB_URL + '/auth/v1/user', {
      headers: { 'Authorization': authHeader, 'apikey': SB_SERVICE }
    });
    const caller = await userRes.json();
    if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

    const perfilRes = await fetch(
      HUB_URL + '/rest/v1/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=role',
      { headers: hubH('GET') }
    );
    const perfis = await perfilRes.json();
    if (!perfis?.[0] || !['admin', 'manager'].includes(perfis[0].role)) {
      return res.status(403).json({ error: 'Apenas admin ou manager pode sincronizar' });
    }
  } else {
    return res.status(401).json({ error: 'Autenticacao necessaria' });
  }

  async function fetchAll(url, headers, rotulo) {
    const out = [];
    const sep = url.includes('?') ? '&' : '?';
    for (let offset = 0; ; offset += 1000) {
      const r = await fetch(`${url}${sep}limit=1000&offset=${offset}`, { headers });
      if (!r.ok) throw new Error(`Erro ao buscar ${rotulo}: ${r.status} ${await r.text()}`);
      const lote = await r.json();
      out.push(...lote);
      if (lote.length < 1000) return out;
    }
  }

  const t0 = Date.now();

  try {
    console.log('[SYNC ESTOQUE] Buscando produtos ativos do catalogo...');
    const produtos = await fetchAll(
      HUB_URL + '/rest/v1/hub_produtos?ativo=eq.true&select=id,sku,nome,estoque_disponivel',
      hubH('GET'), 'hub_produtos'
    );
    const skus = [...new Set(produtos.map(p => normSku(p.sku)).filter(Boolean))];
    console.log(`[SYNC ESTOQUE] ${skus.length} SKU(s) no catalogo`);

    console.log('[SYNC ESTOQUE] Autenticando no ZenERP...');
    const zenToken = await loginZenerp(zenEmail, zenSenha);

    const estoque = await fetchEstoqueZenerp(zenToken, skus);
    if (!estoque) return res.status(502).json({ error: 'Falha ao consultar estoque no ZenERP' });

    // So grava quem realmente mudou. Reescrever a base inteira toda hora pesa no
    // Supabase a toa e ainda faz `atualizado_em` mentir — dizia "atualizado agora"
    // pra produto cujo estoque nao muda ha semanas.
    const candidatos = produtos
      .map(p => ({
        sku: normSku(p.sku),
        nome: p.nome,
        qtd: estoque.porSku[normSku(p.sku)],
        anterior: p.estoque_disponivel
      }))
      .filter(p => p.qtd !== undefined);

    const inalterados = candidatos.filter(p => Number(p.anterior) === Number(p.qtd)).length;

    const bodies = candidatos
      .filter(p => Number(p.anterior) !== Number(p.qtd))
      .map(p => ({
        sku: p.sku,
        nome: p.nome, // on_conflict=sku exige NOT NULL satisfeito mesmo quando so vai fazer UPDATE
        estoque_disponivel: p.qtd,
        atualizado_em: new Date().toISOString()
      }));

    let atualizados = 0;
    for (let i = 0; i < bodies.length; i += 200) {
      const batch = bodies.slice(i, i + 200);
      const r = await fetch(HUB_URL + '/rest/v1/hub_produtos?on_conflict=sku', {
        method: 'POST',
        headers: { ...hubH('POST'), 'Prefer': 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(batch)
      });
      if (!r.ok) throw new Error('Erro ao atualizar estoque (batch ' + i + '): ' + await r.text());
      atualizados += batch.length;
    }

    const duracaoMs = Date.now() - t0;
    console.log(`[SYNC ESTOQUE] Concluido em ${duracaoMs}ms — ${atualizados} alterado(s), ${inalterados} sem mudanca.`);

    return res.status(200).json({
      ok: true,
      skus_no_catalogo: skus.length,
      skus_encontrados_zenerp: estoque.matched,
      skus_nao_encontrados_zenerp: estoque.total - estoque.matched,
      // SKU nao encontrado no Zen vira estoque 0. Precisa ficar visivel:
      // quando a trava de estoque entrar, esses produtos ficam impossiveis
      // de pedir. Ver ?detalhar_nao_encontrados=1 pra lista completa.
      skus_nao_encontrados_lista: req.query?.detalhar_nao_encontrados
        ? estoque.naoEncontrados
        : estoque.naoEncontrados.slice(0, 10),
      produtos_atualizados: atualizados,
      produtos_sem_mudanca: inalterados,
      duracao_ms: duracaoMs,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('Erro no sync estoque:', e);
    return res.status(500).json({ error: e.message });
  }
};
