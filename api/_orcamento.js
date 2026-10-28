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
//   aprovar   {id}                  -> confirma o aceite: a venda vira pedido (Venda padrao / WEB Pronta entrega)
//   cancelar  {id}                  -> cancela o orcamento (e a venda no ZEN, se ainda for orcamento)
//   arquivar  {id, arquivar}        -> tira da lista principal
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
      case 'editar': return res.status(200).json(await editar(ctx, user, body));
      case 'cancelar': return res.status(200).json(await cancelar(ctx, user, body.id));
      case 'arquivar': return res.status(200).json(await arquivar(ctx, user, body.id, body.arquivar !== false));
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
  return { id: caller.id, email: caller.email, nome: acesso.nome || caller.email, role: acesso.role, empresa: acesso.empresa || null };
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

function telOk(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length !== 10 && d.length !== 11) return false;
  const ddd = parseInt(d.slice(0, 2), 10);
  if (ddd < 11 || ddd > 99) return false;
  if (d.length === 11 && d[2] !== '9') return false;
  return true;
}
function docOk(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (/^(\d)\1+$/.test(d)) return false;
  const dv = (base, pesos) => { const r = base.split('').reduce((a, n, i) => a + Number(n) * pesos[i], 0) % 11; return r < 2 ? 0 : 11 - r; };
  if (d.length === 11) return dv(d.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[9]) && dv(d.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[10]);
  if (d.length === 14) return dv(d.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[12]) && dv(d.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[13]);
  return false;
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
  if (!c) {
    // fora do cadastro do ZEN: tenta os dados publicos da Receita (BrasilAPI) para preencher razao social e endereco
    let publico = null;
    if (cnpj.length === 14) {
      try {
        const r = await fetch('https://brasilapi.com.br/api/cnpj/v1/' + cnpj, { signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const j = await r.json();
          publico = {
            razao_social: j.razao_social || '', nome_fantasia: j.nome_fantasia || '', email: j.email || '',
            cidade: j.municipio || '', uf: j.uf || '', situacao: j.descricao_situacao_cadastral || '',
            endereco: [[j.descricao_tipo_de_logradouro, j.logradouro].filter(Boolean).join(' ') + (j.numero ? ', ' + j.numero : ''), j.bairro, j.cep ? 'CEP ' + j.cep : null].filter(x => x && String(x).trim()).join(' · ')
          };
        }
      } catch (_) { /* sem Receita agora: segue manual */ }
    }
    return { encontrado: false, cnpj, publico };
  }
  return {
    encontrado: true, cnpj,
    razao_social: c.razao_social, nome_fantasia: c.nome_fantasia || c.nome_exibicao || '',
    ie: c.inscricao_estadual || '', email: c.email_principal || '', telefone: c.telefone || '',
    cidade: c.cidade || '', uf: c.uf || '', bloqueado: !!c.bloqueado, no_zen: !!c.erp_cliente_id
  };
}

// ---------- editar: mesmo orcamento, mesmo link, venda do ZEN atualizada ----------
async function editar(ctx, user, b) {
  if (!b.id) throw erro(400, 'id obrigatorio');
  const o = (await sbGet(ctx, '/orcamentos?id=eq.' + encodeURIComponent(b.id) + '&user_id=eq.' + user.id + '&select=*', 'comercial'))[0];
  if (!o) throw erro(404, 'Orcamento nao encontrado');
  if (!['enviado', 'visualizado', 'aceito_cliente'].includes(o.status)) throw erro(409, 'Este orcamento esta ' + o.status + ' e nao pode mais ser editado');
  const celNovo = b.celular ? soDigitos(b.celular) : '';
  const emailNovo = b.email ? String(b.email).trim().toLowerCase() : '';
  const b2 = Object.assign({}, b, {
    tabela: 1,
    cliente: { cnpj: o.cliente_cnpj, nome: o.cliente_nome, fantasia: o.cliente_fantasia, ie: o.cliente_ie, email: emailNovo || o.cliente_email, celular: celNovo || o.cliente_celular, telefone: o.cliente_telefone, contato: o.cliente_contato, cidade: o.cliente_cidade, uf: o.cliente_uf, endereco: o.cliente_endereco },
    vendedor: { telefone: o.vendedor_telefone }, dry: false
  });
  return criar(ctx, user, b2, o);
}
async function aplicarEdicao(ctx, o, row, itens, avisos) {
  const agora = new Date().toISOString();
  const reaceite = o.status === 'aceito_cliente';
  const patch = {
    uf: row.uf, segmento: row.segmento, classe: row.classe, pagamento_tipo: row.pagamento_tipo, parcelas: row.parcelas,
    desconto_vista_pct: row.desconto_vista_pct, frete_tipo: row.frete_tipo, frete_valor: row.frete_valor, observacoes: row.observacoes,
    avisos, itens, total_itens: row.total_itens, total_final: row.total_final,
    cliente_celular: row.cliente_celular, cliente_email: row.cliente_email,
    validade_em: row.validade_em, status: reaceite ? 'visualizado' : o.status, aceito_em: null, aceito_nome: null, atualizado_em: agora
  };
  await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + o.id, patch);
  const out = { ok: true, editado: true, id: o.id, codigo: o.codigo, link: LINK_ORCAMENTO + o.token, validade_em: row.validade_em, avisos, total_final: row.total_final, reaceite };
  if (!o.zen_sale_id) { out.zen = { ok: false, erro: o.zen_status === 'sem_cliente_zen' ? 'Cliente ainda nao cadastrado no ZEN: nada a atualizar la.' : 'Este orcamento nao tem venda no ZEN.' }; return out; }
  try {
    await zenAtualizarVenda(o.zen_sale_id, Object.assign({}, row, { zen_person_id: o.zen_person_id || row.zen_person_id }), { codigo: o.codigo }, itens);
    await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + o.id, { zen_erro: null, zen_ajustado_em: agora });
    out.zen = { ok: true, sale_id: o.zen_sale_id };
  } catch (e) {
    await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + o.id, { zen_erro: ('Orcamento atualizado, mas a venda no ZEN nao: ' + e.message).slice(0, 400) });
    out.zen = { ok: false, erro: 'O orcamento foi atualizado, mas nao foi possivel atualizar a venda ' + o.zen_sale_id + ' no ZEN (' + e.message.slice(0, 140) + '). Ajuste la manualmente.' };
  }
  return out;
}

