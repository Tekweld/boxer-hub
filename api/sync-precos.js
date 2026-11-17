// Mantem comercial.hub_produtos.ativo alinhado com quem tem preco de verdade
// em public.produtos (tabela_id=1 -- a tabela "Principal", fonte oficial
// editada em admin_supabase.html). Dois sentidos:
//   1) produto com preco ativo mas sem linha em hub_produtos -- cria.
//   2) hub_produtos ativo cujo preco sumiu/zerou -- desativa (e reativa
//      sozinho se o preco voltar). Nao mexe em mais nenhum campo.
//
// De proposito o unico dono de hub_produtos.ativo. api/sync-pdm.js NAO manda
// mais esse campo (ver comentario la) para os dois jobs nao brigarem.
const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

function normSku(v) {
  return v == null ? '' : String(v).trim().toUpperCase();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const cronSecret = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;
  const viaVercelCron = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;

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
  const pubH = { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE };

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
    console.log('[SYNC PRECOS] Buscando tabela de precos (public.produtos, tabela_id=1)...');
    const precosAtivos = await fetchAll(
      HUB_URL + '/rest/v1/produtos?tabela_id=eq.1&ativo=eq.true&pv_sp=gt.0&select=codigo,modelo,ncm',
      pubH, 'produtos (tabela de precos)'
    );
    const precoPorSku = new Map();
    precosAtivos.forEach(p => { if (p.codigo) precoPorSku.set(normSku(p.codigo), p); });
    console.log(`[SYNC PRECOS] ${precoPorSku.size} SKU(s) com preco ativo na tabela Principal`);

    const hubProdutos = await fetchAll(
      HUB_URL + '/rest/v1/hub_produtos?select=id,sku,ativo',
      hubH('GET'), 'hub_produtos'
    );
    const hubPorSku = new Map();
    hubProdutos.forEach(p => hubPorSku.set(normSku(p.sku), p));

    // 1 — criar o que tem preco e nao existe ainda no Hub
    const aCriar = [];
    precoPorSku.forEach((p, sku) => {
      if (!hubPorSku.has(sku)) {
        aCriar.push({
          sku,
          nome: (p.modelo || sku).trim(),
          ncm: p.ncm || null,
          erp_produto_id: p.codigo,
          ativo: true
        });
      }
    });

    // 2 — desativar quem perdeu o preco, reativar quem recuperou
    const aDesativar = [];
    const aReativar = [];
    hubPorSku.forEach((p, sku) => {
      const temPreco = precoPorSku.has(sku);
      if (p.ativo && !temPreco) aDesativar.push(p.id);
      else if (!p.ativo && temPreco) aReativar.push(p.id);
    });

    async function inserirLote(bodies) {
      let criados = 0;
      for (let i = 0; i < bodies.length; i += 200) {
        const batch = bodies.slice(i, i + 200);
        const r = await fetch(HUB_URL + '/rest/v1/hub_produtos', {
          method: 'POST', headers: hubH('POST'), body: JSON.stringify(batch)
        });
        if (!r.ok) throw new Error('Erro ao criar produtos (lote ' + i + '): ' + await r.text());
        criados += batch.length;
      }
      return criados;
    }

    async function alternarAtivo(ids, ativo) {
      for (let i = 0; i < ids.length; i += 200) {
        const lote = ids.slice(i, i + 200).join(',');
        const r = await fetch(HUB_URL + '/rest/v1/hub_produtos?id=in.(' + lote + ')', {
          method: 'PATCH', headers: hubH('PATCH'),
          body: JSON.stringify({ ativo, atualizado_em: new Date().toISOString() })
        });
        if (!r.ok) throw new Error('Erro ao alternar ativo (lote ' + i + '): ' + await r.text());
      }
    }

    const criados = aCriar.length ? await inserirLote(aCriar) : 0;
    if (aDesativar.length) await alternarAtivo(aDesativar, false);
    if (aReativar.length) await alternarAtivo(aReativar, true);

    const duracaoMs = Date.now() - t0;
    console.log(`[SYNC PRECOS] Concluido em ${duracaoMs}ms — ${criados} criado(s), ${aDesativar.length} desativado(s), ${aReativar.length} reativado(s).`);

    return res.status(200).json({
      ok: true,
      skus_com_preco_ativo: precoPorSku.size,
      produtos_criados: criados,
      produtos_criados_skus: aCriar.map(p => p.sku),
      produtos_desativados: aDesativar.length,
      produtos_reativados: aReativar.length,
      duracao_ms: duracaoMs,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('Erro no sync de precos:', e);
    return res.status(500).json({ error: e.message });
  }
};
