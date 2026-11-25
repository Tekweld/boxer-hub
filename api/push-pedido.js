// Espelha um hub_pedidos submetido como sale.Sale no ZEN.
//
// Decisao registrada em docs/INTEGRACAO-ZEN-HUB.md: "Zen dono a partir da
// submissao" -- ate hoje isso nunca acontecia, hub_fn_submeter_pedido so
// gravava no Supabase. Ver auditoria de 2026-08-31.
//
// Confirmado com Andre (2026-08-31):
//   - company = TEKSP (id 1009, stockCluster TEK_SP) representa a Boxer no Zen
//   - a referencia do produto no pedido e por product_code (== hub_produtos.sku
//     == erp_produto_id), resolvido aqui para o productPacking.id que o
//     sale.SaleItem exige (endpoint certo: /catalog/product/productPacking --
//     /material/productPacking nao existe, da 404)
//
// saleProfile usado: DEFAULT (id 1001, workflow VENDA). Ainda NAO validado
// contra o Zen real -- por isso o modo dry-run e o padrao. So faz POST de
// verdade quando chamado com dry=0 explicitamente, e so deveria ser wireado
// no checkout (pedidos.html) depois de um teste manual supervisionado.
const { zenAuth, zenGet, ZEN_BASE } = require('./_zen');
const { freightTypeZen, prazosTexto, conferirVenda, observacoesPedido } = require('./_zen_venda');

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const ZEN_COMPANY_ID = 1009;    // TEKSP -- representa a Boxer
const ZEN_SALE_PROFILE_ID = 1001; // DEFAULT -- workflow VENDA

