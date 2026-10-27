// Orcamentos da tabela de Revendas (tabela-teste.html?t=1 -> orcamento.html).
//
// Roteado por push-pedido.js (?target=orcamento) por causa do limite de
// Serverless Functions da Vercel -- este arquivo comeca com "_" e nao conta.
//
// Fluxo: o representante cria o orcamento (preco recalculado AQUI, nunca
// confiado ao navegador) -> a venda nasce no ZEN em PREPARING (ainda nao e
// pedido: nao entra na fila do time, ver ZEN-ERP-CONHECIMENTO.md 4.3) ->
// o cliente aceita pelo link -> o representante confirma -> o pedido avanca
// ate "WEB Pronta entrega".
//
// Acoes (POST, body.acao):
//   cliente   {cnpj}                -> dados do cliente a partir do cadastro sincronizado do ZEN
//   criar     {...}                 -> cria orcamento (+ venda PREPARING no ZEN; dry:true so simula)
//   listar    {}                    -> orcamentos do usuario logado
//   aprovar   {id}                  -> confirma o aceite e avanca a venda no ZEN
//   avisar    {token}               -> (publica) avisa o representante por e-mail que o cliente aceitou
const { zenAuth, zenGet, ZEN_BASE } = require('./_zen');

const SB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtZXB4Y25yc29mb2Zvc3d1YnV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MTczNzMsImV4cCI6MjA5NTI5MzM3M30.S55ouFczRYlUYNFf5PotYKXBPT5idypTSmbzR-x2Pk0';
const ZEN_COMPANY_ID = 1009;      // TEKSP -- representa a Boxer
const ZEN_SALE_PROFILE_ID = 1001; // workflow "Venda padrao"
const ZEN_WORKFLOW_ID = 1001;
const CAMINHO_ZEN = ['inicio', 'orcamento', 'webProntaEntrega'];
const VALIDADE_DIAS = 7;
const DIAS_POR_PARCELA = 28;
const LINK_ORCAMENTO = 'https://app.boxersoldas.com.br/orcamento.html?t=';
const APP_TABELA = 'https://app.boxersoldas.com.br/tabela-teste.html?t=1';
const CLASSES_VALOR_FISICA = [[1, 20000], [2, 7000], [3, -1]];
const COND_PADRAO = { pedMin: 3000, dupMin: 800, vista: 3 };

module.exports = async function orcamento(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://app.boxersoldas.com.br');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });
  const body = req.body || {};
  const ctx = { SB_SERVICE };

  try {
    if (body.acao === 'avisar') return res.status(200).json(await avisarAceite(ctx, body.token));

    const user = await autenticar(req);
    if (!user) return res.status(401).json({ error: 'Sessao invalida ou sem acesso a tabela' });

    switch (body.acao) {
      case 'cliente': return res.status(200).json(await buscarCliente(ctx, body.cnpj));
      case 'criar': return res.status(200).json(await criar(ctx, user, body));
      case 'listar': return res.status(200).json(await listar(ctx, user));
      case 'aprovar': return res.status(200).json(await aprovar(ctx, user, body.id));
      default: return res.status(400).json({ error: 'acao invalida' });
    }
  } catch (e) {
    if (e.http) return res.status(e.http).json({ error: e.message });
    console.error('[orcamento] erro:', e);
    return res.status(500).json({ error: e.message });
  }
};

function erro(http, msg) { const e = new Error(msg); e.http = http; return e; }

// ---------- infraestrutura ----------
function sbH(ctx, extra) {
  return Object.assign({ apikey: ctx.SB_SERVICE, Authorization: 'Bearer ' + ctx.SB_SERVICE, 'Content-Type': 'application/json' }, extra || {});
}
async function sbGet(ctx, path, schema) {
  const r = await fetch(SB_URL + '/rest/v1' + path, { headers: sbH(ctx, schema ? { 'Accept-Profile': schema } : {}) });
  if (!r.ok) throw new Error('Supabase GET ' + path.split('?')[0] + ' -> ' + r.status);
  return r.json();
}
async function orcWrite(ctx, method, path, bodyObj) {
  const r = await fetch(SB_URL + '/rest/v1' + path, {
    method, headers: sbH(ctx, { 'Content-Profile': 'comercial', 'Accept-Profile': 'comercial', Prefer: 'return=representation' }),
    body: JSON.stringify(bodyObj)
  });
  if (!r.ok) throw new Error('Supabase ' + method + ' orcamentos -> ' + r.status + ' ' + (await r.text()).slice(0, 300));
  return r.json();
}

