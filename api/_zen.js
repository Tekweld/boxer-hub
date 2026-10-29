// Cliente da API Zen ERP — compartilhado por todos os conectores do Hub.
//
// Padrao de autenticacao e sintaxe de filtro descobertos a partir de
// Tekweld/bav-boxer (scripts/zen_importador.py), que ja roda em producao.
// Ver docs/INTEGRACAO-ZEN-HUB.md.

const ZEN_BASE   = process.env.ZEN_BASE_URL || 'https://api.zenerp.app.br';
const ZEN_TENANT = process.env.ZEN_TENANT   || 'boxer';

let _tokenCache = null;   // { token, obtidoEm }
const TOKEN_TTL_MS = 30 * 60 * 1000;

/**
 * Autentica no Zen e devolve os headers prontos.
 *
 * Cuidado: o endpoint NAO e /auth/login (esse existe na spec mas usa outro
 * contrato) e a resposta NAO e JSON — vem o token em texto puro, entre aspas.
 */
async function zenAuth(forcar = false) {
  if (!forcar && _tokenCache && (Date.now() - _tokenCache.obtidoEm) < TOKEN_TTL_MS) {
    return _tokenCache.headers;
  }

  const email = process.env.ZEN_EMAIL;
  const senha = process.env.ZEN_SENHA;
  if (!email || !senha) throw new Error('ZEN_EMAIL / ZEN_SENHA nao configurados');

  const r = await fetch(`${ZEN_BASE}/system/security/tokenOpRequest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'tenant': ZEN_TENANT },
    body: JSON.stringify({ email, password: senha })
  });
  if (!r.ok) throw new Error(`Falha na autenticacao Zen: ${r.status} ${await r.text()}`);

  const token = (await r.text()).trim().replace(/^"|"$/g, '');
  if (!token) throw new Error('Zen devolveu token vazio');

  const headers = {
    'Authorization': `Bearer ${token}`,
    'tenant': ZEN_TENANT,
    'Content-Type': 'application/json'
  };
  _tokenCache = { headers, obtidoEm: Date.now() };
  return headers;
}

/**
 * GET paginado com protecao anti-ciclo.
 *
 * A API Zen tem um bug conhecido: certas queries entram em loop apos o ultimo
 * item real, devolvendo eternamente a mesma pagina. O bav-boxer contorna
 * fatiando por dia e detectando ids repetidos — a mesma defesa vale aqui.
 *
 * Para de paginar quando: pagina menor que `max`, pagina vazia, nenhum id novo,
 * ou o teto de seguranca e atingido.
 */
async function zenGet(path, { q = null, order = null, max = 200, limite = 20000, first: primeiroOffset = 0 } = {}) {
  const headers = await zenAuth();
  const out = [];
  const vistos = new Set();

  for (let first = primeiroOffset; out.length < limite; first += max) {
    const qs = new URLSearchParams({ first: String(first), max: String(max) });
    if (q) qs.set('q', q);
    if (order) qs.set('order', order);

    let r = await fetch(`${ZEN_BASE}${path}?${qs}`, { headers });

    // token pode expirar no meio de uma varredura longa
    if (r.status === 401 || r.status === 403) {
      r = await fetch(`${ZEN_BASE}${path}?${qs}`, { headers: await zenAuth(true) });
    }
    if (!r.ok) throw new Error(`Zen GET ${path} -> ${r.status} ${await r.text()}`);

    const lote = await r.json();
    if (!Array.isArray(lote) || lote.length === 0) break;

    let novos = 0;
    for (const item of lote) {
      const id = item?.id ?? JSON.stringify(item);
      if (vistos.has(id)) continue;
      vistos.add(id);
      out.push(item);
      novos++;
    }

    // anti-ciclo: a pagina veio cheia mas sem nada novo
    if (novos === 0) break;
    if (lote.length < max) break;
  }

  return out;
}

/**
 * Sintaxe de filtro do Zen (RSQL/FIQL):
 *   ;   AND          ,   OR
 *   ==  igual        !=  diferente
 *   >=  <=  >  <     comparacao
 *   ( ) agrupamento
 *   navegacao por ponto: sale.invoice.date
 *
 * Ex: 'sale.invoice.flow==OUT;(status==APPROVED,status==SHIPMENT)'
 */
const rsql = {
  and: (...partes) => partes.filter(Boolean).join(';'),
  or:  (...partes) => '(' + partes.filter(Boolean).join(',') + ')',
  eq:  (campo, valor) => `${campo}==${valor}`,
  gte: (campo, valor) => `${campo}>=${valor}`,
  lte: (campo, valor) => `${campo}<=${valor}`
};

/** Normaliza CNPJ/CPF para so digitos — chave de casamento com o Hub. */
function normDoc(v) {
  return String(v || '').replace(/\D/g, '');
}

/**
 * Qualquer objeto do Zen que carregue uma empresa (venda.company, assetTag,
 * creditLine, etc.) expande o Person dela inteiro — e o Person da propria
 * Tekweld/Boxer guarda em `properties.comments` senha e dado bancario em
 * texto puro. Vazou numa sessao de debug em 2026-10-28 (ver sync-pedidos-zen.js
 * e sync-zen-clientes.js). Remove esse campo recursivamente de qualquer
 * payload que v for exposto por um endpoint de diagnostico — nunca devolver
 * um objeto cru do Zen sem passar por aqui antes.
 */
function removerComentariosSensiveis(valor, profundidade = 0) {
  if (!valor || typeof valor !== 'object' || profundidade > 8) return valor;
  if (Array.isArray(valor)) return valor.map(v => removerComentariosSensiveis(v, profundidade + 1));
  const limpo = {};
  for (const [chave, v] of Object.entries(valor)) {
    if (chave === 'properties' && v && typeof v === 'object' && 'comments' in v) {
      const { comments, ...resto } = v;
      limpo[chave] = resto;
      continue;
    }
    limpo[chave] = removerComentariosSensiveis(v, profundidade + 1);
  }
  return limpo;
}

/**
 * Documento fiscal real (XML + DANFE) de uma nota de saida.
 *
 * NAO vem de /system/report/reportOpGenerate (esse so gera template vazio
 * generico, sempre o mesmo tamanho -- investigado e descartado em 2026-10-28).
 * O Zen gera XML e PDF uma vez, na autorizacao da SEFAZ, e guarda os dois como
 * arquivo pronto no registro fiscal.br.DfeNfeProcOut, achado via
 * GET /fiscal/br/dfeNfeProcOut?q=invoice.id==<outgoingInvoiceId>:
 *   - `file`       -> system.file.File do XML
 *   - `fileDanfe`  -> system.file.File do PDF (DANFE)
 * Baixar o binario de um File: POST /system/file/fileOpReadContent/{id}
 * (GET devolve 405 -- confirmado por teste, nao esta na doc).
 *
 * `status` do DfeNfeProcOut pode vir ERROR (emissao falhou): nesse caso
 * fileDanfe fica null e nao ha o que baixar -- tratar como "nao disponivel",
 * nao como bug.
 */
async function zenBuscarDfeNfeProcOut(outgoingInvoiceId) {
  const regs = await zenGet('/fiscal/br/dfeNfeProcOut', { q: 'invoice.id==' + outgoingInvoiceId, max: 10 });
  return regs?.[0] || null;
}

async function zenBaixarArquivo(fileId) {
  const headers = await zenAuth();
  const r = await fetch(`${ZEN_BASE}/system/file/fileOpReadContent/${fileId}`, { method: 'POST', headers });
  if (!r.ok) throw new Error(`fileOpReadContent ${fileId} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return buf;
}

/**
 * Resolve, em lote, invoice.id -> sale.id. `sale.Sale` tem campo `invoice`
 * direto (achado via debug_schema em 2026-10-29, confirmado com dado real:
 * venda 51705 <-> invoice 74838). E assim que NF e titulo (que so guardam
 * invoice.id) linkam de volta ao pedido do Hub (hub_pedidos.erp_pedido_id =
 * String(sale.id)). RSQL nao documenta "in" -- agrupa por OR em chunks para
 * nao estourar o tamanho da URL. Venda sem tag 'HUB,...' (nao veio do Hub)
 * simplesmente nao da match em hub_pedidos depois -- comportamento esperado,
 * nao erro.
 */
async function zenBuscarVendasPorInvoiceIds(invoiceIds, tamanhoChunk = 40) {
  const ids = [...new Set(invoiceIds.filter(Boolean).map(String))];
  const mapa = {};
  for (let i = 0; i < ids.length; i += tamanhoChunk) {
    const fatia = ids.slice(i, i + tamanhoChunk);
    const q = '(' + fatia.map((id) => 'invoice.id==' + id).join(',') + ')';
    const vendas = await zenGet('/sale/sale', { q, max: fatia.length, limite: fatia.length });
    for (const v of vendas) {
      if (v.invoice?.id) mapa[String(v.invoice.id)] = String(v.id);
    }
  }
  return mapa;
}

/**
 * Resolve, em lote, invoice.id -> {chNFe, status} via fiscal.br.DfeNfeProcOut.
 * Serve para preencher chave_acesso -- outgoingInvoice (fiscal.OutgoingInvoice)
 * NAO tem campo accessKey/key (o codigo antigo assumia isso e chave_acesso
 * sempre vinha null; a chave de verdade mora no documento fiscal, nao na
 * nota em si -- ver zenBuscarDfeNfeProcOut).
 */
async function zenBuscarDfeInfoPorInvoiceIds(invoiceIds, tamanhoChunk = 40) {
  const ids = [...new Set(invoiceIds.filter(Boolean).map(String))];
  const mapa = {};
  for (let i = 0; i < ids.length; i += tamanhoChunk) {
    const fatia = ids.slice(i, i + tamanhoChunk);
    const q = '(' + fatia.map((id) => 'invoice.id==' + id).join(',') + ')';
    const regs = await zenGet('/fiscal/br/dfeNfeProcOut', { q, max: fatia.length, limite: fatia.length });
    for (const d of regs) {
      if (d.invoice?.id) mapa[String(d.invoice.id)] = { chNFe: d.chNFe || null, status: d.status || null };
    }
  }
  return mapa;
}

module.exports = {
  zenAuth, zenGet, rsql, normDoc, removerComentariosSensiveis, ZEN_BASE, ZEN_TENANT,
  zenBuscarDfeNfeProcOut, zenBaixarArquivo, zenBuscarVendasPorInvoiceIds, zenBuscarDfeInfoPorInvoiceIds
};