// ---------- criar ----------
async function criar(ctx, user, b, edit) {
  if (Number(b.tabela) !== 1) throw erro(400, 'Orcamento disponivel apenas na tabela de Revendas');
  if (!edit && b.req_id) {
    const ja = (await sbGet(ctx, '/orcamentos?user_id=eq.' + user.id + '&req_id=eq.' + encodeURIComponent(String(b.req_id).slice(0, 80)) + '&select=id,codigo,token,validade_em,avisos,total_final,zen_sale_id,zen_status,zen_erro&limit=1', 'comercial'))[0];
    if (ja) return { ok: true, duplicado: true, id: ja.id, codigo: ja.codigo, link: LINK_ORCAMENTO + ja.token, validade_em: ja.validade_em, avisos: ja.avisos || [], total_final: ja.total_final, zen: { ok: !!ja.zen_sale_id && ja.zen_status !== 'parcial', sale_id: ja.zen_sale_id, erro: ja.zen_erro } };
  }
  const off = b.offline && b.offline.criado_em && !isNaN(new Date(b.offline.criado_em)) ? b.offline : null;
  const offOk = !!off && (Date.now() - new Date(off.criado_em).getTime()) <= 7 * 86400000;
  const mudou = [];
  const uf = String(b.uf || '').toUpperCase();
  const seg = String(b.segmento || '');
  const cls = parseInt(b.classe);
  const itensIn = Array.isArray(b.itens) ? b.itens.filter(i => i && i.codigo && parseInt(i.qtd) > 0) : [];
  if (itensIn.length !== new Set(itensIn.map(i => String(i.codigo))).size) throw erro(400, 'Item repetido no orcamento');
  if (!itensIn.length) throw erro(400, 'Nenhum item no orcamento');
  if (itensIn.length > 60) throw erro(400, 'Itens demais para um orcamento');
  const cl = b.cliente || {};
  const cnpj = soDigitos(cl.cnpj);
  if (!cl.nome || !String(cl.nome).trim()) {
    // orcamento feito sem sinal: a razao social e buscada aqui (cadastro do ZEN ou Receita)
    try {
      const bc = await buscarCliente(ctx, cnpj);
      const nm = bc.encontrado ? bc.razao_social : (bc.publico && bc.publico.razao_social);
      if (nm) { cl.nome = nm; if (!cl.cidade) cl.cidade = bc.encontrado ? bc.cidade : (bc.publico && bc.publico.cidade) || ''; if (!cl.endereco && bc.publico) cl.endereco = bc.publico.endereco; }
    } catch (_) {}
    if (!cl.nome || !String(cl.nome).trim()) cl.nome = 'Cliente CNPJ/CPF ' + cnpj;
  }
  if (!docOk(cnpj)) throw erro(400, 'CNPJ/CPF do cliente invalido: confira os numeros');
  if (!cl.email || !/^\S+@\S+\.\S+$/.test(cl.email)) throw erro(400, 'Informe o e-mail do cliente');
  if (!telOk(cl.celular)) throw erro(400, 'Celular do cliente invalido: use DDD + numero, ex.: (19) 99999-9999');
  if (b.vendedor && b.vendedor.telefone && !telOk(b.vendedor.telefone)) throw erro(400, 'Seu telefone esta invalido: use DDD + numero, ex.: (19) 99999-9999');

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
    const baseAtual = r2(unitTabela * fator);
    const precoIn = Number(i.preco);
    const precoValido = precoIn > 0 && precoIn < 10000000;
    let unit = baseAtual;
    if (precoValido && i.manual !== false) unit = r2(precoIn);
    else if (precoValido && off) { if (Math.abs(precoIn - baseAtual) > 0.01) mudou.push(p.modelo || p.codigo); if (offOk) unit = r2(precoIn); }
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
  if (off) {
    avisos.push('Orcamento criado sem internet em ' + new Date(off.criado_em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ': o estoque informado e o da ultima consulta do aparelho. Confira antes de confirmar o pedido.');
    if (mudou.length) avisos.push(offOk
      ? 'A tabela de precos mudou desde a criacao offline (' + mudou.length + (mudou.length > 1 ? ' itens' : ' item') + '); mantidos os precos que o cliente viu: ' + mudou.slice(0, 5).join(', ')
      : 'Rascunho com mais de 7 dias: precos atualizados pela tabela de hoje (' + mudou.length + (mudou.length > 1 ? ' itens mudaram' : ' item mudou') + ')');
  }
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
  let endereco = cl.endereco || null;
  if (zenPerson && !endereco) {
    try {
      const ad = (await zenGet('/catalog/person/personAddress', { q: 'person.id==' + zenPerson, max: 1, limite: 1 }))[0];
      if (ad && ad.street) endereco = [ad.street + (ad.number ? ', ' + ad.number : ''), ad.district, ad.zipcode ? 'CEP ' + ad.zipcode : null].filter(Boolean).join(' · ');
    } catch (_) {}
  }

  const row = {
    tabela_id: 1, user_id: user.id, vendedor_nome: user.nome, vendedor_email: user.email, vendedor_empresa: user.empresa || null,
    vendedor_telefone: soDigitos(b.vendedor && b.vendedor.telefone) || null,
    uf, segmento: seg, classe: cls,
    cliente_nome: String(cl.nome).trim(), cliente_fantasia: cl.fantasia || null, cliente_cnpj: cnpj, cliente_ie: cl.ie || null,
    cliente_email: String(cl.email).trim().toLowerCase(), cliente_celular: soDigitos(cl.celular), cliente_telefone: soDigitos(cl.telefone) || null,
    cliente_contato: cl.contato || null, cliente_cidade: cl.cidade || null, cliente_uf: cl.uf || uf, cliente_endereco: endereco,
    zen_person_id: zenPerson, req_id: b.req_id ? String(b.req_id).slice(0, 80) : null,
    pagamento_tipo: avista ? 'avista' : 'boleto', parcelas, desconto_vista_pct: avista ? cond.vista : 0,
    frete_tipo: freteTipo, frete_valor: freteValor,
    observacoes: b.observacoes ? String(b.observacoes).slice(0, 1500) : null,
    avisos, itens, total_itens: totalItens, total_final: r2(totalItens + freteValor),
    validade_em: new Date(Date.now() + VALIDADE_DIAS * 86400000).toISOString()
  };

  if (edit) return aplicarEdicao(ctx, edit, row, itens, avisos);

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
    await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + orc.id, { zen_sale_id: sale.id, zen_status: sale.parcial ? 'parcial' : 'web_orcamento', zen_etapa: sale.parcial ? null : 'Orçamento · WEB orçamento', zen_erro: sale.parcial || null });
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
  const fmtTel = d => { d = String(d || ''); return d.length === 11 ? '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7) : d.length === 10 ? '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6) : d; };
  const comentarios = [
    'Orçamento ' + orc.codigo + ' · enviado ao cliente por link · validade ' + VALIDADE_DIAS + ' dias',
    'Representante: ' + o.vendedor_nome + (o.vendedor_empresa ? ' (' + o.vendedor_empresa + ')' : '') + (o.vendedor_telefone ? ' · ' + fmtTel(o.vendedor_telefone) : '') + (o.vendedor_email ? ' · ' + o.vendedor_email : ''),
    'Contato do cliente: ' + [o.cliente_contato, o.cliente_email, fmtTel(o.cliente_celular)].filter(Boolean).join(' · '),
    'Pagamento: ' + (o.pagamento_tipo === 'avista' ? 'à vista (' + o.desconto_vista_pct + '% de desconto)' : 'boleto em ' + o.parcelas + 'x'),
    'Frete: ' + (o.frete_tipo || 'a combinar') + (o.frete_valor ? ' (' + brl(o.frete_valor) + ')' : ''),
    o.observacoes ? 'Observações: ' + o.observacoes : null
  ].filter(Boolean).join('\n');
  const sale = {
    company: { id: ZEN_COMPANY_ID },
    person: { id: Number(o.zen_person_id) },
    saleProfile: { id: ZEN_PERFIL_ORCAMENTO },
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
  let etapa = true;
  if (!falhas.length) {
    try { await zenColocarEmWebOrcamento(sale.id); } catch (e) { etapa = false; falhas.push('etapa WEB orcamento: ' + e.message.slice(0, 120)); }
  }
  return { id: sale.id, etapa, parcial: falhas.length ? 'Venda ' + sale.id + ' criada com falhas: ' + falhas.join(' | ').slice(0, 350) : null };
}