// quem chama precisa estar logado por codigo e liberado na tabela (mesma regra da tela)
async function autenticar(req) {
  const auth = req.headers.authorization;
  if (!auth || !/^Bearer /i.test(auth)) return null;
  const u = await fetch(SB_URL + '/auth/v1/user', { headers: { Authorization: auth, apikey: SB_ANON } });
  if (!u.ok) return null;
  const caller = await u.json();
  if (!caller || !caller.id) return null;
  const a = await fetch(SB_URL + '/rest/v1/rpc/tabela_acesso', {
    method: 'POST', headers: { Authorization: auth, apikey: SB_ANON, 'Content-Type': 'application/json' }, body: '{}'
  });
  if (!a.ok) return null;
  const acesso = await a.json();
  if (!acesso || !acesso.permitido) return null;
  return { id: caller.id, email: caller.email, nome: acesso.nome || caller.email, role: acesso.role };
}

// ---------- regras da tabela (texto editavel no admin) ----------
function numBR(s) { return parseFloat(String(s).replace(/[^\d,]/g, '').replace(',', '.')); }
function lerRegras(regras) {
  const txt = regras.map(r => r.conteudo || '').join('\n');
  const c = Object.assign({}, COND_PADRAO);
  let m;
  if ((m = txt.match(/Pedido (?:normal|m[ií]nimo):\s*R\$\s*([\d.]+)/i))) c.pedMin = numBR(m[1]);
  if ((m = txt.match(/duplicata:\s*R\$\s*([\d.]+)/i))) c.dupMin = numBR(m[1]);
  if ((m = txt.match(/(\d+(?:,\d+)?)% de desconto à vista/i)) || (m = txt.match(/à vista:\s*(\d+(?:,\d+)?)% de desconto/i))) c.vista = numBR(m[1]);
  return { cond: c, linhas: txt.split(/\r?\n/) };
}
function freteDaUF(linhas, uf) {
  for (const l of linhas) {
    const c = l.split(' | ').map(s => s.trim());
    if (c.length >= 3 && c[0].split(',').map(s => s.trim()).includes(uf)) {
      if (/FOB/i.test(c[1])) return { tipo: 'FOB' };
      return { tipo: 'CIF', min: numBR(c[2]), frete: numBR(c[3] || '') };
    }
  }
  return null;
}

