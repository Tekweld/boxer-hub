// Endpoint de DIAGNOSTICO — le a API Zen e reporta a estrutura encontrada.
// Nao escreve nada, em lugar nenhum.
//
// Existe para responder, com dado real, o que a especificacao OpenAPI nao diz:
//   - qual o formato de documentNumber (com ou sem mascara)
//   - onde vive o canal de venda (Hibrido / Ecommerce / Varejo)
//   - o que ha em category1..5, personGroup e tags
//   - se a sintaxe RSQL do filtro funciona como esperado
//
// Depois que essas perguntas estiverem respondidas, este arquivo pode sair.

const { zenAuth, zenGet, ZEN_BASE, ZEN_TENANT, normDoc } = require('./_zen');

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

module.exports = async function handler(req, res) {
  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;

  // Mesma politica do sync-pdm: cron secret ou admin/manager autenticado
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
      { headers: { apikey: SB_SERVICE, Authorization: 'Bearer ' + SB_SERVICE, 'Accept-Profile': 'comercial' } }
    );
    const perfis = await perfilRes.json();
    if (!perfis?.[0] || !['admin', 'manager'].includes(perfis[0].role)) {
      return res.status(403).json({ error: 'Apenas admin ou manager' });
    }
  } else {
    return res.status(401).json({ error: 'Autenticacao necessaria' });
  }

  const achados = { base: ZEN_BASE, tenant: ZEN_TENANT };

  try {
    // 1 — a autenticacao funciona?
    await zenAuth();
    achados.auth = 'ok';
    console.log('[ZEN] autenticado em', ZEN_BASE, 'tenant', ZEN_TENANT);

    // 2 — amostra de Person, para ver a forma real do registro
    const amostra = await zenGet('/catalog/person/person', { max: 50, limite: 50 });
    achados.amostra_qtd = amostra.length;

    if (amostra.length) {
      achados.campos_presentes = [...new Set(amostra.flatMap(p => Object.keys(p)))].sort();

      // formato do documento: com mascara ou so digitos?
      const docs = amostra.filter(p => p.documentNumber).map(p => p.documentNumber);
      achados.documento = {
        exemplos_mascarados: docs.slice(0, 3).map(d => d.replace(/\d/g, '#')),
        tem_mascara: docs.some(d => /\D/.test(d)),
        tamanhos: [...new Set(docs.map(d => d.length))].sort((a, b) => a - b),
        tipos: [...new Set(amostra.map(p => p.documentType).filter(Boolean))]
      };

      // ONDE VIVE O CANAL DE VENDA? Olhar category1..5, personGroup e tags.
      const categorias = {};
      for (const n of [1, 2, 3, 4, 5]) {
        const vals = amostra.map(p => p[`category${n}`]).filter(Boolean)
          .map(c => c.description || c.code || c.name || JSON.stringify(c));
        if (vals.length) categorias[`category${n}`] = [...new Set(vals)].slice(0, 15);
      }
      achados.categorias = categorias;

      achados.personGroup = [...new Set(
        amostra.map(p => p.personGroup).filter(Boolean)
               .map(g => g.description || g.code || JSON.stringify(g))
      )].slice(0, 15);

      achados.tags = [...new Set(amostra.flatMap(p => {
        const t = p.tags;
        return Array.isArray(t) ? t : (typeof t === 'string' && t ? t.split(/[,;]/) : []);
      }).map(s => String(s).trim()).filter(Boolean))].slice(0, 25);

      achados.tem_personSalesperson = amostra.filter(p => p.personSalesperson).length;
      achados.tipos = [...new Set(amostra.map(p => p.type).filter(Boolean))];

      // uma Person completa, com identificadores removidos — so a forma importa
      const ex = { ...amostra.find(p => p.type === 'CORPORATION') || amostra[0] };
      for (const c of ['documentNumber', 'document2Number', 'email', 'phone', 'name', 'fantasyName',
                       'street', 'number', 'complement', 'zipcode']) {
        if (ex[c]) ex[c] = '<omitido>';
      }
      achados.exemplo_estrutura = ex;
    }

    // 3 — a sintaxe RSQL responde como esperado?
    try {
      const rsqlTeste = await zenGet('/catalog/person/person',
        { q: 'type==CORPORATION', max: 5, limite: 5 });
      achados.rsql = {
        funciona: true,
        retornou: rsqlTeste.length,
        so_corporation: rsqlTeste.every(p => p.type === 'CORPORATION')
      };
    } catch (e) {
      achados.rsql = { funciona: false, erro: e.message.slice(0, 200) };
    }

    // 4 — grupos e categorias cadastrados (a lista completa, nao so a da amostra)
    for (const [rotulo, caminho] of [
      ['personGroups_cadastrados', '/catalog/person/personGroup'],
      ['categorias_cadastradas',   '/catalog/category']
    ]) {
      try {
        const linhas = await zenGet(caminho, { max: 100, limite: 200 });
        achados[rotulo] = linhas.map(g => g.description || g.code || g.name).filter(Boolean).slice(0, 60);
      } catch (e) {
        achados[rotulo] = 'erro: ' + e.message.slice(0, 120);
      }
    }

    // 5 — endereco de entrega: personShipping vem embutido no Person? e
    // personAddress e endpoint relacionado a parte?
    try {
      const comEndereco = amostra.find(p => p.street || p.personShipping || p.zipcode) || amostra[0];
      achados.endereco = {
        campos_no_person: Object.keys(comEndereco).filter(k =>
          /address|shipping|street|zip|endereco|entrega/i.test(k)),
        tem_personShipping: !!comEndereco.personShipping,
        personShipping_forma: comEndereco.personShipping
          ? Object.keys(comEndereco.personShipping) : null
      };
      if (comEndereco?.id) {
        try {
          const enderecos = await zenGet('/catalog/person/personAddress',
            { q: `person.id==${comEndereco.id}`, max: 10, limite: 10 });
          achados.endereco.personAddress_relacionado = {
            encontrados: enderecos.length,
            campos: enderecos.length ? Object.keys(enderecos[0]) : [],
            tipos: [...new Set(enderecos.map(e => e.type || e.addressType || e.description).filter(Boolean))]
          };
        } catch (e) {
          achados.endereco.personAddress_relacionado = { erro: e.message.slice(0, 150) };
        }
      }
    } catch (e) {
      achados.endereco = { erro: e.message.slice(0, 150) };
    }

    // 6 — tabela de preco e limite de credito por cliente: a doc fala em
    // priceListCost/priceListRetail no Person, mas isso nao foi confirmado
    // contra dado real ainda. hub_clientes.tabela_preco_id e limite_credito
    // estao vazios pra quase todo mundo -- descobrir de onde isso deveria vir.
    try {
      const comDados = amostra.find(p =>
        /price|credit|limit/i.test(Object.keys(p).join(' '))) || amostra[0];
      achados.preco_credito = {
        campos_no_person: Object.keys(comDados).filter(k =>
          /price|credit|limit|preco|credito|limite/i.test(k)),
        priceListRetail: comDados.priceListRetail ?? null,
        priceListCost: comDados.priceListCost ?? null,
        creditLine: comDados.creditLine ?? null
      };
      // tenta os candidatos mais prováveis de endpoint relacionado a credito
      for (const [rotulo, caminho] of [
        ['personCredit', '/catalog/person/personCredit'],
        ['personFinance', '/catalog/person/personFinance'],
        ['saleProfile', '/sale/saleProfile']
      ]) {
        try {
          const linhas = await zenGet(caminho, { max: 3, limite: 3 });
          achados.preco_credito[rotulo] = { existe: true, campos: linhas.length ? Object.keys(linhas[0]) : [] };
        } catch (e) {
          achados.preco_credito[rotulo] = { existe: false, erro: e.message.slice(0, 100) };
        }
      }
    } catch (e) {
      achados.preco_credito = { erro: e.message.slice(0, 150) };
    }

    // 7 — modulo sale/workflow: o que falta pra escrever o pedido no ZEN.
    // hub_fn_submeter_pedido ja fecha o pedido no Hub; falta so criar o
    // espelho no ZEN (docs/INTEGRACAO-ZEN-HUB.md secao 3: "Zen dono a partir
    // da submissao"). Nada aqui grava nada — so leitura.
    try {
      const workflows = await zenGet('/system/workflow/workflow', { max: 30, limite: 30 });
      achados.workflows = workflows.map(w => ({ id: w.id, code: w.code, description: w.description, status: w.status }));
    } catch (e) {
      achados.workflows = 'erro: ' + e.message.slice(0, 150);
    }

    try {
      const nodes = await zenGet('/system/workflow/workflowNode', { max: 100, limite: 100 });
      achados.workflowNodes = nodes.map(n => ({
        id: n.id, workflow: n.workflow?.id ?? n.workflow, type: n.type,
        code: n.code, description: n.description
      }));
    } catch (e) {
      achados.workflowNodes = 'erro: ' + e.message.slice(0, 150);
    }

    try {
      const perfis = await zenGet('/sale/saleProfile', { max: 30, limite: 30 });
      achados.saleProfiles = perfis.map(p => ({ id: p.id, code: p.code, description: p.description, workflow: p.workflow?.id ?? p.workflow }));
    } catch (e) {
      achados.saleProfiles = 'erro: ' + e.message.slice(0, 150);
    }

    // amostra de um pedido real, pra ver a forma de sale.Sale e sale.SaleItem
    // (como o item referencia o produto — productPacking, nao SKU direto)
    try {
      const vendas = await zenGet('/sale/sale', { order: '-id', max: 3, limite: 3 });
      achados.sale_amostra_qtd = vendas.length;
      if (vendas.length) {
        const v = { ...vendas[0] };
        achados.sale_campos = Object.keys(v).sort();
        achados.sale_exemplo = v;

        try {
          const itens = await zenGet('/sale/saleItem', { q: `sale.id==${v.id}`, max: 10, limite: 10 });
          achados.saleItem_campos = itens.length ? Object.keys(itens[0]).sort() : [];
          achados.saleItem_exemplo = itens[0] || null;
        } catch (e) {
          achados.saleItem_exemplo = { erro: e.message.slice(0, 150) };
        }
      }
    } catch (e) {
      achados.sale_amostra = 'erro: ' + e.message.slice(0, 150);
    }

    try {
      const clusters = await zenGet('/material/stockCluster', { max: 50, limite: 50 });
      achados.stockClusters = clusters.map(c => ({ id: c.id, code: c.code, description: c.description }));
    } catch (e) {
      achados.stockClusters = 'erro: ' + e.message.slice(0, 150);
    }

    // 8 — quais empresas (company) existem, e qual stockCluster/warehouse cada
    // uma usa. Precisamos saber qual delas representa a Boxer B2B/revenda.
    try {
      const empresas = await zenGet('/catalog/company/company', { max: 30, limite: 30 });
      achados.companies = empresas.map(c => ({
        id: c.id, code: c.code,
        nome: c.person?.fantasyName || c.person?.name,
        stockCluster: c.stockCluster?.code ?? c.stockCluster,
        warehouse: c.warehouse?.code ?? c.warehouse,
        priceList: c.priceList?.code ?? c.priceList ?? null,
        creditLine: c.creditLine?.code ?? c.creditLine ?? null
      }));
    } catch (e) {
      achados.companies = 'erro: ' + e.message.slice(0, 150);
    }

    // 9 — como productPacking se relaciona com o SKU do produto (hub_produtos.sku
    // == erp_produto_id == Product.code). Testamos com 3 SKUs reais do Hub.
    achados.productPacking_teste = {};
    for (const sku of ['100169', '100184', '1005023']) {
      const item = {};
      try {
        const produtos = await zenGet('/catalog/product/product', { q: `code==${sku}`, max: 3, limite: 3 });
        item.product_encontrado = produtos.length;
        if (produtos.length) {
          item.product_campos = Object.keys(produtos[0]).sort();
          item.product_id = produtos[0].id;
          for (const [rotulo, caminho] of [
            ['catalog_product', '/catalog/product/productPacking'],
            ['material', '/material/productPacking']
          ]) {
            try {
              const packs = await zenGet(caminho, { q: `product.id==${produtos[0].id}`, max: 5, limite: 5 });
              item[rotulo] = { existe: true, qtd: packs.length, campos: packs.length ? Object.keys(packs[0]).sort() : [], exemplo: packs[0] || null };
            } catch (e2) {
              item[rotulo] = { existe: false, erro: e2.message.slice(0, 120) };
            }
          }
        }
      } catch (e) {
        item.erro = e.message.slice(0, 150);
      }
      achados.productPacking_teste[sku] = item;
    }

    // 10b — verificacao pontual: confere o sale.Sale criado pelo teste real
    // do push-pedido.js (2026-08-31, HUB-2026-00001 -> Zen sale 47662).
    try {
      const vendaId = req.query?.verificarSaleId || '47662';
      const venda = await zenGet('/sale/sale', { q: `id==${vendaId}`, max: 1, limite: 1 });
      const itensVenda = await zenGet('/sale/saleItem', { q: `sale.id==${vendaId}`, max: 10, limite: 10 });
      achados.verificacao_sale_teste = { sale: venda[0] || null, itens: itensVenda };
    } catch (e) {
      achados.verificacao_sale_teste = { erro: e.message.slice(0, 200) };
    }

    // 10 — investigacao pontual: por que um cliente convidado (nao onboarding)
    // continua com limite_credito=0 mesmo depois do sync rodar. ?creditPersonId=
    // deixa reutilizar isso pra qualquer pessoa, nao so o caso de hoje.
    const creditPersonIdRaw = req.query?.creditPersonId || '53310';
    const creditPersonIds = String(creditPersonIdRaw).split(',').map(s => s.trim()).filter(Boolean);
    try {
      const q = creditPersonIds.length > 1
        ? '(' + creditPersonIds.map(id => `person.id==${id}`).join(',') + ')'
        : `person.id==${creditPersonIds[0]}`;
      const semFiltro = await zenGet('/financial/credit/creditLineItem', { q, max: 50, limite: 50 });
      achados.credito_pessoa_teste = {
        person_ids: creditPersonIds,
        qtd_encontrada: semFiltro.length,
        itens: semFiltro.map(it => ({ id: it.id, value: it.value, creditLine: it.creditLine?.id ?? it.creditLine, person: it.person?.id ?? it.person }))
      };
    } catch (e) {
      achados.credito_pessoa_teste = { person_ids: creditPersonIds, erro: e.message.slice(0, 200) };
    }
    // se nao ha CreditLineItem por pessoa, o limite pode estar no personGroup
    // (a spec permite as duas formas) -- busca o Person e testa por grupo.
    // So faz sentido pra 1 pessoa por vez.
    try {
      const pessoas = creditPersonIds.length === 1
        ? await zenGet('/catalog/person/person', { q: `id==${creditPersonIds[0]}`, max: 1, limite: 1 })
        : [];
      const pessoa = pessoas[0] || null;
      achados.credito_pessoa_teste.person = pessoa ? {
        id: pessoa.id, name: pessoa.name,
        personGroup: pessoa.personGroup ? { id: pessoa.personGroup.id, code: pessoa.personGroup.code, description: pessoa.personGroup.description } : null,
        category1: pessoa.category1?.description ?? pessoa.category1 ?? null
      } : null;
      if (pessoa?.personGroup?.id) {
        const porGrupo = await zenGet('/financial/credit/creditLineItem', { q: `personGroup.id==${pessoa.personGroup.id}`, max: 10, limite: 10 });
        achados.credito_pessoa_teste.creditLineItem_por_grupo = porGrupo.map(it => ({ id: it.id, value: it.value }));
      }
    } catch (e) {
      achados.credito_pessoa_teste.erro_grupo = e.message.slice(0, 200);
    }

    // 11 — workflow de venda: quais sao os status customizados reais.
    // O `sale.status` e um enum duro (PREPARED/APPROVED/PICKING...). O status
    // que interessa pro cliente e o no ATIVO do workflow, em
    // workflowNode.description — mesma leitura que o BAV usa no modulo de
    // pedido em aberto (Tekweld/bav-boxer, backend/app/zen_pedidos.py).
    try {
      const nodes = await zenGet('/system/workflow/workflowNode', { max: 200, limite: 400 });
      achados.workflow_nodes = {
        total: nodes.length,
        nodes: nodes.map(n => ({
          id: n.id,
          description: n.description,
          workflow: n.workflow?.description ?? n.workflow?.code ?? n.workflow?.id ?? n.workflow
        }))
      };
    } catch (e) {
      achados.workflow_nodes = { erro: e.message.slice(0, 200) };
    }

    // 11b — perfis de venda: qual saleProfile aponta pro workflow certo do Hub.
    // O DEFAULT (1001) funcionou no teste, mas nunca foi confirmado como o certo.
    try {
      const perfis = await zenGet('/sale/saleProfile', { max: 100, limite: 200 });
      achados.sale_profiles = perfis.map(p => ({
        id: p.id, code: p.code, description: p.description,
        workflow: p.workflow?.description ?? p.workflow?.code ?? p.workflow?.id ?? p.workflow
      }));
    } catch (e) {
      achados.sale_profiles = { erro: e.message.slice(0, 200) };
    }

    // 11c — amostra real: vendas recentes e em que no do workflow cada uma esta.
    // Mostra quais status customizados estao REALMENTE em uso hoje, nao so
    // quais existem cadastrados.
    try {
      const vendas = await zenGet('/sale/sale', {
        q: 'status=in=(PREPARED,APPROVED,PICKING)', order: '-id', max: 40, limite: 40
      });
      const ids = vendas.map(v => v.id).filter(Boolean);
      let porVenda = {};
      if (ids.length) {
        const nos = await zenGet('/system/workflow/workpieceNode', {
          q: `workpiece.id=in=(${ids.join(',')});status=="ACTIVE"`, max: 200, limite: 200
        });
        nos.forEach(n => {
          const wid = n.workpiece?.id ?? n.workpiece;
          if (wid) porVenda[wid] = n.workflowNode?.description ?? null;
        });
      }
      achados.vendas_workflow_amostra = vendas.map(v => ({
        id: v.id, status: v.status,
        saleProfile: v.saleProfile?.id ?? v.saleProfile,
        no_ativo: porVenda[v.id] ?? null
      }));
    } catch (e) {
      achados.vendas_workflow_amostra = { erro: e.message.slice(0, 200) };
    }

    // 11d — o cubo de estoque reserva? Le UMA linha do stockAvailabilityCube
    // so pra revelar quais colunas existem. Se houver coluna de reserva/pedido
    // pendente separada de quantity_balance, da pra saber se venda em PREPARED
    // ja segura estoque. Somente leitura.
    try {
      const headers = await zenAuth();
      const r = await fetch(ZEN_BASE + '/system/data/dataSourceOpRead', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: '/salesbreath/stockAvailabilityCube',
          parameters: { SHOW_PRODUCT: true, SHOW_PRODUCT_PACKING: true, SHOW_SCHEDULE: true }
        })
      });
      const linhas = r.ok ? await r.json() : null;
      achados.cubo_estoque_colunas = Array.isArray(linhas) && linhas.length
        ? { total_linhas: linhas.length, colunas: Object.keys(linhas[0]), exemplo: linhas[0] }
        : { status: r.status, aviso: 'resposta vazia ou em formato inesperado' };
    } catch (e) {
      achados.cubo_estoque_colunas = { erro: e.message.slice(0, 200) };
    }

    console.log('[ZEN] achados:', JSON.stringify(achados, null, 2));
    return res.status(200).json({ ok: true, ...achados });

  } catch (e) {
    console.error('[ZEN] erro:', e.message);
    return res.status(500).json({ ok: false, erro: e.message, achados });
  }
};