// ---------- listar (reconcilia com o ZEN) ----------
// O que o ZEN diz manda: venda removida/cancelada la encerra o orcamento aqui; venda movida para o
// perfil "Venda padrao" (aprovada direto no ZEN) vira "aprovado"; itens/valores ajustados la voltam para ca.
const CAMPOS_LISTA = 'id,codigo,token,cliente_nome,cliente_cnpj,total_itens,total_final,frete_valor,status,validade_em,criado_em,visualizacoes,ultima_visualizacao_em,aceito_em,aceito_nome,aprovado_em,cancelado_em,cancelado_por,arquivado,zen_sale_id,zen_status,zen_etapa,zen_erro,cliente_celular,cliente_email,avisos,pagamento_tipo,parcelas,desconto_vista_pct,uf,segmento,classe,observacoes,itens';
async function listar(ctx, user) {
  const rows = await sbGet(ctx, '/orcamentos?user_id=eq.' + user.id + '&ativo=eq.true&order=criado_em.desc&limit=150&select=' + CAMPOS_LISTA, 'comercial');
  let aviso_sync = null;
  try { await zenRetomarSemCliente(ctx, rows); } catch (_) {}
  try { await sincronizarZen(ctx, rows); } catch (e) { aviso_sync = 'Nao foi possivel conferir o ZEN agora: ' + String(e.message).slice(0, 120); }
  const agora = Date.now();
  return {
    ok: true, aviso_sync,
    orcamentos: rows.map(r => {
      const o = Object.assign({}, r, {
        link: LINK_ORCAMENTO + r.token,
        expirado: new Date(r.validade_em).getTime() < agora && ['enviado', 'visualizado'].includes(r.status),
        itens_resumo: (r.itens || []).map(i => i.qtd + 'x ' + (i.modelo || i.codigo)),
        cliente_celular: r.cliente_celular, cliente_email: r.cliente_email,
        itens_edicao: (r.itens || []).map(i => {
          const f = r.pagamento_tipo === 'avista' ? 1 - Number(r.desconto_vista_pct || 0) / 100 : 1;
          const man = i.unit_tabela && Math.abs(Number(i.unit) - r2(Number(i.unit_tabela) * f)) > 0.01;
          return Object.assign({ codigo: String(i.codigo), qtd: i.qtd }, man ? { preco: Number(i.unit) } : {});
        })
      });
      delete o.itens;
      return o;
    })
  };
}