function soDigitos(v) { return String(v || '').replace(/\D/g, ''); }
function r2(n) { return Math.round(n * 100) / 100; }
function brl(n) { return Number(n || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

// ---------- cliente ----------
async function buscarCliente(ctx, cnpjIn) {
  const cnpj = soDigitos(cnpjIn);
  if (cnpj.length !== 14 && cnpj.length !== 11) throw erro(400, 'Informe um CNPJ (14 digitos) ou CPF (11)');
  const rows = await sbGet(ctx, '/hub_clientes?cnpj=eq.' + cnpj + '&select=razao_social,nome_fantasia,nome_exibicao,inscricao_estadual,email_principal,telefone,cidade,uf,erp_cliente_id,bloqueado&limit=1', 'comercial');
  const c = rows[0];
  if (!c) return { encontrado: false, cnpj };
  return {
    encontrado: true, cnpj,
    razao_social: c.razao_social, nome_fantasia: c.nome_fantasia || c.nome_exibicao || '',
    ie: c.inscricao_estadual || '', email: c.email_principal || '', telefone: c.telefone || '',
    cidade: c.cidade || '', uf: c.uf || '', bloqueado: !!c.bloqueado, no_zen: !!c.erp_cliente_id
  };
}

// ---------- criar ----------
async function criar(ctx, user, b) {
  if (Number(b.tabela) !== 1) throw erro(400, 'Orcamento disponivel apenas na tabela de Revendas');
  const uf = String(b.uf || '').toUpperCase();
  const seg = String(b.segmento || '');
  const cls = parseInt(b.classe);
  const itensIn = Array.isArray(b.itens) ? b.itens.filter(i => i && i.codigo && parseInt(i.qtd) > 0) : [];
  if (itensIn.length !== new Set(itensIn.map(i => String(i.codigo))).size) throw erro(400, 'Item repetido no orcamento');
  if (!itensIn.length) throw erro(400, 'Nenhum item no orcamento');
  if (itensIn.length > 60) throw erro(400, 'Itens demais para um orcamento');
  const cl = b.cliente || {};
  const cnpj = soDigitos(cl.cnpj);
  if (!cl.nome || !String(cl.nome).trim()) throw erro(400, 'Informe o nome do cliente');
  if (cnpj.length !== 14 && cnpj.length !== 11) throw erro(400, 'CNPJ/CPF do cliente invalido');
  if (!cl.email || !/^\S+@\S+\.\S+$/.test(cl.email)) throw erro(400, 'Informe o e-mail do cliente');
  if (soDigitos(cl.celular).length < 10) throw erro(400, 'Informe o celular do cliente (com DDD)');

  // precos recalculados no servidor, com a mesma formula da tabela
  const codigos = [...new Set(itensIn.map(i => String(i.codigo)))];
  const lista = codigos.map(c => '"' + c.replace(/"/g, '') + '"').join(',');
  const [estados, mults, prods, regras, cats] = await Promise.all([
    sbGet(ctx, '/estados?uf=eq.' + encodeURIComponent(uf) + '&select=uf,mult_4_icms,mult_total'),
    sbGet(ctx, '/multiplicadores?tabela_id=eq.4&segmento=eq.' + encodeURIComponent(seg) + '&classe=eq.' + cls + '&select=porte,categoria_grupo,valor'),
    sbGet(ctx, '/produtos?tabela_id=eq.1&ativo=eq.true&codigo=in.(' + encodeURIComponent(lista) + ')&select=codigo,modelo,pv_sp,porte,icms,ipi,ncm,categoria_id,imagem_url'),
    sbGet(ctx, '/tabela_regras?tabela_id=eq.1&select=conteudo&order=ordem,id'),
    sbGet(ctx, '/categorias?tabela_id=eq.1&select=id,nome')
  ]);
  const st = estados[0];
  if (!st) throw erro(400, 'UF invalida');
  const M = {}; mults.forEach(m => { M[m.porte] = parseFloat(m.valor); });
  if (!Object.keys(M).length) throw erro(400, 'Segmento/classe sem preco na tabela');
  const pby = {}; prods.forEach(p => { pby[p.codigo] = p; });
  const catNome = {}; cats.forEach(c => { catNome[c.id] = c.nome; });
  const { cond, linhas } = lerRegras(regras);

  const avista = b.pagamento && b.pagamento.tipo === 'avista';
  const parcelas = avista ? 1 : Math.min(4, Math.max(1, parseInt(b.pagamento && b.pagamento.parcelas) || 1));
  const fator = avista ? 1 - cond.vista / 100 : 1;
  const itens = [];
  let totalTabela = 0;
  for (const i of itensIn) {
    const p = pby[String(i.codigo)];
    if (!p) throw erro(400, 'Produto ' + i.codigo + ' nao encontrado na tabela');
    const scm = M[p.porte];
    if (scm === undefined) throw erro(400, 'Produto ' + i.codigo + ' sem preco para este segmento/classe');
    const tb = p.pv_sp * parseFloat(st.mult_4_icms) / (1 - parseFloat(st.mult_total) / 100);
    const unitTabela = r2(tb * scm);
    const unit = r2(unitTabela * fator);
    const q = parseInt(i.qtd);
    totalTabela += unitTabela * q;
    const dk = ['ok', 'prev', 'sem', 'sem_info'].includes(i.disp) ? i.disp : 'sem_info';
    const prev = dk === 'prev' && /^\d{4}-\d{2}-\d{2}/.test(String(i.previsao || '')) ? String(i.previsao).slice(0, 10) : null;
    itens.push({
      codigo: p.codigo, modelo: p.modelo, categoria: catNome[p.categoria_id] || '', qtd: q,
      unit_tabela: unitTabela, unit, subtotal: r2(unit * q),
      ncm: p.ncm || '', ipi: Number(p.ipi) || 0, icms: uf === 'SP' ? Number(p.icms) || 0 : 4,
      imagem_url: p.imagem_url || '', estoque: dk, previsao: prev
    });
  }
  const totalItens = r2(itens.reduce((a, x) => a + x.subtotal, 0));

  // avisos (so informativos: o time ve na lista, nao bloqueia)
  const avisos = [];
  if (seg === 'Física') {
    let ind = null;
    for (const [c, min] of CLASSES_VALOR_FISICA) {
      let t = 0; let ok = true;
      for (const i of itensIn) {
        const p = pby[String(i.codigo)];
        const mm = (await classeMult(ctx, seg, c, p.porte));
        if (mm == null) { ok = false; break; }
        t += p.pv_sp * parseFloat(st.mult_4_icms) / (1 - parseFloat(st.mult_total) / 100) * mm * parseInt(i.qtd);
      }
      if (ok && t > min) { ind = c; break; }
    }
    if (ind && ind !== cls) avisos.push('Classe ' + cls + ' usada, mas pelo valor do pedido a classe indicada era a ' + ind);
  }
  const nSem = itens.filter(x => x.estoque === 'sem').length;
  if (nSem) avisos.push(nSem + (nSem > 1 ? ' itens' : ' item') + ' sem previsao de estoque incluido(s) no orcamento');
  if (totalItens < cond.pedMin) avisos.push('Abaixo do pedido minimo de ' + brl(cond.pedMin));
  const fr = freteDaUF(linhas, uf);
  let freteTipo = fr ? fr.tipo : null, freteValor = 0;
  if (fr && fr.tipo === 'CIF' && fr.min && totalItens < fr.min) {
    freteValor = fr.frete || 0;
    avisos.push('Abaixo do pedido minimo CIF (' + brl(fr.min) + '): frete fixo de ' + brl(freteValor));
  }
  if (!avista && parcelas > 1 && totalItens / parcelas < cond.dupMin) avisos.push('Parcela abaixo do minimo de ' + brl(cond.dupMin) + ' por duplicata');

  // cliente no ZEN (cadastro sincronizado no Hub)
  const hc = (await sbGet(ctx, '/hub_clientes?cnpj=eq.' + cnpj + '&select=erp_cliente_id,bloqueado&limit=1', 'comercial'))[0];
  const zenPerson = hc && hc.erp_cliente_id ? Number(hc.erp_cliente_id) : null;
  if (hc && hc.bloqueado) avisos.push('Cliente bloqueado no ZEN');

  const row = {
    tabela_id: 1, user_id: user.id, vendedor_nome: user.nome, vendedor_email: user.email,
    vendedor_telefone: soDigitos(b.vendedor && b.vendedor.telefone) || null,
    uf, segmento: seg, classe: cls,
    cliente_nome: String(cl.nome).trim(), cliente_fantasia: cl.fantasia || null, cliente_cnpj: cnpj, cliente_ie: cl.ie || null,
    cliente_email: String(cl.email).trim().toLowerCase(), cliente_celular: soDigitos(cl.celular), cliente_telefone: soDigitos(cl.telefone) || null,
    cliente_contato: cl.contato || null, cliente_cidade: cl.cidade || null, cliente_uf: cl.uf || uf, cliente_endereco: cl.endereco || null,
    zen_person_id: zenPerson,
    pagamento_tipo: avista ? 'avista' : 'boleto', parcelas, desconto_vista_pct: avista ? cond.vista : 0,
    frete_tipo: freteTipo, frete_valor: freteValor,
    observacoes: b.observacoes ? String(b.observacoes).slice(0, 1500) : null,
    avisos, itens, total_itens: totalItens, total_final: r2(totalItens + freteValor),
    validade_em: new Date(Date.now() + VALIDADE_DIAS * 86400000).toISOString()
  };

  if (b.dry) {
    const zen = zenPerson ? await montarVendaZen(row, { codigo: 'ORC-DRY' }, itens) : null;
    return { ok: true, dry: true, orcamento: row, zen_pronto: !!zen, zen };
  }

  const [orc] = await orcWrite(ctx, 'POST', '/orcamentos', row);
  const out = { ok: true, id: orc.id, codigo: orc.codigo, link: LINK_ORCAMENTO + orc.token, validade_em: orc.validade_em, avisos, total_final: orc.total_final };

  // a venda no ZEN nasce em PREPARING (so "orcamento": nao entra na fila do time)
  if (!zenPerson) {
    await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + orc.id, { zen_status: 'sem_cliente_zen', zen_erro: 'CNPJ nao encontrado no cadastro de clientes do ZEN' });
    out.zen = { ok: false, erro: 'Cliente ainda nao cadastrado no ZEN. O orcamento foi gerado normalmente; o cadastro precisa ser feito antes de aprovar.' };
    return out;
  }
  try {
    const sale = await criarVendaZen(row, orc, itens);
    await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + orc.id, { zen_sale_id: sale.id, zen_status: sale.parcial ? 'parcial' : 'preparando', zen_erro: sale.parcial || null });
    out.zen = { ok: !sale.parcial, sale_id: sale.id, erro: sale.parcial || null };
  } catch (e) {
    await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + orc.id, { zen_status: 'erro', zen_erro: String(e.message).slice(0, 400) });
    out.zen = { ok: false, erro: 'Orcamento gerado, mas nao foi possivel salvar no ZEN agora: ' + e.message.slice(0, 160) };
  }
  return out;
}

const _multCache = {};
async function classeMult(ctx, seg, cls, porte) {
  const k = seg + '|' + cls;
  if (!_multCache[k]) {
    const r = await sbGet(ctx, '/multiplicadores?tabela_id=eq.4&segmento=eq.' + encodeURIComponent(seg) + '&classe=eq.' + cls + '&select=porte,valor');
    const m = {}; r.forEach(x => { m[x.porte] = parseFloat(x.valor); });
    _multCache[k] = m;
  }
  const v = _multCache[k][porte];
  return v === undefined ? null : v;
}

// ---------- ZEN ----------
async function montarVendaZen(o, orc, itens) {
  const resolvidos = [];
  for (const it of itens) {
    const prod = await zenGet('/catalog/product/product', { q: 'code==' + it.codigo, max: 1, limite: 1 });
    if (!prod.length) throw new Error('produto ' + it.codigo + ' nao encontrado no ZEN');
    const pack = await zenGet('/catalog/product/productPacking', { q: 'product.id==' + prod[0].id, max: 1, limite: 1 });
    if (!pack.length) throw new Error('embalagem do produto ' + it.codigo + ' nao encontrada no ZEN');
    resolvidos.push({ sku: it.codigo, productPacking: { id: pack[0].id }, quantity: it.qtd, unitValue: it.unit });
  }
  let addr = null;
  try { addr = (await zenGet('/catalog/person/personAddress', { q: 'person.id==' + o.zen_person_id, max: 1, limite: 1 }))[0]; } catch (_) {}
  const comentarios = [
    'Orçamento ' + orc.codigo + ' (link enviado ao cliente; validade ' + VALIDADE_DIAS + ' dias)',
    'Representante: ' + o.vendedor_nome + (o.vendedor_telefone ? ' · ' + o.vendedor_telefone : ''),
    o.pagamento_tipo === 'avista' ? 'Pagamento à vista (' + o.desconto_vista_pct + '% de desconto)' : 'Boleto em ' + o.parcelas + 'x',
    o.observacoes || null
  ].filter(Boolean).join(' — ');
  const sale = {
    company: { id: ZEN_COMPANY_ID },
    person: { id: Number(o.zen_person_id) },
    saleProfile: { id: ZEN_SALE_PROFILE_ID },
    tags: 'ORCAMENTO,' + orc.codigo,
    freightType: o.frete_tipo === 'CIF' ? 'ISSUER' : (o.frete_tipo === 'FOB' ? 'RECIPIENT' : 'NONE'),
    properties: { comments: comentarios }
  };
  if (addr) sale.personAddressShipping = { id: addr.id };
  const pagamentos = o.pagamento_tipo === 'avista'
    ? [{ type: 'BILLING_TITLE', term: 0 }]
    : Array.from({ length: o.parcelas }, (_, i) => ({ type: 'BILLING_TITLE', term: (i + 1) * DIAS_POR_PARCELA }));
  return { sale, itens: resolvidos, pagamentos };
}

async function criarVendaZen(o, orc, itens) {
  const m = await montarVendaZen(o, orc, itens);
  const headers = await zenAuth();
  const sr = await fetch(ZEN_BASE + '/sale/sale', { method: 'POST', headers, body: JSON.stringify(m.sale) });
  if (!sr.ok) throw new Error('criar venda: ' + (await sr.text()).slice(0, 200));
  const sale = await sr.json();
  const falhas = [];
  for (const it of m.itens) {
    const r = await fetch(ZEN_BASE + '/sale/saleItem', { method: 'POST', headers, body: JSON.stringify({ sale: { id: sale.id }, productPacking: it.productPacking, quantity: it.quantity, unitValue: it.unitValue }) });
    if (!r.ok) falhas.push(it.sku + ': ' + (await r.text()).slice(0, 120));
  }
  for (const p of m.pagamentos) {
    const r = await fetch(ZEN_BASE + '/sale/salePayment', { method: 'POST', headers, body: JSON.stringify({ sale: { id: sale.id }, type: p.type, term: p.term }) });
    if (!r.ok) falhas.push('pagamento ' + p.term + 'd: ' + (await r.text()).slice(0, 120));
  }
  return { id: sale.id, parcial: falhas.length ? 'Venda ' + sale.id + ' criada com falhas: ' + falhas.join(' | ').slice(0, 350) : null };
}

// ---------- listar ----------
async function listar(ctx, user) {
  const rows = await sbGet(ctx, '/orcamentos?user_id=eq.' + user.id + '&ativo=eq.true&order=criado_em.desc&limit=100&select=id,codigo,token,cliente_nome,cliente_cnpj,total_final,status,validade_em,criado_em,visualizacoes,ultima_visualizacao_em,aceito_em,aprovado_em,zen_sale_id,zen_status,zen_erro,avisos,pagamento_tipo,parcelas', 'comercial');
  const agora = Date.now();
  return {
    ok: true,
    orcamentos: rows.map(r => Object.assign({}, r, {
      link: LINK_ORCAMENTO + r.token,
      expirado: new Date(r.validade_em).getTime() < agora && ['enviado', 'visualizado'].includes(r.status)
    }))
  };
}

// ---------- aprovar: PREPARING -> PREPARED -> inicio -> orcamento -> WEB Pronta entrega ----------
async function aprovar(ctx, user, id) {
  if (!id) throw erro(400, 'id obrigatorio');
  const o = (await sbGet(ctx, '/orcamentos?id=eq.' + encodeURIComponent(id) + '&user_id=eq.' + user.id + '&select=*', 'comercial'))[0];
  if (!o) throw erro(404, 'Orcamento nao encontrado');
  if (o.status === 'aprovado') return { ok: true, ja_aprovado: true, zen_sale_id: o.zen_sale_id };
  // o representante pode confirmar mesmo sem o aceite no link (ex.: o cliente aceitou por telefone)
  if (!['enviado', 'visualizado', 'aceito_cliente'].includes(o.status)) throw erro(409, 'Este orcamento esta ' + o.status + ' e nao pode ser enviado ao ZEN');
  if (!o.zen_sale_id) throw erro(409, o.zen_status === 'sem_cliente_zen'
    ? 'Cliente nao cadastrado no ZEN: cadastre o cliente e peca a Boxer para vincular a venda.'
    : 'Este orcamento nao tem venda no ZEN.');

  const headers = await zenAuth();
  const sid = o.zen_sale_id;
  const passos = [];
  try {
    const sale = (await zenGet('/sale/sale', { q: 'id==' + sid, max: 1, limite: 1 }))[0];
    if (!sale) throw new Error('venda ' + sid + ' nao existe mais no ZEN');
    if (sale.status === 'CANCELED') throw new Error('a venda ' + sid + ' esta cancelada no ZEN');
    if (sale.status === 'PREPARING') {
      const r = await fetch(ZEN_BASE + '/sale/saleOpPrepare/' + sid, { method: 'POST', headers });
      if (!r.ok) throw new Error('finalizar preparacao: ' + (await r.text()).slice(0, 250));
      passos.push('preparada');
    }
    const nodes = await zenGet('/system/workflow/workflowNode', { q: 'workflow.id==' + ZEN_WORKFLOW_ID, max: 100, limite: 100 });
    const nodeId = {}; nodes.forEach(n => { nodeId[n.code] = n.id; });
    for (let tent = 0; tent < 5; tent++) {
      const wp = (await zenGet('/system/workflow/workpiece', { q: 'source=="/sale/sale:' + sid + '"', max: 1, limite: 1 }))[0];
      if (!wp) throw new Error('a venda ainda nao entrou no fluxo (workpiece ausente)');
      const atual = wp.workflowNode && wp.workflowNode.code;
      if (atual === 'webProntaEntrega') break;
      const idx = CAMINHO_ZEN.indexOf(atual);
      if (idx < 0) throw new Error('a venda esta na etapa "' + (atual || '?') + '", fora do caminho do orcamento; avance manualmente no ZEN');
      const destino = CAMINHO_ZEN[idx + 1];
      if (!nodeId[destino]) throw new Error('etapa ' + destino + ' nao encontrada no fluxo do ZEN');
      const r = await fetch(ZEN_BASE + '/system/workflow/workpieceOpForward/' + wp.id + '?workflowNodeId=' + nodeId[destino], { method: 'POST', headers });
      if (!r.ok) throw new Error('avancar para ' + destino + ': ' + (await r.text()).slice(0, 250));
      passos.push(destino);
    }
  } catch (e) {
    await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + o.id, { zen_status: 'erro_avanco', zen_erro: String(e.message).slice(0, 400) });
    throw erro(502, 'Nao foi possivel concluir no ZEN (' + (passos.join(' > ') || 'nenhuma etapa feita') + '): ' + e.message.slice(0, 200));
  }
  await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + o.id, { status: 'aprovado', aprovado_em: new Date().toISOString(), zen_status: 'web_pronta_entrega', zen_erro: null, atualizado_em: new Date().toISOString() });
  return { ok: true, zen_sale_id: sid, passos };
}

