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

module.exports = { zenAuth, zenGet, rsql, normDoc, ZEN_BASE, ZEN_TENANT };
