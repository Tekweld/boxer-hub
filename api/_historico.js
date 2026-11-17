// Baixa de uma vez (1 chamada ao ZEN por cliente) o historico de compras de
// TODOS os produtos de um cliente, e guarda em comercial.hub_historico_compras
// pra abrir qualquer ficha de produto depois ser so leitura local (instantaneo,
// sem tocar no ZEN). Ver comentario da migration hub_historico_compras.
//
// Chamado via api/push-pedido.js?target=historico -- underscore de proposito,
// nao conta como function extra (teto de 12 do plano Hobby).
const { zenGet, rsql } = require('./_zen');

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
// anon key do proprio projeto -- segura no codigo (protegida por RLS). Usada
// (nao a service_role) quando a chamada carrega o JWT de quem pediu, pra
// resolver auth.uid()/role certo e a RLS decidir se pode mesmo (mesmo
// padrao de api/disponibilidade.js -> acessoTabela).
const HUB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtZXB4Y25yc29mb2Zvc3d1YnV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MTczNzMsImV4cCI6MjA5NTI5MzM3M30.S55ouFczRYlUYNFf5PotYKXBPT5idypTSmbzR-x2Pk0';
// Mesmo corte usado no resto do Hub (ver reference-zen-workflow-pedido /
// MEMORY.md) -- nao ha dado do Zen antes disso, nem vale a pena filtrar na
// mao: o Zen simplesmente nao devolve nada mais velho.
const CORTE_HISTORICO = '2025-03-01';
const MAX_POR_PRODUTO = 5;

function normSku(v) { return v == null ? '' : String(v).trim().toUpperCase(); }

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token necessario' });

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

  const body = (typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (e) { return {}; } })() : req.body) || {};
  const clienteId = String(body.cliente_id || '');
  if (!/^[0-9a-f-]{36}$/i.test(clienteId)) return res.status(400).json({ error: 'cliente_id invalido' });

  try {
    // Quem esta pedindo so pode baixar o historico de um cliente que a RLS
    // deixaria ele ver -- reaproveita a mesma funcao de seguranca que todo o
    // resto do Hub usa, chamada com o JWT de quem fez a requisicao (nao o
    // service_role), pra respeitar dealer/representante/staff igual sempre.
    const podeRes = await fetch(HUB_URL + '/rest/v1/rpc/hub_pode_acessar_cliente', {
      method: 'POST',
      headers: { apikey: HUB_ANON, Authorization: authHeader, 'Content-Type': 'application/json', 'Content-Profile': 'comercial' },
      body: JSON.stringify({ p_cliente_id: clienteId })
    });
    const pode = await podeRes.json().catch(() => false);
    if (pode !== true) return res.status(403).json({ error: 'Acesso negado a este cliente' });

    const clienteRes = await fetch(HUB_URL + '/rest/v1/hub_clientes?id=eq.' + clienteId + '&select=erp_cliente_id', { headers: hubH('GET') });
    const clienteRows = await clienteRes.json();
    const ercCliente = clienteRows?.[0]?.erp_cliente_id;
    if (!ercCliente) {
      // Cliente ainda sem vinculo ZEN (onboarding em andamento) -- nao e erro,
      // so nao ha o que baixar ainda.
      return res.status(200).json({ ok: true, produtos: 0, motivo: 'cliente sem erp_cliente_id' });
    }

    // Passo 1: vendas do cliente (so o cabecalho -- id/data/status), pra ter a
    // data certa de cada venda sem depender de saleItem trazer isso embutido
    // (mesma receita ja usada e testada no backfill de hist. ZEN).
    // SEM 'order' -- o Zen so aceita nome puro de coluna, nao
    // "coluna direcao" nem "-coluna" (derruba a consulta inteira, ver
    // ZEN-ERP-CONHECIMENTO.md). A ordenacao por data mais recente acontece
    // depois, em JS, sobre o que ja veio.
    const vendas = await zenGet('/sale/sale', {
      q: rsql.and(rsql.eq('person.id', ercCliente), rsql.gte('date', CORTE_HISTORICO)),
      max: 200, limite: 2000
    });
    const vendasValidas = vendas.filter(v => v.status !== 'CANCELED');
    if (!vendasValidas.length) {
      await fetch(HUB_URL + '/rest/v1/hub_historico_compras_status', {
        method: 'POST', headers: { ...hubH('POST'), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ cliente_id: clienteId, atualizado_em: new Date().toISOString(), produtos_encontrados: 0 })
      });
      return res.status(200).json({ ok: true, produtos: 0 });
    }
    const dataPorVenda = {};
    vendasValidas.forEach(v => { dataPorVenda[v.id] = v.date; });

    // Passo 2: itens dessas vendas, em lotes de 40 (convencao ja usada no
    // resto do codigo contra URL estourada).
    const ids = vendasValidas.map(v => v.id);
    let itens = [];
    for (let i = 0; i < ids.length; i += 40) {
      const lote = ids.slice(i, i + 40);
      const q = '(' + lote.map(id => 'sale.id==' + id).join(',') + ')';
      const pagina = await zenGet('/sale/saleItem', { q, max: 200, limite: 2000 });
      itens = itens.concat(pagina);
    }

    // Agrupa por SKU, ordena por data desc, fica so com os ultimos 5.
    const porSku = {};
    itens.forEach(it => {
      const sku = normSku(it.productPacking?.product?.code);
      if (!sku) return;
      const data = dataPorVenda[it.sale?.id];
      if (!data) return;
      (porSku[sku] = porSku[sku] || []).push({
        data, quantidade: Number(it.quantity) || 0, preco_unitario: Number(it.unitValue) || 0
      });
    });
    const skus = Object.keys(porSku);
    skus.forEach(sku => {
      porSku[sku].sort((a, b) => new Date(b.data) - new Date(a.data));
      porSku[sku] = porSku[sku].slice(0, MAX_POR_PRODUTO);
    });

    // Resolve sku -> hub_produtos.id (so grava quem existe no catalogo do Hub).
    let produtoIdPorSku = {};
    for (let i = 0; i < skus.length; i += 200) {
      const lote = skus.slice(i, i + 200).map(s => '"' + s.replace(/"/g, '') + '"').join(',');
      const r = await fetch(HUB_URL + '/rest/v1/hub_produtos?sku=in.(' + lote + ')&select=id,sku', { headers: hubH('GET') });
      if (r.ok) (await r.json()).forEach(p => { produtoIdPorSku[normSku(p.sku)] = p.id; });
    }

    const agora = new Date().toISOString();
    const bodies = skus
      .filter(sku => produtoIdPorSku[sku])
      .map(sku => ({ cliente_id: clienteId, produto_id: produtoIdPorSku[sku], sku, historico: porSku[sku], atualizado_em: agora }));

    for (let i = 0; i < bodies.length; i += 200) {
      const batch = bodies.slice(i, i + 200);
      await fetch(HUB_URL + '/rest/v1/hub_historico_compras?on_conflict=cliente_id,produto_id', {
        method: 'POST', headers: { ...hubH('POST'), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(batch)
      });
    }

    await fetch(HUB_URL + '/rest/v1/hub_historico_compras_status', {
      method: 'POST', headers: { ...hubH('POST'), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ cliente_id: clienteId, atualizado_em: agora, produtos_encontrados: bodies.length })
    });

    return res.status(200).json({ ok: true, produtos: bodies.length, vendas: vendasValidas.length });
  } catch (e) {
    console.error('Erro ao baixar historico de compras:', e);
    return res.status(502).json({ error: e.message });
  }
};
