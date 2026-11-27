// Perfil fiscal da operacao de cada venda do ZEN (sale.Sale.fiscalProfileOperation): "Saida de brinde" = bonificacao,
// "Devolucao..." = devolucao, "Venda..." = venda. Tambem fixa a data real do ZEN (sale.date) nos pedidos importados
// (origem 'erp') -- hub_pedidos.criado_em ficava com a data em que o Hub importou (19/11). Varre as vendas por cursor de
// id (o filtro por relacao estoura timeout no ZEN) e grava via hub_fn_pedidos_perfil_fiscal. Estado em
// hub_sync_estado('perfil_fiscal'). Chamado por api/sync-pedidos-zen.js (prefixo `_`: nao e Serverless Function).
const { zenGet } = require('./_zen');
const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const PAGINA = 200;
// O menor id de venda que existe no Hub e 14563 (medido em 2026-11-27): varrer de 0 so cai em faixa lenta do ZEN sem ganho.
const CURSOR_INICIAL = 14500;

const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
// Classificacao pelo texto do perfil. O que nao for claramente venda/bonificacao/devolucao vira 'outra' (e o texto
// original fica em erp_perfil_fiscal para revisao).
function classificar(desc) {
  const d = norm(desc);
  if (!d) return 'venda';
  if (/brinde|bonifica/.test(d)) return 'bonificacao';
  if (/devolu/.test(d)) return 'devolucao';
  if (/(^|\W)venda/.test(d)) return 'venda';
  return 'outra';
}

async function processarPerfilFiscal(hubH, { prazoMs = 30000 } = {}) {
  const saida = { paginas: 0, vendas: 0, atualizados: 0, datas_corrigidas: 0, cursor: null, em_dia: false, perfis: {}, erros: [] };
  const inicio = Date.now();
  const estRes = await fetch(HUB_URL + '/rest/v1/hub_sync_estado?chave=eq.perfil_fiscal&select=valor', { headers: hubH('GET') });
  const est = estRes.ok ? (await estRes.json())[0]?.valor : null;
  let cursor = Number(est?.cursor || CURSOR_INICIAL);

  // id -> descricao dos perfis (a venda pode trazer so a referencia, sem o texto)
  const descPorId = new Map();
  try { for (const f of await zenGet('/fiscal/fiscalProfileOperation', { max: 200, limite: 200 })) descPorId.set(String(f.id), f.description || f.code || null); }
  catch (e) { saida.erros.push('perfis: ' + e.message.slice(0, 100)); }

  let pag = 100; // tamanho da pagina: encolhe em faixa lenta e FICA encolhido ate o fim da rodada
  while (Date.now() - inicio < prazoMs) {
    let vendas;
    try { vendas = await zenGet('/sale/sale', { q: 'id>' + cursor, order: 'id', max: pag, limite: pag }); }
    catch (e) {
      // faixa lenta: tenta de novo com pagina menor antes de desistir da rodada
      pag = 40; // mantem 40 nas proximas paginas desta rodada
      try { vendas = await zenGet('/sale/sale', { q: 'id>' + cursor, order: 'id', max: pag, limite: pag }); }
      catch (e2) { saida.erros.push('zen: ' + e2.message.slice(0, 120)); break; }
    }
    if (!vendas.length) { saida.em_dia = true; break; }
    saida.paginas++; saida.vendas += vendas.length;
    const lote = [];
    for (const v of vendas) {
      cursor = Math.max(cursor, Number(v.id) || 0);
      const fp = v.fiscalProfileOperation;
      const desc = fp?.description || (fp?.id != null ? descPorId.get(String(fp.id)) : null) || null;
      const chave = desc || '(sem perfil)';
      saida.perfis[chave] = (saida.perfis[chave] || 0) + 1;
      lote.push({ erp_pedido_id: String(v.id), perfil_id: fp?.id ?? null, perfil: desc, tipo: classificar(desc), data: v.date || null });
    }
    const rr = await fetch(HUB_URL + '/rest/v1/rpc/hub_fn_pedidos_perfil_fiscal', { method: 'POST', headers: hubH('POST'), body: JSON.stringify({ p_dados: lote }) });
    if (!rr.ok) { saida.erros.push('gravar: ' + rr.status + ' ' + (await rr.text()).slice(0, 120)); break; }
    const j = await rr.json();
    saida.atualizados += j.atualizados || 0; saida.datas_corrigidas += j.datas_corrigidas || 0;
    await fetch(HUB_URL + '/rest/v1/hub_sync_estado?on_conflict=chave', {
      method: 'POST', headers: { ...hubH('POST'), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ chave: 'perfil_fiscal', valor: { cursor, atualizado: new Date().toISOString() } })
    });
    if (vendas.length < pag) { saida.em_dia = true; break; }
  }
  saida.cursor = cursor;
  return saida;
}
module.exports = { processarPerfilFiscal, classificar };