// orcamento feito com cliente ainda nao cadastrado no ZEN: quando o cadastro aparecer, a venda e criada sozinha
async function zenRetomarSemCliente(ctx, rows) {
  const alvo = rows.filter(r => r.zen_status === 'sem_cliente_zen' && !r.zen_sale_id && ['enviado', 'visualizado', 'aceito_cliente'].includes(r.status)).slice(0, 5);
  for (const r of alvo) {
    const hc = (await sbGet(ctx, '/hub_clientes?cnpj=eq.' + r.cliente_cnpj + '&select=erp_cliente_id&limit=1', 'comercial'))[0];
    if (!hc || !hc.erp_cliente_id) continue;
    try {
      const full = (await sbGet(ctx, '/orcamentos?id=eq.' + r.id + '&select=*', 'comercial'))[0];
      const row = Object.assign({}, full, { zen_person_id: Number(hc.erp_cliente_id) });
      const sale = await criarVendaZen(row, full, full.itens);
      const patch = { zen_person_id: row.zen_person_id, zen_sale_id: sale.id, zen_status: sale.parcial ? 'parcial' : 'web_orcamento', zen_etapa: sale.parcial ? null : 'Orçamento · WEB orçamento', zen_erro: sale.parcial || null };
      await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + r.id, patch);
      Object.assign(r, patch);
    } catch (e) { /* tenta de novo na proxima listagem */ }
  }
}
async function sincronizarZen(ctx, rows) {
  const alvo = rows.filter(r => r.zen_sale_id && !r.arquivado && ['enviado', 'visualizado', 'aceito_cliente', 'aprovado'].includes(r.status)).slice(0, 60);
  if (!alvo.length) return;
  const ids = alvo.map(r => r.zen_sale_id).join(',');
  const [vendas, wps, itensZen] = await Promise.all([
    zenGet('/sale/sale', { q: 'id=in=(' + ids + ')', max: 100, limite: 100 }),
    zenGet('/system/workflow/workpiece', { q: 'source=in=(' + alvo.map(r => '"/sale/sale:' + r.zen_sale_id + '"').join(',') + ');status==ACTIVE', max: 200, limite: 200 }),
    zenGet('/sale/saleItem', { q: 'sale.id=in=(' + ids + ')', max: 500, limite: 500 })
  ]);
  const vb = {}; vendas.forEach(v => { vb[v.id] = v; });
  const wb = {}; wps.forEach(w => { const m = /:(\d+)$/.exec(w.source || ''); if (m) wb[m[1]] = w; });
  const ib = {}; itensZen.forEach(i => { const id = i.sale && i.sale.id; (ib[id] = ib[id] || []).push(i); });

  for (const r of alvo) {
    const v = vb[r.zen_sale_id];
    const patch = {};
    if (!v) {
      Object.assign(patch, { status: 'cancelado', cancelado_por: 'zen', cancelado_em: new Date().toISOString(), zen_status: 'removido_zen', zen_etapa: 'Venda removida do ZEN', zen_erro: null });
    } else if (v.status === 'CANCELED') {
      Object.assign(patch, { status: 'cancelado', cancelado_por: 'zen', cancelado_em: new Date().toISOString(), zen_status: 'cancelado_zen', zen_etapa: 'Cancelada no ZEN', zen_erro: null });
    } else {
      const w = wb[r.zen_sale_id];
      const noPerfilVenda = v.saleProfile && v.saleProfile.id === ZEN_SALE_PROFILE_ID;
      const etapa = (w && w.workflow && w.workflow.description ? w.workflow.description : (v.saleProfile && v.saleProfile.description) || '') + (w && w.workflowNode ? ' · ' + w.workflowNode.description : (v.status === 'PREPARING' ? ' · Preparando' : ''));
      if (etapa && etapa !== r.zen_etapa) patch.zen_etapa = etapa;
      if (noPerfilVenda && ['PREPARED', 'APPROVED', 'FINISHED', 'PICKING'].includes(v.status)) {
        if (r.status !== 'aprovado') { patch.status = 'aprovado'; patch.aprovado_em = new Date().toISOString(); }
        const zs = w && w.workflowNode ? (w.workflowNode.code === 'webProntaEntrega' ? 'web_pronta_entrega' : 'no_fluxo') : 'no_fluxo';
        if (zs !== r.zen_status) patch.zen_status = zs;
        if (r.zen_erro) patch.zen_erro = null;
      } else if (!noPerfilVenda && r.zen_status !== 'web_orcamento' && !['erro', 'parcial', 'erro_avanco'].includes(r.zen_status)) {
        patch.zen_status = 'web_orcamento';
      }
      // itens/valores ajustados no ZEN
      const its = (ib[r.zen_sale_id] || []).filter(i => i.productPacking && i.productPacking.product);
      if (its.length) {
        const velho = {}; (r.itens || []).forEach(i => { velho[String(i.codigo)] = i; });
        const novos = its.map(i => {
          const cod = String(i.productPacking.product.code);
          const base = velho[cod] || { codigo: cod, modelo: i.productPacking.product.description || cod, categoria: '', unit_tabela: Number(i.unitValue), estoque: 'sem_info', previsao: null, ncm: '', ipi: 0, icms: 0, imagem_url: '' };
          const q = Number(i.quantity), u = Number(i.unitValue);
          return Object.assign({}, base, { qtd: q, unit: u, subtotal: r2(Number(i.totalValue) || q * u) });
        });
        const antes = JSON.stringify((r.itens || []).map(i => [String(i.codigo), i.qtd, i.unit]).sort());
        const depois = JSON.stringify(novos.map(i => [String(i.codigo), i.qtd, i.unit]).sort());
        if (antes !== depois) {
          const totalItens = r2(novos.reduce((a, x) => a + x.subtotal, 0));
          Object.assign(patch, { itens: novos, total_itens: totalItens, total_final: r2(totalItens + Number(r.frete_valor || 0)), zen_ajustado_em: new Date().toISOString() });
        }
      }
    }
    if (Object.keys(patch).length) {
      patch.atualizado_em = new Date().toISOString();
      await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + r.id, patch);
      Object.assign(r, patch);
    }
  }
}

