// Importa clientes do Zen (catalog.person.Person) para comercial.hub_clientes.
//
// Regra de negocio (2026-08-27):
//   - Canais: Hibrido, Ecommerce, Varejo — vem de Person.category1
//   - TODOS os cadastros desses canais, independente de data ou de ter comprado
//   - Identificacao na tela: personGroup quando houver, senao o proprio cliente
//   - tags do Zen sao espelhadas; a tag 'blocked' marca hub_clientes.bloqueado
//
// Chame com ?dry=1 para simular: le do Zen, reporta o que faria, nao grava nada.

const { zenGet, normDoc } = require('./_zen');

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

// Grafia exata do Zen — 'Hibrido' nao tem acento la.
const CANAIS = ['Hibrido', 'Ecommerce', 'Varejo'];

module.exports = async function handler(req, res) {
  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const hubH = (method) => ({
    'Content-Type': 'application/json',
    'apikey': SB_SERVICE,
    'Authorization': 'Bearer ' + SB_SERVICE,
    'Accept-Profile': 'comercial',
    'Content-Profile': 'comercial',
    'Prefer': method === 'POST'
      ? 'resolution=merge-duplicates,return=representation'
      : 'return=minimal'
  });

  // --- autorizacao: cron secret (header custom ou o Authorization: Bearer
  // que o Vercel Cron manda sozinho quando CRON_SECRET esta configurado) ou
  // admin/manager autenticado ---
  const cronSecret = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;
  const viaVercelCron = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;

  if (cronSecret) {
    if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'CRON_SECRET invalido' });
    }
  } else if (viaVercelCron) {
    // autorizado -- segue direto
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

  const dryRun = req.query?.dry === '1' || req.body?.dry === true;
  // Amostra de teste: restringe a N clientes por canal antes de gravar --
  // uso pontual pra validar mudancas (ex: inicializacao de credito) sem
  // tocar a base inteira (~7700 clientes) de uma vez.
  const limitePorCanalRaw = req.query?.limite_por_canal ?? req.body?.limite_por_canal;
  const limitePorCanal = limitePorCanalRaw ? parseInt(limitePorCanalRaw, 10) : null;
  // Teste pontual: busca so essas pessoas especificas (por Zen person.id),
  // sem varrer a base toda -- usa isso pra validar mudancas rapido, sem
  // esbarrar no timeout da funcao serverless numa varredura de ~7700 pessoas.
  const somenteIdsRaw = req.query?.somente_erp_ids ?? req.body?.somente_erp_ids;
  const somenteIds = somenteIdsRaw ? String(somenteIdsRaw).split(',').map(s => s.trim()).filter(Boolean) : null;

  try {
    // 1 — Buscar as pessoas dos canais desejados.
    // Uma consulta por canal: o RSQL aceita OR com vírgula, mas filtrar por
    // relacao aninhada (category1.description) nao esta documentado — separar
    // as chamadas e mais previsivel e o custo e baixo (3 chamadas).
    let pessoas = [];
    const porCanal = {};

    if (somenteIds) {
      const q = '(' + somenteIds.map(id => `id==${id}`).join(',') + ')';
      pessoas = await zenGet('/catalog/person/person', { q, max: somenteIds.length });
      for (const p of pessoas) { const c = canalDe(p); porCanal[c] = (porCanal[c] || 0) + 1; }
    } else {
    for (const canal of CANAIS) {
      let lote = [];
      try {
        lote = await zenGet('/catalog/person/person', {
          q: `category1.description==${canal}`, max: 200
        });
      } catch (e) {
        console.warn(`[ZEN] filtro por canal '${canal}' falhou (${e.message.slice(0, 80)}); usando varredura`);
        lote = null;
      }
      if (lote === null) { porCanal.__fallback = true; break; }
      porCanal[canal] = lote.length;
      pessoas = pessoas.concat(lote);
    }

    // Fallback: se o filtro por relacao nao for suportado, varre e filtra local.
    if (porCanal.__fallback) {
      delete porCanal.__fallback;
      const todas = await zenGet('/catalog/person/person', { max: 200, limite: 50000 });
      console.log(`[ZEN] varredura completa: ${todas.length} pessoas`);
      pessoas = todas.filter(p => CANAIS.includes(canalDe(p)));
      for (const c of CANAIS) porCanal[c] = pessoas.filter(p => canalDe(p) === c).length;
    }
    }

    // dedupe por id (uma pessoa nao deveria repetir, mas o anti-ciclo e barato)
    const vistos = new Set();
    pessoas = pessoas.filter(p => (p?.id && !vistos.has(p.id)) ? vistos.add(p.id) : false);

    const totalRealEncontrado = pessoas.length;
    if (limitePorCanal) {
      const porCanalAmostra = {};
      pessoas = pessoas.filter(p => {
        const c = canalDe(p);
        porCanalAmostra[c] = (porCanalAmostra[c] || 0) + 1;
        return porCanalAmostra[c] <= limitePorCanal;
      });
      console.log(`[ZEN] amostra de teste: limitado a ${limitePorCanal}/canal (${pessoas.length} de ${totalRealEncontrado})`);
    }

    console.log(`[ZEN] ${pessoas.length} pessoas nos canais ${CANAIS.join(', ')}`);

    // 2 — Montar os registros do Hub
    const semDoc = [];
    const bodies = [];

    for (const p of pessoas) {
      const doc = normDoc(p.documentNumber);
      if (!doc) { semDoc.push(p.id); continue; }

      const tags = parseTags(p.tags);

      bodies.push({
        erp_cliente_id: String(p.id),
        cnpj: doc,
        razao_social: p.name || '(sem nome)',
        nome_fantasia: p.fantasyName || null,
        inscricao_estadual: p.document2Type === 'BR_INSCRICAO_ESTADUAL'
          ? (p.document2Number || null) : null,
        email_principal: p.email || null,
        telefone: p.phone || null,
        canal: canalDe(p),
        grupo_nome: p.personGroup?.description || p.personGroup?.code || null,
        grupo_erp_id: p.personGroup?.id ?? null,
        cidade: p.city?.name || null,
        uf: p.city?.state?.code || null,
        tags,
        bloqueado: tags.includes('blocked'),
        // bloqueado no Zen entra suspenso; os demais, ativos
        status_cadastro: tags.includes('blocked') ? 'suspenso' : 'ativo',
        ativo: true,
        sincronizado_em: new Date().toISOString()
      });
    }

    const resumo = {
      canais: CANAIS,
      encontrados_por_canal: porCanal,
      amostra_teste: limitePorCanal ? { limite_por_canal: limitePorCanal, total_real_encontrado: totalRealEncontrado } : undefined,
      total_encontrado: pessoas.length,
      a_gravar: bodies.length,
      ignorados_sem_documento: semDoc.length,
      bloqueados: bodies.filter(b => b.bloqueado).length,
      com_grupo: bodies.filter(b => b.grupo_nome).length,
      sem_grupo: bodies.filter(b => !b.grupo_nome).length,
      grupos_distintos: new Set(bodies.map(b => b.grupo_nome).filter(Boolean)).size,
      dry_run: dryRun
    };

    if (dryRun) {
      console.log('[ZEN] DRY RUN — nada gravado:', JSON.stringify(resumo, null, 2));
      return res.status(200).json({ ok: true, ...resumo, amostra: bodies.slice(0, 3).map(mascarar) });
    }

    // 3 — Upsert por erp_cliente_id (idempotente: pode rodar quantas vezes quiser)
    let gravados = 0;
    const erros = [];
    for (let i = 0; i < bodies.length; i += 200) {
      const lote = bodies.slice(i, i + 200);
      const r = await fetch(HUB_URL + '/rest/v1/hub_clientes?on_conflict=erp_cliente_id', {
        method: 'POST', headers: hubH('POST'), body: JSON.stringify(lote)
      });
      if (r.ok) { gravados += lote.length; }
      else {
        const txt = await r.text();
        console.error(`[ZEN] lote ${i} falhou (${r.status}):`, txt.slice(0, 300));
        erros.push({ lote: i, status: r.status, detalhe: txt.slice(0, 300) });
      }
    }

    console.log('[ZEN] gravados:', gravados, 'de', bodies.length);

    // 4 — Inicializar limite de credito para quem nunca recebeu (clientes
    // ativados por convite, nao por onboarding, nunca passam por api/ativar.js
    // -- so ele grava limite_credito/limite_disponivel hoje). So toca quem
    // esta zerado/nulo: quem ja tem limite so muda por aprovacao de aumento
    // (hub_solicitacoes_credito), nunca por este sync, pra nao apagar credito
    // ja reservado em pedidos submetidos (hub_fn_submeter_pedido decrementa
    // limite_disponivel na hora, e este sync nao sabe quanto foi reservado).
    const credito = await inicializarCreditoFaltante(bodies, hubH, dryRun);

    // Endereco NAO e sincronizado aqui: ver api/sync-enderecos.js. Tentado como
    // etapa 5 deste handler e deu 504 aos 61s -- a varredura das pessoas nos 3
    // canais consome o maxDuration inteiro antes de chegar no endereco, entao a
    // etapa nunca era alcancada em base cheia (so no teste com 4 clientes).

    return res.status(200).json({
      ok: erros.length === 0, ...resumo, gravados, credito,
      erros: erros.length ? erros : undefined
    });

  } catch (e) {
    console.error('[ZEN] erro:', e.message);
    return res.status(500).json({ ok: false, erro: e.message });
  }
};

