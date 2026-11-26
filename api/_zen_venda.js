// Regras unicas de como uma venda do Hub e gravada no ZEN e conferida depois.
// Usado por push-pedido.js (pedido) e _orcamento.js (orcamento). Prefixo `_` de
// proposito: nao conta como Serverless Function (limite de 12 no plano Hobby).
//
// Medido contra o ZEN de producao em 2026-11-25 (ver BOXER/ZEN-ERP-CONHECIMENTO.md 4.6.3):
//  - freightType aceita NONE|ISSUER|RECIPIENT|RECIPIENT_SELF|ISSUER_SELF
//  - gravar properties.paymentMethods ("28/56/84") no POST/PUT FAZ o ZEN criar/trocar
//    as parcelas (salePayment) sozinho. Postar salePayment alem disso DUPLICA.
//    Postar so salePayment cria as parcelas mas deixa "Formas de pagamento" vazio.
//    => paymentMethods e a fonte unica; conferirVenda e a rede de seguranca.
const { zenGet, zenAuth, ZEN_BASE } = require('./_zen');

const FRETE_ZEN = {
  CIF: 'ISSUER',
  FOB: 'RECIPIENT',
  RETIRADA_BOXER: 'RECIPIENT_SELF',
  CARRO_BOXER: 'ISSUER_SELF',
  CAMINHAO_BOXER_SP: 'ISSUER_SELF',
  envio: 'ISSUER',            // vocabulario antigo de hub_pedidos.frete_modalidade
  retirada: 'RECIPIENT_SELF'
};

function freightTypeZen(codigo) {
  if (!codigo) return 'NONE';
  return FRETE_ZEN[codigo] || 'RECIPIENT';
}

function prazosTexto(terms) {
  return terms.map(t => Number(t) || 0).join('/');
}

const FRETE_LABEL = {
  CIF: 'CIF automático', FOB: 'FOB (cliente providencia o transporte)',
  RETIRADA_BOXER: 'Retirada na Boxer (Campinas/São Paulo/Guarulhos)',
  CARRO_BOXER: 'Carro Boxer', CAMINHAO_BOXER_SP: 'Entrega com Caminhão Boxer (SP)',
  envio: 'Envio pela Boxer', retirada: 'Cliente usa transportadora própria'
};

const brl = (v) => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dataBr = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }); };

// Texto do campo "Observacoes" da venda no ZEN: tudo que o Hub sabe do pedido e o ZEN
// nao tem campo proprio para receber (pedido do Andre, 2026-11-25). Forma de pagamento,
// OC (campo `code`) e canal NAO entram aqui: vao nos campos certos. Uma linha por dado,
// so o que existir no pedido; o texto livre do cliente vem primeiro.
// ctx: { itens, feitoPor:{nome,tipo}|null, excecoes:[{assunto,categoria,por,em}], faturamentoParcial:boolean|null }
function observacoesPedido(pedido, ctx = {}) {
  const linhas = [];
  if (pedido.observacoes) linhas.push(String(pedido.observacoes).trim());

  const freteNome = pedido.frete_modalidade ? (FRETE_LABEL[pedido.frete_modalidade] || pedido.frete_modalidade) : null;
  if (freteNome) {
    // O Hub NAO cobra frete: o valor so informa o time Boxer, que faz a cobranca (Andre, 2026-11-26).
    const cobrado = Number(pedido.valor_frete) > 0 ? ' — ' + brl(pedido.valor_frete) + ' a cobrar pela Boxer (fora do valor do pedido)' : ' — sem frete a cobrar';
    linhas.push('Frete: ' + freteNome + cobrado);
  }

  const itens = ctx.itens || [];
  const tabela = itens.reduce((s, i) => s + Number(i.preco_unitario ?? i.preco_final ?? 0) * Number(i.quantidade || 0), 0);
  const final = itens.reduce((s, i) => s + Number(i.preco_final ?? 0) * Number(i.quantidade || 0), 0);
  if (tabela - final >= 0.01) {
    const pct = (tabela - final) / tabela * 100;
    const classe = pedido.classe_comercial_aplicada
      ? ' — classe ' + pedido.classe_comercial_aplicada + ' (' + [pedido.segmento_aplicado, pedido.uf_aplicada].filter(Boolean).join('/') + ')'
      : '';
    linhas.push('Desconto: ' + brl(tabela - final) + ' (' + pct.toFixed(1).replace('.', ',') + '%) sobre a tabela' + classe);
  }
  // Desconto/excecao DIGITADO no item: preco_unitario e a tabela base (antes do multiplicador
  // de segmento -- no Hibrido/Ecommerce o preco da revenda e MAIOR que ela), entao o "de" do
  // desconto manual e reconstruido a partir do percentual: final / (1 - pct).
  for (const i of itens) {
    const pct = Number(i.desconto_item_percentual) || 0;
    const partes = [];
    if (pct > 0 && pct < 100) {
      const de = Math.round(Number(i.preco_final) / (1 - pct / 100) * 100) / 100;
      const qtd = Number(i.quantidade) || 0;
      partes.push('desconto de ' + String(pct).replace('.', ',') + '% — de ' + brl(de) + ' por ' + brl(i.preco_final) +
        ' (−' + brl((de - Number(i.preco_final)) * qtd) + ' no item)');
    }
    if (i.classe_override) partes.push('classe ' + i.classe_override);
    if (i.segmento_override) partes.push('segmento ' + i.segmento_override);
    if (partes.length) linhas.push('Item ' + i.sku + ' (' + i.quantidade + ' un): exceção de preço — ' + partes.join('; '));
  }

  if (ctx.feitoPor) {
    linhas.push('Pedido feito por: ' + ctx.feitoPor.nome + ' (' + ctx.feitoPor.tipo + ')');
  }
  if (pedido.entrega_agendada) {
    linhas.push('Entrega agendada: sim' + (pedido.prazo_entrega ? ' — ' + pedido.prazo_entrega : ''));
  }
  for (const e of ctx.excecoes || []) {
    linhas.push('Exceção aprovada: ' + [e.assunto, e.categoria && String(e.categoria).replace(/_/g, ' ')].filter(Boolean).join(' · ') +
      (e.por ? ' — por ' + e.por : '') + (e.em ? ' em ' + dataBr(e.em) : ''));
  }
  if (ctx.faturamentoParcial === true) linhas.push('Faturamento parcial: cliente aceita');
  else if (ctx.faturamentoParcial === false) linhas.push('Faturamento parcial: cliente NÃO aceita');

  return linhas.join('\n') || undefined;
}

