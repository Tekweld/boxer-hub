// Traz do ZEN, para pedidos importados (origem 'erp'), duas coisas que a
// importacao nao gravava:
//  1. a DATA REAL da venda (sale.date) -- hub_pedidos.criado_em ficava com a data
//     da importacao (17-25/11/2026) para vendas de meses atras;
//  2. o HISTORICO DE ETAPAS (workpieceNode: cada etapa com dateTimeStart) -- 5188 de
//     5889 pedidos nao tinham nenhum evento na linha do tempo.
//
// Idempotente e em lotes: pega pedidos com erp_historico_em IS NULL, grava eventos
// com ignore-duplicates (indice unico pedido_id+etapa) e marca o pedido como feito.
// Chamado de dentro de api/sync-pedidos-zen.js (prefixo `_`: nao e Serverless Function).
const { zenGet } = require('./_zen');

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const TAM_LOTE_ZEN = 40; // ids por consulta ao ZEN (mesmo limite do resto do codigo)

async function processarHistorico(hubH, { limite = 80, prazoMs = Infinity } = {}) {
  const saida = { pedidos: 0, eventos: 0, datas: 0, sem_workflow: 0, erros: [], restantes: null };
  const inicio = Date.now();

  const pedRes = await fetch(HUB_URL + '/rest/v1/hub_pedidos?origem=eq.erp&erp_historico_em=is.null&ativo=eq.true' +
    '&erp_pedido_id=not.is.null&select=id,erp_pedido_id&order=id.asc&limit=' + limite, { headers: hubH('GET') });
  if (!pedRes.ok) { saida.erros.push('listar pedidos: ' + pedRes.status); return saida; }
  const pedidos = await pedRes.json();
  const porSale = {};
  pedidos.forEach(p => { porSale[String(p.erp_pedido_id)] = p; });
  const saleIds = Object.keys(porSale);

  for (let i = 0; i < saleIds.length; i += TAM_LOTE_ZEN) {
    if (Date.now() - inicio > prazoMs) break;
    const lote = saleIds.slice(i, i + TAM_LOTE_ZEN);
    try {
      const vendas = await zenGet('/sale/sale', {
        q: '(' + lote.map(id => 'id==' + id).join(',') + ')', max: 100, limite: 100
      });
      const wps = await zenGet('/system/workflow/workpiece', {
        q: '(' + lote.map(id => 'source=="/sale/sale:' + id + '"').join(',') + ')', max: 100, limite: 200
      });
      const saleDoWp = {};
      wps.forEach(wp => { const m = /\/sale\/sale:(\d+)/.exec(wp.source || ''); if (m) saleDoWp[wp.id] = m[1]; });

      const nos = wps.length ? await zenGet('/system/workflow/workpieceNode', {
        q: '(' + wps.map(wp => 'workpiece.id==' + wp.id).join(',') + ')', max: 200, limite: 2000
      }) : [];

      const eventos = [];
      const comWorkflow = new Set();
      for (const no of nos) {
        const saleId = saleDoWp[no.workpiece?.id];
        const pedido = saleId && porSale[saleId];
        const etapa = no.workflowNode?.description;
        if (!pedido || !etapa || !no.dateTimeStart) continue;
        comWorkflow.add(saleId);
        eventos.push({ pedido_id: pedido.id, etapa, origem: 'zen', detalhe: null, criado_em: no.dateTimeStart });
      }

      if (eventos.length) {
        // ordem cronologica: se a mesma etapa se repete, vale a primeira ocorrencia
        eventos.sort((a, b) => String(a.criado_em).localeCompare(String(b.criado_em)));
        const er = await fetch(HUB_URL + '/rest/v1/hub_pedido_eventos?on_conflict=pedido_id,etapa', {
          method: 'POST',
          headers: { ...hubH('POST'), Prefer: 'resolution=ignore-duplicates,return=minimal' },
          body: JSON.stringify(eventos)
        });
        if (!er.ok) { saida.erros.push('eventos: ' + er.status + ' ' + (await er.text()).slice(0, 150)); continue; }
        saida.eventos += eventos.length;
      }

      // data real + marca de "historico feito" (um PATCH por pedido, em pequenos grupos)
      const agora = new Date().toISOString();
      const marcar = [];
      const vistas = new Set();
      for (const v of vendas) {
        const pedido = porSale[String(v.id)];
        if (!pedido) continue;
        vistas.add(String(v.id));
        if (!comWorkflow.has(String(v.id))) saida.sem_workflow++;
        marcar.push({ id: pedido.id, corpo: { ...(v.date ? { criado_em: v.date } : {}), erp_historico_em: agora } });
        if (v.date) saida.datas++;
      }
      // venda que nao existe mais no ZEN: marca como feita para nao travar a fila
      for (const id of lote) {
        if (!vistas.has(id)) marcar.push({ id: porSale[id].id, corpo: { erp_historico_em: agora } });
      }
      for (let k = 0; k < marcar.length; k += 10) {
        await Promise.all(marcar.slice(k, k + 10).map(async (m) => {
          const pr = await fetch(HUB_URL + '/rest/v1/hub_pedidos?id=eq.' + m.id, {
            method: 'PATCH', headers: hubH('PATCH'), body: JSON.stringify(m.corpo)
          });
          if (!pr.ok) saida.erros.push('patch ' + m.id + ': ' + pr.status);
          else saida.pedidos++;
        }));
      }
    } catch (e) {
      saida.erros.push('lote ' + (i / TAM_LOTE_ZEN) + ': ' + e.message.slice(0, 150));
    }
  }

  const contRes = await fetch(HUB_URL + '/rest/v1/hub_pedidos?origem=eq.erp&erp_historico_em=is.null&ativo=eq.true&select=id&limit=1',
    { headers: { ...hubH('GET'), Prefer: 'count=exact', Range: '0-0' } });
  const cr = contRes.headers.get('content-range');
  saida.restantes = cr ? Number(cr.split('/')[1]) : null;
  return saida;
}

module.exports = { processarHistorico };