// ---------- aprovar: orcamento (perfil Orcamento / WEB orcamento) -> pedido (Venda padrao / WEB Pronta entrega) ----------
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

  const sid = o.zen_sale_id;
  const passos = [];
  try {
    await zenAprovarVenda(sid, passos);
  } catch (e) {
    await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + o.id, { zen_status: 'erro_avanco', zen_erro: String(e.message).slice(0, 400) });
    throw erro(502, 'Nao foi possivel concluir no ZEN (' + (passos.join(' > ') || 'nenhuma etapa feita') + '): ' + e.message.slice(0, 200));
  }
  await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + o.id, { status: 'aprovado', aprovado_em: new Date().toISOString(), zen_status: 'web_pronta_entrega', zen_etapa: 'Venda padrão · WEB Pronta entrega', zen_erro: null, atualizado_em: new Date().toISOString() });
  return { ok: true, zen_sale_id: sid, passos };
}

// ---------- cancelar: so antes de virar pedido; cancela a venda no ZEN ----------
async function zenCancelarVenda(sid, motivo) {
  const sale = (await zenGet('/sale/sale', { q: 'id==' + sid, max: 1, limite: 1 }))[0];
  if (!sale) return { obs: 'a venda ' + sid + ' ja nao existe no ZEN', ok: true };
  if (sale.status === 'CANCELED') return { ok: true };
  if (!['PREPARING', 'PREPARED'].includes(sale.status) || (sale.saleProfile && sale.saleProfile.id === ZEN_SALE_PROFILE_ID && sale.status === 'PREPARED')) {
    return { ok: false, obs: 'a venda ' + sid + ' ja esta em andamento no ZEN (' + sale.status + ') e foi mantida' };
  }
  try {
    // o ZEN so cancela venda PREPARED/APPROVED: a venda do orcamento (PREPARING) e finalizada antes
    if (sale.status === 'PREPARING') await zenCall('POST', '/sale/saleOpPrepare/' + sid);
    await zenCall('POST', '/sale/saleOpCancel/' + sid, { reason: motivo, code: 'OTHER' }); return { ok: true };
  }
  catch (e) { return { ok: false, obs: 'nao foi possivel cancelar a venda no ZEN: ' + e.message.slice(0, 160) }; }
}
async function cancelar(ctx, user, id) {
  if (!id) throw erro(400, 'id obrigatorio');
  const o = (await sbGet(ctx, '/orcamentos?id=eq.' + encodeURIComponent(id) + '&user_id=eq.' + user.id + '&select=*', 'comercial'))[0];
  if (!o) throw erro(404, 'Orcamento nao encontrado');
  if (o.status === 'cancelado') return { ok: true, ja_cancelado: true };
  if (o.status === 'aprovado') throw erro(409, 'Este orcamento ja virou pedido no ZEN (' + o.zen_sale_id + '). Para cancelar, fale com o ADM de vendas.');
  let zenObs = null, zenOk = false;
  if (o.zen_sale_id) {
    try { const r = await zenCancelarVenda(o.zen_sale_id, 'Orçamento ' + o.codigo + ' cancelado pelo representante'); zenOk = r.ok; zenObs = r.obs || null; }
    catch (e) { zenObs = 'ZEN: ' + String(e.message).slice(0, 160); }
  }
  await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + o.id, {
    status: 'cancelado', cancelado_por: 'representante', cancelado_em: new Date().toISOString(),
    zen_status: o.zen_sale_id ? (zenOk ? 'cancelado_zen' : o.zen_status) : o.zen_status, zen_etapa: zenOk ? 'Cancelada no ZEN' : o.zen_etapa, zen_erro: zenObs, atualizado_em: new Date().toISOString()
  });
  return { ok: true, aviso_zen: zenObs && !zenOk ? zenObs : null };
}