module.exports = async function handler(req, res) {
  // orcamentos da tabela de Revendas: mesma function por causa do limite da Vercel
  if (req.query && req.query.target === 'orcamento') return require('./_orcamento')(req, res);
  // Indicadores por revenda (aba nova, pedido do Andre 2026-11-03): mesmo motivo
  if (req.query && req.query.target === 'indicadores') return require('./_indicadores')(req, res);
  // Historico de compras por cliente (pedido do Andre 2026-11-17): mesmo motivo
  if (req.query && req.query.target === 'historico') return require('./_historico')(req, res);
  // Log de autenticacao (achado na auditoria de 2026-11-19): mesmo motivo
  if (req.query && req.query.target === 'authlog') return require('./_authlog')(req, res);
  // Comissao (pedido do Andre, 2026-11-19/23): mesmo motivo
  if (req.query && req.query.target === 'comissoes') return require('./_comissoes')(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const cronSecret = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;
  const viaCron = !!cronSecret;
  if (viaCron) {
    if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'CRON_SECRET invalido' });
    }
  } else if (!authHeader) {
    return res.status(401).json({ error: 'Token necessario' });
  }

  const { pedido_id, dry = true, testTag = null } = req.body || {};
  if (!pedido_id) return res.status(400).json({ error: 'pedido_id obrigatorio' });

  function hubH(method) {
    return {
      'Content-Type': 'application/json',
      apikey: SB_SERVICE,
      Authorization: 'Bearer ' + SB_SERVICE,
      'Accept-Profile': 'comercial',
      'Content-Profile': 'comercial',
      Prefer: method === 'PATCH' ? 'return=minimal' : 'return=representation'
    };
  }

  try {
    let perfil = null;
    if (!viaCron) {
      const userRes = await fetch(HUB_URL + '/auth/v1/user', {
        headers: { Authorization: authHeader, apikey: SB_SERVICE }
      });
      const caller = await userRes.json();
      if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

      const perfilRes = await fetch(
        HUB_URL + '/rest/v1/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=tipo,role,cliente_id,representante_id',
        { headers: hubH('GET') }
      );
      perfil = (await perfilRes.json())?.[0];
      if (!perfil) return res.status(403).json({ error: 'Perfil nao encontrado' });
    }

    const pedRes = await fetch(
      HUB_URL + '/rest/v1/hub_pedidos?id=eq.' + pedido_id +
        '&select=id,numero,status,valor_total,cliente_id,representante_id,erp_pedido_id,' +
        'forma_pagamento,parcelas,dias_pagamento,observacoes,ordem_compra,frete_modalidade,' +
        'classe_comercial_aplicada,segmento_aplicado,uf_aplicada,origem,criado_por,canal_venda,' +
        'valor_frete,entrega_agendada,prazo_entrega,' +
        'hub_clientes(erp_cliente_id,razao_social,representante_id,canal),' +
        'hub_pedido_itens(sku,quantidade,preco_unitario,preco_final,desconto_item_percentual,classe_override,segmento_override)',
      { headers: hubH('GET') }
    );
    const pedido = (await pedRes.json())?.[0];
    if (!pedido) return res.status(404).json({ error: 'Pedido nao encontrado' });

    if (!viaCron) {
      const podeVer =
        (perfil.tipo === 'cliente' && perfil.cliente_id === pedido.cliente_id) ||
        (perfil.tipo === 'representante' && perfil.representante_id === pedido.representante_id) ||
        ['analyst', 'manager', 'admin'].includes(perfil.role);
      if (!podeVer) return res.status(403).json({ error: 'Sem acesso a este pedido' });
    }

    if (pedido.status !== 'submetido' && pedido.status !== 'aprovado') {
      return res.status(400).json({ error: 'Pedido precisa estar submetido (status atual: ' + pedido.status + ')' });
    }
    if (pedido.erp_pedido_id) {
      return res.status(409).json({ error: 'Pedido ja sincronizado com o Zen', erp_pedido_id: pedido.erp_pedido_id });
    }

    const erpClienteId = pedido.hub_clientes?.erp_cliente_id;
    if (!erpClienteId) {
      return res.status(400).json({ error: 'Cliente ainda nao sincronizado com o Zen (hub_clientes.erp_cliente_id vazio)' });
    }

    // Resolve product_code -> productPacking.id (o Sale.SaleItem exige o id do
    // packing, nao o do Product -- confirmado no diagnostico de 2026-08-31).
    const itensZen = [];
    const erros = [];
    for (const item of pedido.hub_pedido_itens || []) {
      try {
        const produtos = await zenGet('/catalog/product/product', { q: `code==${item.sku}`, max: 1, limite: 1 });
        if (!produtos.length) { erros.push({ sku: item.sku, erro: 'produto nao encontrado no Zen' }); continue; }

        const packs = await zenGet('/catalog/product/productPacking', { q: `product.id==${produtos[0].id}`, max: 1, limite: 1 });
        if (!packs.length) { erros.push({ sku: item.sku, erro: 'productPacking nao encontrado' }); continue; }

        itensZen.push({
          sku: item.sku,
          productPacking: { id: packs[0].id },
          quantity: item.quantidade,
          unitValue: item.preco_final
        });
      } catch (e) {
        erros.push({ sku: item.sku, erro: e.message.slice(0, 150) });
      }
    }

    if (erros.length) {
      return res.status(422).json({ error: 'Nao foi possivel resolver todos os itens no Zen', detalhes: erros });
    }

    // Achado em 2026-10-27, inspecionando vendas reais finalizadas via API
    // (campo a campo, nao sondagem): o header da venda tem tres campos que
    // nunca eram preenchidos e que faturamento/entrega/cobranca usam de
    // verdade -- sale.Sale so tem 14 campos no nivel raiz, confirmados
    // contra o /platform/openapi.json e contra amostra de vendas FINISHED:
    //   - personAddressShipping -> aba "Endereco" da venda (entrega)
    //   - properties.comments   -> aba "Observacoes" (texto livre)
    //   - freightType           -> NONE | ISSUER | RECIPIENT (enum da spec)
    // "Formas de pagamento" (properties.paymentMethods) NAO entra aqui --
    // e so um espelho que o Zen preenche sozinho a partir do term do
    // primeiro salePayment, confirmado comparando 30 vendas reais.
    //
    // Corrigido em 2026-11-03: a lista acima estava incompleta. O campo
    // "Vendedor" da tela de criacao do pedido no ZEN (sale/sale-edit) E um
    // campo real da venda -- personSalesperson, {id} de catalog.person.Person
    // -- confirmado contra /platform/openapi.json (nao estava na amostra
    // porque nenhum pedido criado pelo Hub ate aqui o preenchia). Fonte:
    // o representante dono da conta do cliente no Hub (hub_clientes.
    // representante_id -> hub_representantes.erp_representante_id), nao
    // quem esta logado fazendo o pedido -- mesma convencao do proprio ZEN,
    // onde o Person do cliente ja carrega personSalesperson por padrao.
    let personAddressShippingId = null;
    try {
      const enderecos = await zenGet('/catalog/person/personAddress', {
        q: `person.id==${erpClienteId}`, max: 1, limite: 1
      });
      personAddressShippingId = enderecos[0]?.id || null;
    } catch (_) {}

    let erpRepresentanteId = null;
    const repId = pedido.hub_clientes?.representante_id;
    if (repId) {
      const repRes = await fetch(
        HUB_URL + '/rest/v1/hub_representantes?id=eq.' + repId + '&select=erp_representante_id&limit=1',
        { headers: hubH('GET') }
      );
      erpRepresentanteId = (await repRes.json())?.[0]?.erp_representante_id || null;
    }

    // Vocabulario de frete expandido em 2026-11-25 (pedido do Andre): o
    // select de revisao (renderOpcoesFrete, pedidos.html) agora tem 5
    // opcoes, nao so envio/retirada. CIF/CARRO_BOXER/CAMINHAO_BOXER_SP =
    // Boxer entrega (ISSUER); FOB/RETIRADA_BOXER = cliente transporta
    // (RECIPIENT). "Frete = <opcao>" sempre vai pro comentario -- unica
    // forma de nao perder a granularidade no ZEN (freightType so distingue
    // ISSUER/RECIPIENT/NONE).
    // Mapa completo em _zen_venda.js (medido 2026-11-25: o ZEN aceita 5 valores,
    // nao so ISSUER/RECIPIENT; retirada = RECIPIENT_SELF, frete proprio = ISSUER_SELF).
    const freightType = freightTypeZen(pedido.frete_modalidade);

    // --- Dados do Hub que o ZEN nao tem campo para receber -> campo Observacoes ---
    // (pedido do Andre, 2026-11-25). Tudo best-effort: se uma consulta falhar, a linha
    // some mas o pedido sobe igual -- nunca bloqueia.
    const get = async (path) => {
      try { const r = await fetch(HUB_URL + '/rest/v1/' + path, { headers: hubH('GET') }); return r.ok ? await r.json() : []; }
      catch (_) { return []; }
    };
    let feitoPor = null;
    if (pedido.criado_por) {
      const [perf] = await get('hub_perfis?user_id=eq.' + pedido.criado_por + '&select=nome,tipo,role&limit=1');
      if (perf?.nome) {
        const tipoTxt = perf.tipo === 'representante' ? 'representante'
          : perf.tipo === 'cliente' ? 'cliente' : 'funcionário Boxer';
        feitoPor = { nome: perf.nome, tipo: tipoTxt };
      }
    }
    if (!feitoPor) {
      const porOrigem = { proxy_representante: 'representante', admin: 'funcionário Boxer', cliente: 'próprio cliente' }[pedido.origem];
      if (porOrigem) feitoPor = { nome: porOrigem === 'próprio cliente' ? 'o próprio cliente' : 'não identificado', tipo: porOrigem };
    }
    const solics = await get('hub_solicitacoes?referencia_tipo=eq.pedido&referencia_id=eq.' + pedido.id +
      '&status=in.(resolvida,respondida)&select=assunto,categoria,assumido_por_nome,resolvido_em&order=criado_em.asc');
    const excecoes = solics.map(s => ({ assunto: s.assunto, categoria: s.categoria, por: s.assumido_por_nome, em: s.resolvido_em }));
    const [onb] = await get('hub_onboarding?cliente_id=eq.' + pedido.cliente_id + '&select=aceita_faturamento_parcial&order=criado_em.desc&limit=1');
    const faturamentoParcial = typeof onb?.aceita_faturamento_parcial === 'boolean' ? onb.aceita_faturamento_parcial : null;

    const comentarios = observacoesPedido(pedido, {
      itens: pedido.hub_pedido_itens || [], feitoPor, excecoes, faturamentoParcial
    });
    // Campo "Codigo" da venda = numero do pedido de compra DO CLIENTE (OC digitada no
    // Hub). So preenche quando alguem escreveu; o canal de vendas e o do cliente.
    const codigoOC = pedido.ordem_compra ? String(pedido.ordem_compra).trim().slice(0, 60) : null;
    const canalVenda = pedido.canal_venda || pedido.hub_clientes?.canal || null;

    // Classe de preco aplicada -- nao ha campo proprio em sale.Sale (so 14
    // campos no nivel raiz, ver nota acima), mas `tags` e padrao e
    // filtravel no ZEN (RSQL `tags==...`), mesmo mecanismo que `blocked` ja
    // usa em Person. Pedido do Andre, 2026-11-06: "tabelavel de facil
    // acesso" -- F3/H2/E1, sigla do segmento + classe, bate com o jeito que
    // ele proprio ja nomeia as classes.
    const SIGLA_SEGMENTO = { 'Física': 'F', 'Hibrido': 'H', 'Ecommerce': 'E' };
    const tagClasse = (pedido.segmento_aplicado && pedido.classe_comercial_aplicada)
      ? ',' + (SIGLA_SEGMENTO[pedido.segmento_aplicado] || pedido.segmento_aplicado[0]) + pedido.classe_comercial_aplicada
      : '';

    const saleBody = {
      company: { id: ZEN_COMPANY_ID },
      person: { id: Number(erpClienteId) },
      saleProfile: { id: ZEN_SALE_PROFILE_ID },
      tags: 'HUB,' + pedido.numero + tagClasse + (testTag ? ',' + testTag : ''),
      freightType
    };
    if (personAddressShippingId) saleBody.personAddressShipping = { id: personAddressShippingId };
    const pagamentos = montarPagamentos(pedido);

    // "Formas de pagamento" (properties.paymentMethods) e a FONTE das parcelas no
    // ZEN: gravar "28/56/84" aqui faz o ZEN criar as 3 parcelas sozinho. Postar
    // salePayment alem disso duplicaria; postar so salePayment deixa o campo
    // vazio (era o que o ADM via em branco). Medido em 2026-11-25.
    saleBody.properties = { paymentMethods: prazosTexto(pagamentos.map(p => p.term)) };
    if (comentarios) saleBody.properties.comments = comentarios;
    if (canalVenda) saleBody.properties.salesChannel = canalVenda;
    if (codigoOC) saleBody.code = codigoOC;
    if (erpRepresentanteId) saleBody.personSalesperson = { id: Number(erpRepresentanteId) };

    if (dry && dry !== '0' && dry !== 0) {
      return res.status(200).json({ ok: true, dry: true, sale: saleBody, itens: itensZen, pagamentos });
    }

    const headers = await zenAuth();

    const saleRes = await fetch(ZEN_BASE + '/sale/sale', {
      method: 'POST', headers, body: JSON.stringify(saleBody)
    });
    if (!saleRes.ok) {
      return res.status(502).json({ error: 'Falha ao criar sale.Sale', detalhe: (await saleRes.text()).slice(0, 500) });
    }
    const sale = await saleRes.json();

    // Grava o vinculo assim que o header do pedido existe -- se um item falhar
    // depois, o pedido ja fica marcado como sincronizado (nao duplica em retry).
    await fetch(HUB_URL + '/rest/v1/hub_pedidos?id=eq.' + pedido_id, {
      method: 'PATCH', headers: hubH('PATCH'),
      body: JSON.stringify({ erp_pedido_id: String(sale.id), erp_tipo: 'sale', erp_sincronizado_em: new Date().toISOString() })
    });

    // Primeira etapa da timeline, gravada AQUI e nao em quem chama: o push tem
    // dois caminhos (checkout e o job que reempurra), e antes so o job
    // registrava -- entao o pedido normal, vindo da tela, aparecia para o
    // cliente sem o "Pedido recebido", pulando direto para o que o Zen dissesse.
    // O indice unico (pedido_id, etapa) torna a repeticao inofensiva.
    await fetch(HUB_URL + '/rest/v1/hub_pedido_eventos?on_conflict=pedido_id,etapa', {
      method: 'POST',
      headers: { ...hubH('POST'), Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        pedido_id, etapa: 'Enviado ao ERP', origem: 'hub', detalhe: 'venda ' + sale.id
      })
    });

    const itensErro = [];
    for (const item of itensZen) {
      const itemRes = await fetch(ZEN_BASE + '/sale/saleItem', {
        method: 'POST', headers,
        body: JSON.stringify({
          sale: { id: sale.id },
          productPacking: item.productPacking,
          quantity: item.quantity,
          unitValue: item.unitValue
        })
      });
      if (!itemRes.ok) itensErro.push({ sku: item.sku, erro: (await itemRes.text()).slice(0, 300) });
    }

    // Pagamento: as parcelas ja nasceram de properties.paymentMethods no POST da
    // venda (sem elas o ADM nao consegue avancar a etapa -- travou no teste de
    // 2026-09-06). Quem garante que ficou certo e a conferencia logo abaixo.
    const pagErro = [];

    // Conferencia campo a campo no ZEN, corrigindo o que divergir. Nao bloqueia
    // nada: o pedido ja esta la; isto so garante que entrou COMPLETO e deixa
    // rastro na timeline (regra do Andre, 2026-11-25).
    let conferencia = null;
    try {
      conferencia = await conferirVenda(sale.id, {
        freightType,
        terms: pagamentos.map(p => p.term),
        comments: comentarios,
        code: codigoOC,
        channel: canalVenda,
        sellerId: erpRepresentanteId,
        addressId: personAddressShippingId,
        itens: itensZen.map(i => ({ packingId: i.productPacking.id, quantity: i.quantity, unitValue: i.unitValue }))
      });
    } catch (e) {
      conferencia = { ok: false, divergencias: [], corrigidas: [], restantes: ['conferencia nao concluida: ' + e.message.slice(0, 200)] };
    }
    const resumoVenda = 'venda ' + sale.id + ' · frete ' + freightType + ' · parcelas ' + prazosTexto(pagamentos.map(p => p.term)) + ' · ' + itensZen.length + ' item(ns)';
    const etapaConf = conferencia.ok
      ? (conferencia.corrigidas.length ? 'Corrigido no ERP' : 'Conferido no ERP')
      : 'Divergencia no ERP';
    const detalheConf = conferencia.ok
      ? resumoVenda + (conferencia.corrigidas.length ? ' · corrigido: ' + conferencia.divergencias.join('; ') : '')
      : resumoVenda + ' · pendente: ' + conferencia.restantes.join('; ');
    await fetch(HUB_URL + '/rest/v1/hub_pedido_eventos?on_conflict=pedido_id,etapa', {
      method: 'POST',
      headers: { ...hubH('POST'), Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({ pedido_id, etapa: etapaConf, origem: 'hub', detalhe: detalheConf.slice(0, 500) })
    });

    // Achado em 2026-10-26: venda 56025 nasceu com cabecalho+pagamento mas
    // ZERO itens (fiscalProfilePerson null na Person quebrava o saleItem) e
    // ninguem percebeu -- este endpoint e chamado fire-and-forget pelo
    // checkout (confirmarEnvio em pedidos.html so avisa no console se a
    // PROPRIA chamada falhar, nunca olha itens_com_erro dentro de um 200).
    // Pior: como erp_pedido_id ja fica gravado, o cron de "reempurrar o que
    // ficou pra tras" nunca mais tenta de novo (so reenvia pedido SEM
    // erp_pedido_id). Por isso, qualquer erro aqui agora vira um evento
    // visivel na timeline do proprio pedido -- silencio nunca mais.
    if (itensErro.length || pagErro.length) {
      await fetch(HUB_URL + '/rest/v1/hub_pedido_eventos', {
        method: 'POST',
        headers: { ...hubH('POST'), Prefer: 'return=minimal' },
        body: JSON.stringify({
          pedido_id, etapa: 'Erro ao gravar no ERP', origem: 'hub',
          detalhe: 'venda ' + sale.id + ' -- ' +
            (itensErro.length ? itensErro.length + ' item(ns) com erro: ' + JSON.stringify(itensErro).slice(0, 400) + '. ' : '') +
            (pagErro.length ? pagErro.length + ' pagamento(s) com erro: ' + JSON.stringify(pagErro).slice(0, 300) : '')
        })
      });
    }

    return res.status(200).json({
      ok: true, dry: false, erp_pedido_id: sale.id,
      itens_gravados: itensZen.length - itensErro.length,
      itens_com_erro: itensErro,
      pagamentos_gravados: pagamentos.length - pagErro.length,
      pagamentos_com_erro: pagErro,
      conferencia
    });

  } catch (e) {
    console.error('[push-pedido] erro:', e);
    return res.status(500).json({ error: e.message });
  }
};