// ---------- aviso ao representante (publico, so por token) ----------
async function avisarAceite(ctx, token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ''))) throw erro(400, 'token invalido');
  const o = (await sbGet(ctx, '/orcamentos?token=eq.' + token + '&select=id,codigo,vendedor_email,vendedor_nome,cliente_nome,total_final,status,aceito_em,aceito_nome', 'comercial').catch(() => null));
  const row = Array.isArray(o) ? o[0] : null;
  if (!row || row.status !== 'aceito_cliente' || !row.vendedor_email) return { ok: true, enviado: false };
  const key = process.env.RESEND_API_KEY;
  if (!key) return { ok: true, enviado: false, motivo: 'RESEND_API_KEY nao configurada' };
  // evita repetir o e-mail se o cliente recarregar e clicar de novo
  if (new Date(row.aceito_em).getTime() < Date.now() - 10 * 60000) return { ok: true, enviado: false };
  const corpo = `<p>Olá${row.vendedor_nome ? ', <strong>' + esc(row.vendedor_nome) + '</strong>' : ''}!</p>
    <p><strong>${esc(row.cliente_nome)}</strong> aceitou o orçamento <strong>${esc(row.codigo)}</strong>${row.aceito_nome ? ' (aceite de ' + esc(row.aceito_nome) + ')' : ''}, no valor de <strong>${brl(row.total_final)}</strong>.</p>
    <p>Falta a sua confirmação: abra a tabela, entre em <b>Meus orçamentos</b> e clique em <b>Confirmar e enviar ao ZEN</b>. Se precisar ajustar algo antes, use o botão para abrir o pedido no ZEN.</p>
    <div style="text-align:center;margin:24px 0"><a href="${APP_TABELA}" style="display:inline-block;padding:12px 28px;background:#1d327b;color:#fff;text-decoration:none;border-radius:8px;font-family:Arial,sans-serif;font-size:14px;font-weight:600">Abrir meus orçamentos</a></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      from: 'Boxer Orçamentos <noreply@boxersoldas.com.br>', to: [row.vendedor_email],
      subject: 'Cliente aceitou o orçamento ' + row.codigo + ' — ' + row.cliente_nome,
      html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f0f4f8;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#fff;border:1px solid #d0d8e8;border-radius:12px;padding:28px">' + corpo + '</div></div></body></html>'
    })
  });
  return { ok: true, enviado: r.ok };
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
