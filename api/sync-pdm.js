const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const PDM_URL = 'https://tufbuyfwysowgkxsvjmh.supabase.co';

// O SKU e a chave de tres operacoes (categoria comercial, foto do PDM e o
// on_conflict do upsert). Um unico espaco sobrando ja duplicou produto no
// banco, entao todo match passa por aqui.
function normSku(v) {
  return v == null ? '' : String(v).trim().toUpperCase();
}

// URLs que nao servem como <img src>. Os links ":b:" do SharePoint respondem
// 302 para o login da Microsoft — ficam gravados, mas fora do catalogo ate o
// caminho definitivo ser definido.
function classificarFoto(url, fonte) {
  const ehSharePoint = /sharepoint\.com/i.test(url || '');
  if (ehSharePoint) return { origem: 'sharepoint', prioridade: 90, renderizavel: false };
  if (fonte === 'bom')  return { origem: 'pdm_bom',     prioridade: 2,  renderizavel: true };
  return { origem: 'pdm_produto', prioridade: 1, renderizavel: true };
}

// Mesma função, dois destinos, pra não passar do limite de Serverless
// Functions do plano (12) só por causa de mais uma rota: ?target=produtos
// sincroniza a tabela de preços (public.produtos) em vez do catálogo do Hub.
// Reaproveita PDM_SERVICE_KEY/SUPABASE_SERVICE_KEY já configurados aqui.
const ALLOWED_ORIGIN_PRODUTOS = 'https://app.boxersoldas.com.br';

function parseAcompanhaEFuncoes(recursos) {
  if (!recursos) return null;
  const m = recursos.match(/(?:Fun[çc][õo]es|CARACTER[ÍI]STICAS):\s*\r?\n([\s\S]*)$/i);
  if (!m) return null;
  const items = m[1].split(/\r?\n/).map(l => l.replace(/^[\s•\-]+/, '').trim()).filter(l => l.length > 1);
  return items.length ? items.map(label => ({ label, valor: '✓' })) : null;
}

