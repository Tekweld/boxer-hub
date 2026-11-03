// Indicadores por revenda -- aba nova pedida pelo Andre em 2026-11-03.
// Roteado por push-pedido.js (?target=indicadores), mesmo motivo do orcamento:
// arquivo comecando com "_" nao conta no limite de Serverless Functions.
//
// REGRA DE OURO DESTE ARQUIVO: o cliente_id que decide o que volta NUNCA vem
// direto do corpo da requisicao para um dealer -- vem do perfil dele
// (hub_perfis.cliente_id), resolvido aqui no servidor. Um dealer so pode ver
// os proprios numeros. Representante so pode escolher uma revenda que esteja
// na carteira dele de verdade (comercial.hub_carteira, a mesma tabela que a
// RLS de hub_clientes usa -- conferido antes de codar, nao assumido). Staff
// (admin/manager/analyst/financial) pode escolher qualquer revenda.

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token necessario' });

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
  async function hubGet(path) {
    const r = await fetch(HUB_URL + '/rest/v1' + path, { headers: hubH('GET') });
    if (!r.ok) throw new Error('Supabase GET ' + path.split('?')[0] + ' -> ' + r.status);
    return r.json();
  }

  try {
    const userRes = await fetch(HUB_URL + '/auth/v1/user', { headers: { Authorization: authHeader, apikey: SB_SERVICE } });
    const caller = await userRes.json();
    if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

    const perfil = (await hubGet('/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=tipo,role,cliente_id,representante_id'))?.[0];
    if (!perfil) return res.status(403).json({ error: 'Perfil nao encontrado' });

    const pedidoClienteId = req.body?.cliente_id || null;
    let clienteId = null;

    if (perfil.tipo === 'cliente') {
      // Dealer: o proprio cadastro, nunca o que vier no corpo.
      clienteId = perfil.cliente_id;
    } else if (perfil.tipo === 'representante') {
      if (!pedidoClienteId) return res.status(400).json({ error: 'Selecione uma revenda' });
      const vinculo = await hubGet(
        '/hub_carteira?representante_id=eq.' + perfil.representante_id +
        '&cliente_id=eq.' + pedidoClienteId + '&ativo=eq.true&select=cliente_id&limit=1'
      );
      if (!vinculo.length) return res.status(403).json({ error: 'Esta revenda nao esta na sua carteira' });
      clienteId = pedidoClienteId;
    } else if (['admin', 'manager', 'analyst', 'financial'].includes(perfil.role)) {
      if (!pedidoClienteId) return res.status(400).json({ error: 'Selecione uma revenda' });
      clienteId = pedidoClienteId;
    } else {
      return res.status(403).json({ error: 'Sem acesso aos indicadores' });
    }
    if (!clienteId) return res.status(400).json({ error: 'cliente_id nao resolvido' });

    const cliente = (await hubGet(
      '/hub_clientes?id=eq.' + clienteId + '&select=id,razao_social,nome_fantasia,cnpj,limite_credito,limite_disponivel'
    ))?.[0];
    if (!cliente) return res.status(404).json({ error: 'Revenda nao encontrada' });

    const [orcamentos, pedidos, notas, titulos] = await Promise.all([
      hubGet('/orcamentos?cliente_cnpj=eq.' + cliente.cnpj + '&ativo=eq.true' +
        '&select=id,codigo,status,total_final,criado_em,aprovado_em&order=criado_em.desc&limit=200'),
      hubGet('/hub_pedidos?cliente_id=eq.' + clienteId + '&ativo=eq.true' +
        '&select=id,numero,status,valor_total,criado_em,erp_pedido_id&order=criado_em.desc&limit=200'),
      hubGet('/hub_notas_fiscais?cliente_id=eq.' + clienteId + '&ativo=eq.true' +
        '&select=id,numero_nf,valor_total,data_emissao&order=data_emissao.desc&limit=500'),
      hubGet('/hub_titulos?cliente_id=eq.' + clienteId + '&ativo=eq.true&select=status,valor_aberto,dias_atraso')
    ]);

    const pedidoIds = pedidos.slice(0, 100).map(p => p.id);
    let produtosTop = [];
    if (pedidoIds.length) {
      const itens = await hubGet(
        '/hub_pedido_itens?pedido_id=in.(' + pedidoIds.join(',') + ')&select=sku,nome_produto,quantidade,subtotal_item'
      );
      const porSku = {};
      itens.forEach(i => {
        const k = i.sku || i.nome_produto;
        if (!porSku[k]) porSku[k] = { sku: i.sku, nome: i.nome_produto, quantidade: 0, valor: 0 };
        porSku[k].quantidade += Number(i.quantidade) || 0;
        porSku[k].valor += Number(i.subtotal_item) || 0;
      });
      produtosTop = Object.values(porSku).sort((a, b) => b.quantidade - a.quantidade).slice(0, 8);
    }

    const orcNaoCancelados = orcamentos.filter(o => o.status !== 'cancelado');
    const orcAprovados = orcamentos.filter(o => o.status === 'aprovado');
    const pedidosConfirmados = pedidos.filter(p => p.status !== 'rascunho');
    const faturamentoTotal = notas.reduce((s, n) => s + (Number(n.valor_total) || 0), 0);
    const tituloAberto = titulos.filter(t => t.status === 'aberto').reduce((s, t) => s + (Number(t.valor_aberto) || 0), 0);
    const tituloVencido = titulos.filter(t => t.status === 'vencido').reduce((s, t) => s + (Number(t.valor_aberto) || 0), 0);

    return res.status(200).json({
      ok: true,
      cliente,
      kpis: {
        orcamentos_gerados: orcNaoCancelados.length,
        pedidos_confirmados: pedidosConfirmados.length,
        faturamento_realizado: faturamentoTotal,
        taxa_conversao: orcNaoCancelados.length ? orcAprovados.length / orcNaoCancelados.length : null,
        ticket_medio_pedido: pedidosConfirmados.length
          ? pedidosConfirmados.reduce((s, p) => s + (Number(p.valor_total) || 0), 0) / pedidosConfirmados.length
          : 0,
        titulos_a_vencer: tituloAberto,
        titulos_vencidos: tituloVencido
      },
      orcamentos: orcamentos.slice(0, 20),
      pedidos: pedidos.slice(0, 20),
      produtos_top: produtosTop
    });
  } catch (e) {
    console.error('[indicadores] erro:', e);
    return res.status(500).json({ error: e.message });
  }
};
