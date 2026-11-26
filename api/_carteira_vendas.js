// "Vendeu, aparece" (regra do Andre, 2026-11-26): se um vendedor ja vendeu para um cliente, esse cliente
// entra na carteira dele em hub_carteira (varios vendedores por cliente), EXCETO vendas do time SAC/pos-venda
// (hub_representantes.time_sac).
//
// Como: varre as vendas do ZEN por cursor de id (ascendente) -- consultar por vendedor estoura o tempo no ZEN
// (filtro por relacao e lento, medido em 2026-11-26) -- e registra os pares (vendedor, cliente) via
// hub_fn_carteira_registrar_vendas. Cursor em hub_sync_estado('carteira_vendas'): sobrevive a timeout e, depois
// de alcancar o fim, as proximas rodadas so veem vendas novas. Chamado por api/sync-pedidos-zen.js (prefixo `_`:
// nao e Serverless Function).
const { zenGet } = require('./_zen');

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const CORTE = '2025-03-01';   // mesmo corte do historico (nao ha dado do ZEN antes)
const PAGINA = 200;

// SAC/pos-venda: definido por hub_representantes.time_sac (preenchido no banco, nao no codigo: repo publico).
const ehSac = () => false;

async function processarCarteiraVendas(hubH, { prazoMs = 40000, cursorInicial = null } = {}) {
  const saida = { paginas: 0, vendas: 0, ignoradas_sac: 0, pares: 0, novos: 0, ja_existiam: 0, cursor: null, em_dia: false, erros: [] };
  const inicio = Date.now();

  const estRes = await fetch(HUB_URL + '/rest/v1/hub_sync_estado?chave=eq.carteira_vendas&select=valor', { headers: hubH('GET') });
  const est = estRes.ok ? (await estRes.json())[0]?.valor : null;
  let cursor = cursorInicial != null ? Number(cursorInicial) : Number(est?.cursor || 0);

  const repRes = await fetch(HUB_URL + '/rest/v1/hub_representantes?select=id,erp_representante_id,nome,time_sac&limit=2000', { headers: hubH('GET') });
  if (!repRes.ok) { saida.erros.push('listar representantes: ' + repRes.status); return saida; }
  const repPorErp = new Map();
  for (const r of await repRes.json()) if (r.erp_representante_id) repPorErp.set(String(r.erp_representante_id), r);

  while (Date.now() - inicio < prazoMs) {
    let vendas;
    try {
      vendas = await zenGet('/sale/sale', { q: 'id>' + cursor, order: 'id', max: PAGINA, limite: PAGINA });
    } catch (e) { saida.erros.push('zen: ' + e.message.slice(0, 120)); break; }
    if (!vendas.length) { saida.em_dia = true; break; }
    saida.paginas++;
    saida.vendas += vendas.length;

    // pares (vendedor do Hub, pessoa do ZEN) -> data mais recente
    const pares = new Map();
    for (const v of vendas) {
      cursor = Math.max(cursor, Number(v.id) || 0);
      if (v.status === 'CANCELED') continue;
      const data = String(v.date || '').slice(0, 10);
      if (!data || data < CORTE) continue;
      const vend = v.personSalesperson;
      const pessoa = v.person?.id;
      if (!vend?.id || !pessoa) continue;
      const rep = repPorErp.get(String(vend.id));
      if (!rep) continue;
      if (rep.time_sac) { saida.ignoradas_sac++; continue; }
      const k = rep.id + '|' + pessoa;
      if (!pares.has(k) || pares.get(k).data < data) pares.set(k, { rep: rep.id, pessoa: String(pessoa), data });
    }

    if (pares.size) {
      // pessoa do ZEN -> cliente do Hub (so quem ja foi importado)
      const pessoas = [...new Set([...pares.values()].map(p => p.pessoa))];
      const porErp = new Map();
      for (let i = 0; i < pessoas.length; i += 100) {
        const cr = await fetch(HUB_URL + '/rest/v1/hub_clientes?ativo=eq.true&erp_cliente_id=in.(' + pessoas.slice(i, i + 100).join(',') + ')&select=id,erp_cliente_id', { headers: hubH('GET') });
        if (cr.ok) for (const c of await cr.json()) porErp.set(String(c.erp_cliente_id), c.id);
        else saida.erros.push('clientes: ' + cr.status);
      }
      const lote = [...pares.values()].filter(p => porErp.has(p.pessoa))
        .map(p => ({ representante_id: p.rep, cliente_id: porErp.get(p.pessoa), ultima_venda_em: p.data }));
      if (lote.length) {
        const rr = await fetch(HUB_URL + '/rest/v1/rpc/hub_fn_carteira_registrar_vendas', {
          method: 'POST', headers: hubH('POST'), body: JSON.stringify({ p_pares: lote })
        });
        if (rr.ok) {
          const j = await rr.json();
          saida.pares += lote.length; saida.novos += j.novos || 0; saida.ja_existiam += j.ja_existiam || 0;
        } else { saida.erros.push('registrar: ' + rr.status + ' ' + (await rr.text()).slice(0, 120)); break; }
      }
    }

    // grava o cursor a cada pagina: se estourar o tempo, a proxima rodada continua daqui
    await fetch(HUB_URL + '/rest/v1/hub_sync_estado?on_conflict=chave', {
      method: 'POST', headers: { ...hubH('POST'), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ chave: 'carteira_vendas', valor: { cursor, atualizado: new Date().toISOString() } })
    });
    if (vendas.length < PAGINA) { saida.em_dia = true; break; }
  }
  saida.cursor = cursor;
  return saida;
}

module.exports = { processarCarteiraVendas, ehSac };