// ---------- arquivar: tira da lista principal (nada e apagado) ----------
async function arquivar(ctx, user, id, flag) {
  if (!id) throw erro(400, 'id obrigatorio');
  const o = (await sbGet(ctx, '/orcamentos?id=eq.' + encodeURIComponent(id) + '&user_id=eq.' + user.id + '&select=id,status', 'comercial'))[0];
  if (!o) throw erro(404, 'Orcamento nao encontrado');
  if (flag && ['enviado', 'visualizado', 'aceito_cliente'].includes(o.status)) throw erro(409, 'Cancele o orcamento antes de arquivar');
  await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + o.id, { arquivado: !!flag, atualizado_em: new Date().toISOString() });
  return { ok: true };
}

// ---------- aviso ao representante (publico, so por token) ----------
async function avisarAceite(ctx, token) {
  if (!/^[0-9a-f-]{36}$/i.test(String(token || ''))) throw erro(400, 'token invalido');
  const o = (await sbGet(ctx, '/orcamentos?token=eq.' + token + '&select=id,codigo,vendedor_email,vendedor_nome,cliente_nome,total_final,status,aceito_em,aceito_nome,cancelado_por,cancelado_em,zen_sale_id,zen_status', 'comercial').catch(() => null));
  const row = Array.isArray(o) ? o[0] : null;
  if (row && row.status === 'cancelado' && row.cancelado_por === 'cliente') return avisarRecusa(ctx, row);
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
// cliente recusou pelo link: cancela a venda no ZEN (se ainda for orcamento) e avisa o representante
async function avisarRecusa(ctx, row) {
  if (!row.cancelado_em || new Date(row.cancelado_em).getTime() < Date.now() - 10 * 60000) return { ok: true, enviado: false };
  if (row.zen_sale_id && row.zen_status !== 'cancelado_zen') {
    try {
      const r = await zenCancelarVenda(row.zen_sale_id, 'Orçamento ' + row.codigo + ' recusado pelo cliente');
      await orcWrite(ctx, 'PATCH', '/orcamentos?id=eq.' + row.id, r.ok ? { zen_status: 'cancelado_zen', zen_etapa: 'Cancelada no ZEN', zen_erro: null } : { zen_erro: r.obs });
    } catch (_) {}
  }
  const key = process.env.RESEND_API_KEY;
  if (!key || !row.vendedor_email) return { ok: true, enviado: false };
  const corpo = `<p>Olá${row.vendedor_nome ? ', <strong>' + esc(row.vendedor_nome) + '</strong>' : ''}!</p>
    <p><strong>${esc(row.cliente_nome)}</strong> recusou o orçamento <strong>${esc(row.codigo)}</strong> (${brl(row.total_final)}) pelo link.</p>
    <p>O orçamento foi marcado como cancelado em <b>Meus orçamentos</b>${row.zen_sale_id ? ' e a venda ' + row.zen_sale_id + ' foi cancelada no ZEN' : ''}. Se foi engano, gere um novo orçamento.</p>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      from: 'Boxer Orçamentos <noreply@boxersoldas.com.br>', to: [row.vendedor_email],
      subject: 'Cliente recusou o orçamento ' + row.codigo + ' — ' + row.cliente_nome,
      html: '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#f0f4f8;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:24px"><div style="background:#fff;border:1px solid #d0d8e8;border-radius:12px;padding:28px">' + corpo + '</div></div></body></html>'
    })
  });
  return { ok: true, enviado: r.ok };
}

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// ---------- ZEN: perfis e etapas do orcamento ----------
// Orcamento = venda em PREPARING no perfil ORCAMENTO (fluxo "Orcamento", etapa "WEB orcamento").
// Aprovado  = venda PREPARED no perfil DEFAULT (fluxo "Venda padrao", etapa "WEB Pronta entrega").
const ZEN_PERFIL_ORCAMENTO = 1002;
const ZEN_WF_ORCAMENTO = 1002;

async function zenCall(method, path, body) {
  const headers = await zenAuth();
  const r = await fetch(ZEN_BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(method + ' ' + path + ': ' + t.slice(0, 250));
  try { return JSON.parse(t); } catch (_) { return t; }
}
async function zenWorkpieces(sid) {
  return zenGet('/system/workflow/workpiece', { q: 'source=="/sale/sale:' + sid + '"', max: 20, limite: 20 });
}
async function zenNodes(workflowId) {
  const nodes = await zenGet('/system/workflow/workflowNode', { q: 'workflow.id==' + workflowId, max: 100, limite: 100 });
  const m = {}; nodes.forEach(n => { m[n.code] = n.id; });
  return m;
}

// coloca a venda recem-criada (PREPARING) na etapa "WEB orcamento" sem vira-la em pedido:
// finalizar a preparacao cria o fluxo do perfil; desfazer devolve a venda a PREPARING mantendo a etapa.
async function zenColocarEmWebOrcamento(sid) {
  await zenCall('POST', '/sale/saleOpPrepare/' + sid);
  await zenCall('POST', '/sale/saleOpPrepareRevert/' + sid);
}

// orcamento aprovado -> pedido "WEB Pronta entrega" no fluxo Venda padrao
async function zenAprovarVenda(sid, passos) {
  let sale = (await zenGet('/sale/sale', { q: 'id==' + sid, max: 1, limite: 1 }))[0];
  if (!sale) throw new Error('venda ' + sid + ' nao existe mais no ZEN');
  if (sale.status === 'CANCELED') throw new Error('a venda ' + sid + ' esta cancelada no ZEN');
  if (!['PREPARING', 'PREPARED'].includes(sale.status)) throw new Error('a venda ' + sid + ' esta ' + sale.status + ' no ZEN');
  if (sale.saleProfile && sale.saleProfile.id !== ZEN_SALE_PROFILE_ID) {
    if (sale.status === 'PREPARED') { await zenCall('POST', '/sale/saleOpPrepareRevert/' + sid); passos.push('desfeita'); }
    // encerra a etapa do fluxo "Orcamento"
    const wps = (await zenWorkpieces(sid)).filter(w => w.workflow && w.workflow.id === ZEN_WF_ORCAMENTO && w.status === 'ACTIVE');
    if (wps.length) {
      const nodes = await zenNodes(ZEN_WF_ORCAMENTO);
      if (nodes.finalizado) { await zenCall('POST', '/system/workflow/workpieceOpForward/' + wps[0].id + '?workflowNodeId=' + nodes.finalizado); passos.push('orcamento_encerrado'); }
    }
    sale = (await zenGet('/sale/sale', { q: 'id==' + sid, max: 1, limite: 1 }))[0];
    sale.saleProfile = { id: ZEN_SALE_PROFILE_ID };
    await zenCall('PUT', '/sale/sale', sale);
    passos.push('perfil_venda_padrao');
    sale = (await zenGet('/sale/sale', { q: 'id==' + sid, max: 1, limite: 1 }))[0];
  }
  if (sale.status === 'PREPARING') { await zenCall('POST', '/sale/saleOpPrepare/' + sid); passos.push('preparada'); }
  const nodeId = await zenNodes(ZEN_WORKFLOW_ID);
  for (let tent = 0; tent < 5; tent++) {
    const wp = (await zenWorkpieces(sid)).filter(w => w.workflow && w.workflow.id === ZEN_WORKFLOW_ID && w.status === 'ACTIVE')[0];
    if (!wp) throw new Error('a venda ainda nao entrou no fluxo Venda padrao');
    const atual = wp.workflowNode && wp.workflowNode.code;
    if (atual === 'webProntaEntrega') return;
    const idx = CAMINHO_ZEN.indexOf(atual);
    if (idx < 0) throw new Error('a venda esta na etapa "' + (atual || '?') + '", fora do caminho do orcamento; avance manualmente no ZEN');
    const destino = CAMINHO_ZEN[idx + 1];
    if (!nodeId[destino]) throw new Error('etapa ' + destino + ' nao encontrada no fluxo do ZEN');
    await zenCall('POST', '/system/workflow/workpieceOpForward/' + wp.id + '?workflowNodeId=' + nodeId[destino]);
    passos.push(destino);
  }
}

// atualiza a venda do orcamento no ZEN: troca itens e pagamentos e refaz o comentario/frete.
// So enquanto ela ainda e orcamento (PREPARING): depois de virar pedido quem mexe e o time no ZEN.
async function zenAtualizarVenda(sid, o, orc, itens) {
  const sale = (await zenGet('/sale/sale', { q: 'id==' + sid, max: 1, limite: 1 }))[0];
  if (!sale) throw new Error('a venda ' + sid + ' nao existe mais no ZEN');
  if (sale.status !== 'PREPARING') throw new Error('a venda ' + sid + ' ja esta ' + sale.status + ' no ZEN');
  const m = await montarVendaZen(o, orc, itens);
  const atuais = await zenGet('/sale/saleItem', { q: 'sale.id==' + sid, max: 200, limite: 200 });
  for (const it of atuais) await zenCall('DELETE', '/sale/saleItem/' + it.id);
  const pags = await zenGet('/sale/salePayment', { q: 'sale.id==' + sid, max: 50, limite: 50 });
  for (const p of pags) await zenCall('DELETE', '/sale/salePayment/' + p.id);
  for (const it of m.itens) await zenCall('POST', '/sale/saleItem', { sale: { id: sid }, productPacking: it.productPacking, quantity: it.quantity, unitValue: it.unitValue });
  for (const p of m.pagamentos) await zenCall('POST', '/sale/salePayment', { sale: { id: sid }, type: p.type, term: p.term });
  const nova = (await zenGet('/sale/sale', { q: 'id==' + sid, max: 1, limite: 1 }))[0];
  nova.properties = Object.assign({}, nova.properties, { comments: m.sale.properties.comments });
  nova.freightType = m.sale.freightType;
  await zenCall('PUT', '/sale/sale', nova);
}