// Uma linha de sale.salePayment por PARCELA, com `term` = dias ate o
// vencimento. Convencao lida da base real (200 pagamentos): `type` e sempre
// BILLING_TITLE.
//
// Boleto/duplicata (Andre, 2026-11-16): nao e mais "Nx parcelas" -- o pedido
// grava os dias exatos de cada parcela em hub_pedidos.dias_pagamento (plano
// escolhido em comercial.hub_planos_prazo_boleto, ex.: 28/56/84, 30/60, 120
// direto). Usa isso direto; so cai no fallback (parcelas x 28) pra pedido
// antigo/espelhado de orcamento que nunca gravou o array.
const DIAS_POR_PARCELA = 28;

// Cartao e Credix ficam como 0 (uma linha, a vista) porque quem financia e a
// adquirente/fintech, nao a Boxer: para o contas a receber do Zen o titulo e
// unico. PENDENTE DE CONFIRMACAO com o Andre/financeiro -- se o Zen tiver de
// refletir as parcelas do cartao ou do Credix, e so mudar o mapa abaixo.
function montarPagamentos(pedido) {
  const forma = String(pedido.forma_pagamento || '').toLowerCase();
  const parcelas = Math.max(1, Number(pedido.parcelas) || 1);

  if (forma === 'boleto' || forma === 'duplicata') {
    if (Array.isArray(pedido.dias_pagamento) && pedido.dias_pagamento.length) {
      return pedido.dias_pagamento.map(dias => ({ type: 'BILLING_TITLE', term: Number(dias) || 0 }));
    }
    return Array.from({ length: parcelas }, (_, i) => ({
      type: 'BILLING_TITLE',
      term: (i + 1) * DIAS_POR_PARCELA
    }));
  }

  // pix, transferencia, cartao, credix e o caso sem forma definida (pedido
  // antigo ou criado por API): uma linha a vista. Nunca devolver lista
  // vazia -- vazio e exatamente o que trava o avancar no Zen.
  return [{ type: 'BILLING_TITLE', term: 0 }];
}
