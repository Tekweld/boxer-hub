// Sincroniza descricao_completa/imagem_url/caracteristicas em public.produtos
// (tabela de precos BMAX, projeto bmepxcnrsofofoswubuu) a partir do PDM
// (pdm-boxer, tufbuyfwysowgkxsvjmh). Só toca tabela_id=2 e status='ativo'.
//
// Fonte de verdade: PDM. Sobrescreve o valor atual (nao eh so-preenche-vazio)
// -- e o proposito de existir: uma alteracao no PDM tem que refletir aqui.
//
// Chamado por: botao "Sincronizar PDM" em admin_supabase.html (Bearer token
// de admin/editor de public.perfis) OU pelo cron semanal do Vercel
// (Authorization: Bearer $CRON_SECRET, automatico) OU x-cron-secret manual.

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const PDM_URL = 'https://tufbuyfwysowgkxsvjmh.supabase.co';

const ALLOWED_ORIGIN = 'https://app.boxersoldas.com.br';

function parseAcompanhaEFuncoes(recursos) {
  const out = { acompanha: null, caracteristicas: null };
  if (!recursos) return out;

  const mFunc = recursos.match(/(?:Fun[çc][õo]es|CARACTER[ÍI]STICAS):\s*\r?\n([\s\S]*)$/i);
  if (mFunc) {
    const items = mFunc[1].split(/\r?\n/).map(l => l.replace(/^[\s•\-]+/, '').trim()).filter(l => l.length > 1);
    if (items.length) out.caracteristicas = items.map(label => ({ label, valor: '✓' }));
  }

  const mAcomp = recursos.match(/Acompanha:\s*\r?\n([\s\S]*?)(?:\r?\n\r?\n|$)/i);
  if (mAcomp) {
    const items = mAcomp[1].split(/\r?\n/).map(l => l.replace(/^[\s•\-]+/, '').trim()).filter(l => l.length > 1);
    if (items.length) out.acompanha = items;
  }

  return out;
}

async function fetchAll(url, headers) {
  const out = [];
  const sep = url.includes('?') ? '&' : '?';
  for (let offset = 0; ; offset += 1000) {
    const r = await fetch(`${url}${sep}limit=1000&offset=${offset}`, { headers });
    if (!r.ok) throw new Error(`Erro ao buscar ${url}: ${r.status} ${await r.text()}`);
    const lote = await r.json();
    out.push(...lote);
    if (lote.length < 1000) return out;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-cron-secret');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  const PDM_SERVICE = process.env.PDM_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });
  if (!PDM_SERVICE) return res.status(500).json({ error: 'PDM_SERVICE_KEY nao configurada' });

  const cronSecret = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;
  const viaVercelCron = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;

  if (cronSecret) {
    if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'CRON_SECRET invalido' });
    }
  } else if (viaVercelCron) {
    // ok, cron nativo do Vercel
  } else if (authHeader) {
    const userRes = await fetch(HUB_URL + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: SB_SERVICE }
    });
    const caller = await userRes.json();
    if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

    const perfilRes = await fetch(HUB_URL + '/rest/v1/perfis?id=eq.' + caller.id + '&select=permissao', {
      headers: { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE }
    });
    const perfis = await perfilRes.json();
    if (!perfis?.[0] || !['admin', 'editor'].includes(perfis[0].permissao)) {
      return res.status(403).json({ error: 'Apenas admin ou editor da tabela de precos pode sincronizar' });
    }
  } else {
    return res.status(401).json({ error: 'Autenticacao necessaria' });
  }

  const sbH = { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE, 'Content-Type': 'application/json' };
  const pdmH = { apikey: PDM_SERVICE, Authorization: 'Bearer ' + PDM_SERVICE };

  try {
    const produtosBmax = await fetchAll(
      HUB_URL + '/rest/v1/produtos?tabela_id=eq.2&status=eq.ativo&select=id,codigo,descricao_completa,imagem_url,caracteristicas',
      sbH
    );
    const codigos = [...new Set(produtosBmax.map(p => p.codigo.trim().toUpperCase()))];

    const pdmProdutos = await fetchAll(
      PDM_URL + '/rest/v1/produtos?status=eq.Ativo&select=codigo,descricao_detalhada,descricao,recursos_diferenciais,imagem_url',
      pdmH
    );
    const pdmByCodigo = {};
    pdmProdutos.forEach(p => { if (p.codigo) pdmByCodigo[p.codigo.trim().toUpperCase()] = p; });

    let atualizados = 0;
    let semMudanca = 0;
    const semPdm = [];
    const detalhes = [];

    for (const prod of produtosBmax) {
      const cod = prod.codigo.trim().toUpperCase();
      const pdm = pdmByCodigo[cod];
      if (!pdm) { semPdm.push(prod.codigo); continue; }

      const novaDesc = (pdm.descricao_detalhada || pdm.descricao || '').trim() || null;
      const novaFoto = pdm.imagem_url || null;
      const parsed = parseAcompanhaEFuncoes(pdm.recursos_diferenciais);
      const novoCaracFinal = parsed.caracteristicas;

      const mudou =
        (novaDesc && novaDesc !== prod.descricao_completa) ||
        (novaFoto && novaFoto !== prod.imagem_url) ||
        (novoCaracFinal && JSON.stringify(novoCaracFinal) !== JSON.stringify(prod.caracteristicas));

      if (!mudou) { semMudanca++; continue; }

      const body = {};
      if (novaDesc && novaDesc !== prod.descricao_completa) body.descricao_completa = novaDesc;
      if (novaFoto && novaFoto !== prod.imagem_url) body.imagem_url = novaFoto;
      if (novoCaracFinal && JSON.stringify(novoCaracFinal) !== JSON.stringify(prod.caracteristicas)) body.caracteristicas = novoCaracFinal;
      body.atualizado_em = new Date().toISOString();

      const r = await fetch(HUB_URL + '/rest/v1/produtos?id=eq.' + prod.id, {
        method: 'PATCH', headers: { ...sbH, Prefer: 'return=minimal' }, body: JSON.stringify(body)
      });
      if (!r.ok) { detalhes.push({ codigo: prod.codigo, erro: await r.text() }); continue; }

      atualizados++;
      detalhes.push({ codigo: prod.codigo, campos: Object.keys(body).filter(k => k !== 'atualizado_em') });
    }

    return res.status(200).json({
      ok: true,
      produtos_bmax_verificados: produtosBmax.length,
      produtos_atualizados: atualizados,
      produtos_sem_mudanca: semMudanca,
      produtos_sem_pdm: semPdm,
      detalhes,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('Erro no sync PDM->tabela de precos:', e);
    return res.status(500).json({ error: e.message });
  }
};
