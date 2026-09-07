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

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const ZEN_COMPANY_ID = 1009;    // TEKSP -- representa a Boxer
const ZEN_SALE_PROFILE_ID = 1001; // DEFAULT -- workflow VENDA

module.exports = async function handler(req, res) {
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
        'forma_pagamento,parcelas,' +
        'hub_clientes(erp_cliente_id,razao_social),hub_pedido_itens(sku,quantidade,preco_final)',
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

    const saleBody = {
      company: { id: ZEN_COMPANY_ID },
      person: { id: Number(erpClienteId) },
      saleProfile: { id: ZEN_SALE_PROFILE_ID },
      tags: 'HUB,' + pedido.numero + (testTag ? ',' + testTag : '')
    };

    const pagamentos = montarPagamentos(pedido);

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

    // Pagamento. Sem isto o pedido chega ao Zen com "Formas de pagamento"
    // vazio e o ADM NAO consegue avancar a etapa -- travou de verdade no teste
    // de 2026-09-06, e o Andre teve que preencher na mao para destravar.
    const pagErro = [];
    for (const p of pagamentos) {
      const pr = await fetch(ZEN_BASE + '/sale/salePayment', {
        method: 'POST', headers,
        body: JSON.stringify({ sale: { id: sale.id }, type: p.type, term: p.term })
      });
      if (!pr.ok) pagErro.push({ term: p.term, erro: (await pr.text()).slice(0, 300) });
    }

    return res.status(200).json({
      ok: true, dry: false, erp_pedido_id: sale.id,
      itens_gravados: itensZen.length - itensErro.length,
      itens_com_erro: itensErro,
      pagamentos_gravados: pagamentos.length - pagErro.length,
      pagamentos_com_erro: pagErro
    });

  } catch (e) {
    console.error('[push-pedido] erro:', e);
    return res.status(500).json({ error: e.message });
  }
};

// Uma linha de sale.salePayment por PARCELA, com `term` = dias ate o
// vencimento. Convencao lida da base real (200 pagamentos): `type` e sempre
// BILLING_TITLE e os prazos sao multiplos de 28 -- 28/56/84 e o 3x usual da
// casa, e 0 e a vista.
//
// Cartao fica como 0 (uma linha, a vista) porque quem financia e a
// adquirente, nao a Boxer: para o contas a receber do Zen o titulo e unico.
// PENDENTE DE CONFIRMACAO com o Andre/financeiro -- se o Zen tiver de refletir
// as 10 parcelas do cartao, e so mudar o mapa abaixo.
const DIAS_POR_PARCELA = 28;

function montarPagamentos(pedido) {
  const forma = String(pedido.forma_pagamento || '').toLowerCase();
  const parcelas = Math.max(1, Number(pedido.parcelas) || 1);

  if (forma === 'boleto' || forma === 'duplicata') {
    return Array.from({ length: parcelas }, (_, i) => ({
      type: 'BILLING_TITLE',
      term: (i + 1) * DIAS_POR_PARCELA
    }));
  }

  // pix, transferencia, cartao e o caso sem forma definida (pedido antigo ou
  // criado por API): uma linha a vista. Nunca devolver lista vazia -- vazio e
  // exatamente o que trava o avancar no Zen.
  return [{ type: 'BILLING_TITLE', term: 0 }];
}