async function zenFetch(metodo, path, body) {
  const headers = await zenAuth();
  const r = await fetch(ZEN_BASE + path, {
    method: metodo, headers, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error(metodo + ' ' + path + ' -> ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r;
}

const norm = (v) => (v == null ? '' : String(v)).trim();
const money = (v) => Number(v || 0).toFixed(2);
const chaveItem = (i) => i.packingId + '|' + Number(i.quantity) + '|' + money(i.unitValue);

// Le a venda no ZEN, compara com o que o Hub mandou e CORRIGE o que divergir.
// esperado: { freightType, terms:[dias], comments?, sellerId?, addressId?, itens:[{packingId, quantity, unitValue}] }
// Devolve { ok, divergencias:[texto], corrigidas:[texto], restantes:[texto] }.
// Nunca lanca por divergencia; so por falha de rede/ZEN na propria leitura.
async function conferirVenda(saleId, esperado) {
  const divergencias = [];
  const corrigidas = [];
  const termsEsperados = esperado.terms.map(t => Number(t) || 0);
  const pmEsperado = prazosTexto(termsEsperados);

  const ler = async () => {
    const [sale] = await zenGet('/sale/sale', { q: 'id==' + saleId, max: 1, limite: 1 });
    if (!sale) throw new Error('venda ' + saleId + ' nao encontrada no ZEN');
    const pags = await zenGet('/sale/salePayment', { q: 'sale.id==' + saleId, max: 50, limite: 50 });
    const itens = await zenGet('/sale/saleItem', { q: 'sale.id==' + saleId, max: 200, limite: 200 });
    return { sale, pags, itens };
  };

  const comparar = ({ sale, pags, itens }) => {
    const d = [];
    if (sale.freightType !== esperado.freightType) d.push('frete: ' + sale.freightType + ' -> ' + esperado.freightType);
    if (norm(sale.properties?.paymentMethods) !== pmEsperado) d.push('formas de pagamento: "' + norm(sale.properties?.paymentMethods) + '" -> "' + pmEsperado + '"');
    if (esperado.comments != null && norm(sale.properties?.comments) !== norm(esperado.comments)) d.push('observacoes');
    if (esperado.code != null && norm(sale.code) !== norm(esperado.code)) d.push('codigo (pedido do cliente): "' + norm(sale.code) + '" -> "' + norm(esperado.code) + '"');
    if (esperado.channel != null && norm(sale.properties?.salesChannel) !== norm(esperado.channel)) d.push('canal de vendas: "' + norm(sale.properties?.salesChannel) + '" -> "' + norm(esperado.channel) + '"');
    if (esperado.sellerId && sale.personSalesperson?.id !== Number(esperado.sellerId)) d.push('vendedor');
    if (esperado.addressId && sale.personAddressShipping?.id !== Number(esperado.addressId)) d.push('endereco de entrega');
    const termsAtuais = pags.map(p => Number(p.term) || 0).sort((a, b) => a - b);
    if (JSON.stringify(termsAtuais) !== JSON.stringify([...termsEsperados].sort((a, b) => a - b))) {
      d.push('parcelas: [' + termsAtuais.join('/') + '] -> [' + termsEsperados.join('/') + ']');
    }
    const atuais = itens.map(i => chaveItem({ packingId: i.productPacking?.id, quantity: i.quantity, unitValue: i.unitValue }));
    const esp = esperado.itens.map(chaveItem);
    const faltam = esp.filter(k => { const ix = atuais.indexOf(k); if (ix < 0) return true; atuais.splice(ix, 1); return false; });
    if (faltam.length) d.push('itens ausentes/diferentes: ' + faltam.length);
    return d;
  };

  let estado = await ler();
  divergencias.push(...comparar(estado));
  if (!divergencias.length) return { ok: true, divergencias, corrigidas, restantes: [] };

  // 1) cabecalho: um PUT so, com o objeto inteiro (medido: aceita freightType e paymentMethods
  //    em venda existente; e trocar paymentMethods faz o ZEN refazer as parcelas)
  const { sale } = estado;
  const nova = { ...sale, freightType: esperado.freightType,
    properties: { ...(sale.properties || {}), paymentMethods: pmEsperado } };
  if (esperado.comments != null) nova.properties.comments = esperado.comments;
  if (esperado.code != null) nova.code = esperado.code;
  if (esperado.channel != null) nova.properties.salesChannel = esperado.channel;
  if (esperado.sellerId) nova.personSalesperson = { id: Number(esperado.sellerId) };
  if (esperado.addressId) nova.personAddressShipping = { id: Number(esperado.addressId) };
  try { await zenFetch('PUT', '/sale/sale', nova); corrigidas.push('cabecalho (frete/pagamento/observacoes/vendedor/endereco)'); }
  catch (e) { divergencias.push('falha ao corrigir cabecalho: ' + e.message.slice(0, 150)); }

  estado = await ler();

  // 2) parcelas: se o PUT nao bastou, acerta linha a linha (apaga as que sobram, cria as que faltam)
  const pagsRestam = [...estado.pags];
  const faltamTerms = [];
  for (const t of termsEsperados) {
    const ix = pagsRestam.findIndex(p => (Number(p.term) || 0) === t);
    if (ix >= 0) pagsRestam.splice(ix, 1); else faltamTerms.push(t);
  }
  if (pagsRestam.length || faltamTerms.length) {
    try {
      for (const p of pagsRestam) await zenFetch('DELETE', '/sale/salePayment/' + p.id);
      for (const t of faltamTerms) await zenFetch('POST', '/sale/salePayment', { sale: { id: saleId }, type: 'BILLING_TITLE', term: t });
      corrigidas.push('parcelas');
    } catch (e) { divergencias.push('falha ao corrigir parcelas: ' + e.message.slice(0, 150)); }
    estado = await ler();
  }

  // 3) itens que faltam (nunca apaga item: so completa)
  const atuais = estado.itens.map(i => chaveItem({ packingId: i.productPacking?.id, quantity: i.quantity, unitValue: i.unitValue }));
  const faltamItens = esperado.itens.filter(i => { const ix = atuais.indexOf(chaveItem(i)); if (ix < 0) return true; atuais.splice(ix, 1); return false; });
  if (faltamItens.length) {
    try {
      for (const i of faltamItens) {
        await zenFetch('POST', '/sale/saleItem', { sale: { id: saleId }, productPacking: { id: i.packingId }, quantity: i.quantity, unitValue: i.unitValue });
      }
      corrigidas.push('itens (' + faltamItens.length + ')');
    } catch (e) { divergencias.push('falha ao completar itens: ' + e.message.slice(0, 150)); }
    estado = await ler();
  }

  const restantes = comparar(estado);
  return { ok: restantes.length === 0, divergencias, corrigidas, restantes };
}

module.exports = { freightTypeZen, prazosTexto, conferirVenda, observacoesPedido, FRETE_LABEL };