async function syncProdutosTabelaPrecos(req, res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN_PRODUTOS);
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-cron-secret');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
  const PDM_URL = 'https://tufbuyfwysowgkxsvjmh.supabase.co';
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

  async function fetchAllProdutos(url, headers) {
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

  try {
    const produtosBmax = await fetchAllProdutos(
      HUB_URL + '/rest/v1/produtos?tabela_id=eq.2&status=eq.ativo&select=id,codigo,descricao_completa,imagem_url,caracteristicas',
      sbH
    );
    const pdmProdutos = await fetchAllProdutos(
      PDM_URL + '/rest/v1/produtos?status=eq.Ativo&select=codigo,descricao_detalhada,descricao,recursos_diferenciais,imagem_url',
      pdmH
    );
    const pdmByCodigo = {};
    pdmProdutos.forEach(p => { if (p.codigo) pdmByCodigo[p.codigo.trim().toUpperCase()] = p; });

    let atualizados = 0, semMudanca = 0;
    const semPdm = [];
    const detalhes = [];

    for (const prod of produtosBmax) {
      const pdm = pdmByCodigo[prod.codigo.trim().toUpperCase()];
      if (!pdm) { semPdm.push(prod.codigo); continue; }

      const novaDesc = (pdm.descricao_detalhada || pdm.descricao || '').trim() || null;
      const novaFoto = pdm.imagem_url || null;
      const novoCarac = parseAcompanhaEFuncoes(pdm.recursos_diferenciais);

      const body = {};
      if (novaDesc && novaDesc !== prod.descricao_completa) body.descricao_completa = novaDesc;
      if (novaFoto && novaFoto !== prod.imagem_url) body.imagem_url = novaFoto;
      if (novoCarac && JSON.stringify(novoCarac) !== JSON.stringify(prod.caracteristicas)) body.caracteristicas = novoCarac;

      if (Object.keys(body).length === 0) { semMudanca++; continue; }
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
}

module.exports = async function handler(req, res) {
  if (req.query && req.query.target === 'produtos') {
    return syncProdutosTabelaPrecos(req, res);
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  const PDM_SERVICE = process.env.PDM_SERVICE_KEY;

  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });
  if (!PDM_SERVICE) return res.status(500).json({ error: 'PDM_SERVICE_KEY nao configurada' });

  const cronSecret = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;

  if (cronSecret) {
    if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'CRON_SECRET invalido' });
    }
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

  const pdmH = {
    'apikey': PDM_SERVICE,
    'Authorization': 'Bearer ' + PDM_SERVICE
  };

  // PostgREST corta em 1000 linhas por padrao, sem erro. bom_itens tem 1576
  // registros com foto — sem paginar, 576 sumiam silenciosamente.
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

  try {
    // 0 — Buscar apenas os SKUs que estão em tabela_preco_itens (FONTE DE VERDADE)
    console.log('[SYNC] Buscando SKUs com preço ativo...');
    const precosData = await fetchAll(
      HUB_URL + '/rest/v1/hub_tabela_preco_itens?select=produto_id',
      hubH('GET'), 'tabela_preco_itens'
    );
    const validProdutoIds = new Set(precosData.map(p => p.produto_id).filter(Boolean));
    console.log(`[SYNC] ${validProdutoIds.size} produtos encontrados na tabela de preços`);

    // 1 — Produtos ativos do PDM
    const pdmProdutos = await fetchAll(
      PDM_URL + '/rest/v1/produtos?status=eq.Ativo&select=*&order=codigo', pdmH, 'produtos PDM'
    );
    console.log(`[SYNC] ${pdmProdutos.length} produtos ativos no PDM`);

    // 2 — Documentos ativos do PDM
    const pdmDocs = await fetchAll(
      PDM_URL + '/rest/v1/documentos?ativo=eq.true&select=id,produto_id,nome,tipo,arquivo_url,revisao',
      pdmH, 'documentos PDM'
    );

    // 2b — BOM itens com foto
    const pdmBomItens = await fetchAll(
      PDM_URL + '/rest/v1/bom_itens?imagem_url=not.is.null&select=part_number,descricao,imagem_url',
      pdmH, 'bom_itens PDM'
    );
    const bomFotoMap = {};
    pdmBomItens.forEach(b => {
      const pn = normSku(b.part_number);
      if (pn && !bomFotoMap[pn]) {
        bomFotoMap[pn] = { imagem_url: b.imagem_url, descricao: b.descricao };
      }
    });
    console.log(`[SYNC] ${Object.keys(bomFotoMap).length} BOM itens com foto`);

    // 3 — Sincronizar produtos (categorias vem da view via public.categorias)
    const pdmIdToSku = {};
    pdmProdutos.forEach(p => pdmIdToSku[p.id] = normSku(p.codigo));

    const prodBodies = pdmProdutos.map(p => {
      const ft = {};
      if (p.processos_solda) ft.processos_solda = p.processos_solda;
      if (p.tensao_entrada) ft.tensao_entrada = p.tensao_entrada;
      if (p.ciclo_trabalho) ft.ciclo_trabalho = p.ciclo_trabalho;
      if (p.tensao_vazio) ft.tensao_vazio = p.tensao_vazio;
      if (p.bitola_arame_eletrodo) ft.bitola_arame_eletrodo = p.bitola_arame_eletrodo;
      if (p.ca_numero) ft.ca_numero = p.ca_numero;
      if (p.ca_validade) ft.ca_validade = p.ca_validade;
      if (p.recursos_diferenciais) ft.recursos_diferenciais = p.recursos_diferenciais;

      return {
        sku: normSku(p.codigo),
        nome: p.nome,
        descricao: p.descricao_detalhada || p.descricao || null,
        ncm: p.ncm || null,
        ficha_tecnica: Object.keys(ft).length > 0 ? ft : null,
        o_que_acompanha: parseOQueAcompanha(p.recursos_diferenciais),
        erp_produto_id: p.codigo,
        ativo: true,
        atualizado_em: new Date().toISOString()
      };
    });

    let hubProdutos = [];
    for (let i = 0; i < prodBodies.length; i += 200) {
      const batch = prodBodies.slice(i, i + 200);
      const pRes = await fetch(HUB_URL + '/rest/v1/hub_produtos?on_conflict=sku', {
        method: 'POST',
        headers: { ...hubH('POST'), 'Prefer': 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(batch)
      });
      if (!pRes.ok) throw new Error('Erro ao upsertar produtos (batch ' + i + '): ' + await pRes.text());
      hubProdutos = hubProdutos.concat(await pRes.json());
    }
    console.log(`[SYNC] ${hubProdutos.length} produtos sincronizados no Hub`);

    // O catalogo (583 SKUs) e maior que o PDM (263). Montar o indice apenas com
    // o retorno do upsert limitava as fotos aos produtos que existem no PDM —
    // era por isso que nenhuma foto de bom_itens entrava: os part_numbers que
    // casam com o catalogo nao estao todos em produtos do PDM.
    const todosHubProdutos = await fetchAll(
      HUB_URL + '/rest/v1/hub_produtos?ativo=eq.true&select=id,sku', hubH('GET'), 'hub_produtos'
    );
    const skuToHubId = {};
    todosHubProdutos.forEach(p => skuToHubId[normSku(p.sku)] = p.id);

    // 5 — Sincronizar APENAS anexos dos SKUs com preço ativo
    console.log('[SYNC] Limpando anexos antigos...');
    // Set, nao array: o lookup roda dentro de tres loops sobre milhares de itens.
    const validHubIds = new Set(
      todosHubProdutos.filter(p => validProdutoIds.has(p.id)).map(p => p.id)
    );

    console.log(`[SYNC] ${validHubIds.size} produtos com preço ativo (catálogo: ${todosHubProdutos.length}, PDM: ${hubProdutos.length})`);

    // Limpar anexos APENAS dos produtos com preço ativo
    const validIdList = [...validHubIds];
    for (let i = 0; i < validIdList.length; i += 50) {
      const ids = validIdList.slice(i, i + 50).join(',');
      await fetch(HUB_URL + '/rest/v1/hub_produto_anexos?produto_id=in.(' + ids + ')', {
        method: 'DELETE', headers: hubH('DELETE')
      });
    }

    const TIPO_MAP = {
      'Artworks': 'foto',
      'Ficha Técnica': 'ficha_tecnica',
      'Vista Explodida': 'catalogo',
      'Manual do Usuário': 'manual',
      'Desenho Técnico': 'ficha_tecnica',
      'Outro': 'catalogo'
    };

    const anexoBodies = [];
    let photoStats = {
      produtoImagem: 0,
      bomItens: 0,
      artworks: 0,
      sharepointPendente: 0,
      skusSemFoto: 0
    };

    const skusComFoto = new Set();

    // Prioridade 1 — foto do produto no PDM (unica fonte que renderiza hoje)
    pdmProdutos.forEach(p => {
      const sku = normSku(p.codigo);
      const hubId = skuToHubId[sku];
      if (p.imagem_url && hubId && validHubIds.has(hubId)) {
        anexoBodies.push({
          produto_id: hubId,
          tipo: 'foto',
          storage_path: p.imagem_url,
          nome: p.nome,
          alt_text: p.nome,
          ordem: 0,
          ...classificarFoto(p.imagem_url, 'produto')
        });
        skusComFoto.add(sku);
        photoStats.produtoImagem++;
      }
    });

    // Prioridade 2 — foto do item de BOM, quando o produto nao tem a sua
    Object.entries(bomFotoMap).forEach(([partNumber, bom]) => {
      const hubId = skuToHubId[partNumber];
      if (hubId && !skusComFoto.has(partNumber) && validHubIds.has(hubId)) {
        anexoBodies.push({
          produto_id: hubId,
          tipo: 'foto',
          storage_path: bom.imagem_url,
          nome: bom.descricao || partNumber,
          alt_text: bom.descricao || partNumber,
          ordem: 0,
          ...classificarFoto(bom.imagem_url, 'bom')
        });
        skusComFoto.add(partNumber);
        photoStats.bomItens++;
      }
    });

    // Prioridade 90 — Artworks (SharePoint). Gravadas, mas nao renderizaveis.
    pdmDocs.forEach(d => {
      if (d.tipo === 'Artworks') {
        const sku = pdmIdToSku[d.produto_id];
        const hubId = sku ? skuToHubId[sku] : null;
        if (hubId && d.arquivo_url && validHubIds.has(hubId)) {
          const cls = classificarFoto(d.arquivo_url, 'artwork');
          anexoBodies.push({
            produto_id: hubId,
            tipo: 'foto',
            storage_path: d.arquivo_url,
            nome: d.nome,
            alt_text: null,
            ordem: 1,
            ...cls
          });
          // So conta como "com foto" se realmente for exibivel
          if (cls.renderizavel && !skusComFoto.has(sku)) {
            skusComFoto.add(sku);
            photoStats.artworks++;
          } else if (!cls.renderizavel) {
            photoStats.sharepointPendente++;
          }
        }
      }
    });

    // Outros documentos (não fotos)
    pdmDocs.forEach(d => {
      if (d.tipo !== 'Artworks') {
        const sku = pdmIdToSku[d.produto_id];
        const hubId = sku ? skuToHubId[sku] : null;
        if (hubId && d.arquivo_url && validHubIds.has(hubId)) {
          anexoBodies.push({
            produto_id: hubId,
            tipo: TIPO_MAP[d.tipo] || 'catalogo',
            storage_path: d.arquivo_url,
            nome: d.nome + (d.revisao && d.revisao !== 'Rev.00' ? ' (' + d.revisao + ')' : ''),
            alt_text: null,
            ordem: 10,
            origem: /sharepoint\.com/i.test(d.arquivo_url) ? 'sharepoint' : 'pdm_produto',
            prioridade: 10,
            renderizavel: true
          });
        }
      }
    });

    photoStats.skusSemFoto = validHubIds.size - skusComFoto.size;

    let anexosCount = 0;
    const anexoErrors = [];
    for (let i = 0; i < anexoBodies.length; i += 50) {
      const batch = anexoBodies.slice(i, i + 50);
      const aRes = await fetch(HUB_URL + '/rest/v1/hub_produto_anexos', {
        method: 'POST',
        headers: hubH('POST'),
        body: JSON.stringify(batch)
      });
      if (aRes.ok) {
        anexosCount += batch.length;
      } else {
        const errText = await aRes.text();
        console.error('Batch anexos ' + i + ' falhou (' + aRes.status + '):', errText);
        anexoErrors.push({ batch: i, status: aRes.status, detail: errText.substring(0, 300) });
      }
    }

    console.log(`[SYNC] Estatísticas de fotos:
      - Produtos.imagem_url: ${photoStats.produtoImagem}
      - BOM itens: ${photoStats.bomItens}
      - Artworks renderizáveis: ${photoStats.artworks}
      - SharePoint pendente (não exibível): ${photoStats.sharepointPendente}
      - SKUs COM foto exibível: ${skusComFoto.size}/${validHubIds.size}
      - SKUs SEM foto: ${photoStats.skusSemFoto}
      - Cobertura: ${((skusComFoto.size / validHubIds.size) * 100).toFixed(1)}%`);

    // Os anexos sao apagados antes de reinserir. Se lotes falharam, o catalogo
    // ficou com menos fotos do que deveria — isso nao pode passar como sucesso.
    return res.status(anexoErrors.length > 0 ? 207 : 200).json({
      ok: anexoErrors.length === 0,
      produtos_com_preco_ativo: validHubIds.size,
      produtos_no_catalogo: todosHubProdutos.length,
      produtos_vindos_do_pdm: hubProdutos.length,
      // SKUs com preco que o PDM nao cobre — teto da cobertura de fotos
      produtos_sem_origem_no_pdm: validHubIds.size - hubProdutos.filter(p => validProdutoIds.has(p.id)).length,
      fotos_produto: photoStats.produtoImagem,
      fotos_bom_itens: photoStats.bomItens,
      fotos_artworks: photoStats.artworks,
      fotos_sharepoint_pendentes: photoStats.sharepointPendente,
      skus_com_foto: skusComFoto.size,
      skus_sem_foto: photoStats.skusSemFoto,
      cobertura_percentual: ((skusComFoto.size / validHubIds.size) * 100).toFixed(1),
      anexos_sincronizados: anexosCount,
      anexos_total_tentados: anexoBodies.length,
      anexo_errors: anexoErrors.length > 0 ? anexoErrors : undefined,
      timestamp: new Date().toISOString()
    });

  } catch (e) {
    console.error('Erro no sync PDM:', e);
    return res.status(500).json({ error: e.message });
  }
};

function parseOQueAcompanha(recursos) {
  if (!recursos) return null;
  const match = recursos.match(/[Aa]companha[:\s]*([\s\S]*?)(?:\n\n|[Ff]un[çc][õo]es|$)/);
  if (!match) return null;
  const items = match[1].split(/[•\n]/)
    .map(s => s.replace(/^[\s\-]+/, '').trim())
    .filter(s => s.length > 2);
  return items.length > 0 ? items : null;
}