async function inicializarCreditoFaltante(bodies, hubH, dryRun) {
  const ids = bodies.map(b => b.erp_cliente_id).filter(Boolean);
  if (!ids.length) return { verificados: 0 };

  // quem ja existe no Hub e ainda esta com limite zerado/nulo. Busca em lotes
  // -- com ~7700 clientes, um erp_cliente_id=in.(...) so com todos de uma vez
  // estoura o limite de tamanho de URL e falha silenciosamente (foi um bug
  // real: a primeira versao disso nunca atualizou ninguem porque o fetch
  // falhava e o erro era engolido, tratado como "atuais = []").
  let atuais = [];
  const consultaErros = [];
  for (let i = 0; i < ids.length; i += 300) {
    const lote = ids.slice(i, i + 300);
    const r = await fetch(
      HUB_URL + '/rest/v1/hub_clientes?erp_cliente_id=in.(' + lote.join(',') + ')&select=erp_cliente_id,limite_credito',
      { headers: hubH('GET') }
    );
    if (!r.ok) {
      consultaErros.push({ lote: i, status: r.status, detalhe: (await r.text()).slice(0, 200) });
      continue;
    }
    const parte = await r.json();
    if (Array.isArray(parte)) atuais = atuais.concat(parte);
  }

  const semLimite = atuais
    .filter(c => !c.limite_credito || +c.limite_credito === 0)
    .map(c => c.erp_cliente_id);

  if (!semLimite.length) return { verificados: atuais.length, sem_limite: 0, consulta_erros: consultaErros.length ? consultaErros : undefined };

  // busca o limite real no Zen em lotes (RSQL OR por person.id)
  const porId = {};
  for (let i = 0; i < semLimite.length; i += 25) {
    const lote = semLimite.slice(i, i + 25);
    const q = lote.map(id => `person.id==${id}`).join(',');
    try {
      const itens = await zenGet('/financial/credit/creditLineItem', { q: `(${q})`, max: 50 });
      for (const it of itens) {
        const pid = String(it.person?.id ?? '');
        if (pid) porId[pid] = (porId[pid] || 0) + (+it.value || 0);
      }
    } catch (e) {
      console.warn('[ZEN] falha ao buscar creditLineItem do lote', i, ':', e.message.slice(0, 120));
    }
  }

  const encontrados = Object.keys(porId).filter(id => porId[id] > 0);
  if (dryRun) {
    return { verificados: atuais.length, sem_limite: semLimite.length, encontrados_no_zen: encontrados.length, dry_run: true };
  }

  let atualizados = 0;
  for (const id of encontrados) {
    const r = await fetch(HUB_URL + '/rest/v1/hub_clientes?erp_cliente_id=eq.' + id, {
      method: 'PATCH', headers: hubH('PATCH'),
      body: JSON.stringify({ limite_credito: porId[id], limite_disponivel: porId[id] })
    });
    if (r.ok) atualizados++;
  }

  return {
    verificados: atuais.length,
    sem_limite: semLimite.length,
    encontrados_no_zen: encontrados.length,
    atualizados,
    consulta_erros: consultaErros.length ? consultaErros : undefined
  };
}

function canalDe(p) {
  return p?.category1?.description || p?.category1?.code || null;
}

// tags vem como string separada por virgula em Person (o schema Compact declara
// array — aceitar as duas formas)
function parseTags(t) {
  if (Array.isArray(t)) return t.map(s => String(s).trim()).filter(Boolean);
  if (typeof t === 'string') return t.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  return [];
}

function mascarar(b) {
  return { ...b, cnpj: '<omitido>', razao_social: '<omitido>', nome_fantasia: '<omitido>',
           email_principal: b.email_principal ? '<omitido>' : null,
           telefone: b.telefone ? '<omitido>' : null };
}
