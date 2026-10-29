// Sincroniza titulos e notas fiscais do Zen para o Hub.
//
// Sem isto, a aba Financeiro do cliente aparece vazia e o pedido nao passa por
// analise financeira de verdade (a tela ja le hub_titulos/hub_notas_fiscais,
// mas ate 2026-09-07 nada populava).
//
// Estrategia: varrer receivable/outgoingInvoice DIRETO (nao por cliente),
// filtrando pelo que interessa. Motivos:
//   - o mesmo cliente pode ter varios titulos por nota, entao ir por cliente
//     multiplica a chamada pouco util
//   - sync-enderecos ja pagou o preco de ir por cliente e mostrou o custo
//   - filtro por status no proprio recurso e barato e enxuga o volume
//
// Chave de upsert: erp_titulo_id / erp_nf_id (indice unico completo criado na
// migration `unique_erp_id_completo`).
//
// Titulos: sync so `flow==IN;status==APPROVED` -- e o que fica em aberto do
// lado do cliente. PREPARED e rascunho no ERP, CANCELED nao interessa, SETTLED
// nao entra por padrao (historico pesa e a tela mostra "abertos/vencidos") --
// se depois quisermos "historico do cliente", vira outra passada com
// SETTLED e limite de janela.
//
// Padrao de exposicao igual ao sync-enderecos: paginado, orcamento de tempo,
// devolve `proximo_offset` para encadear rodadas pela GitHub Actions.
const { zenGet, zenBuscarDfeNfeProcOut, zenBaixarArquivo, zenBuscarVendasPorInvoiceIds, zenBuscarDfeInfoPorInvoiceIds } = require('./_zen');

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const ORCAMENTO_MS = 45000;
const PASSO_ZEN = 200;

// Regra de negocio (Andre, 2026-09-08): nao sincronizar nada do Zen anterior a
// 01/03/2025. Para historia anterior, cliente abre chamado com o suporte.
// Vale para titulos e notas fiscais. A tela deve mostrar essa mensagem quando
// o cliente pedir "notas antigas".
const CORTE_HISTORICO = '2025-03-01';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const cronSecret = req.headers['x-cron-secret'];
  const authHeader = req.headers.authorization;
  const viaVercelCron = !!process.env.CRON_SECRET && authHeader === 'Bearer ' + process.env.CRON_SECRET;

  const hubH = (method) => ({
    'Content-Type': 'application/json',
    apikey: SB_SERVICE,
    Authorization: 'Bearer ' + SB_SERVICE,
    'Accept-Profile': 'comercial',
    'Content-Profile': 'comercial',
    Prefer: method === 'POST' ? 'return=representation' : 'return=minimal'
  });

  // Baixar o PDF (DANFE) ou o XML de uma NF. O documento NAO e gerado na hora
  // -- e o arquivo que o Zen ja guarda, pronto, desde a autorizacao da SEFAZ
  // (ver _zen.js: zenBuscarDfeNfeProcOut/zenBaixarArquivo). Tentar gerar via
  // /system/report/reportOpGenerate foi o caminho errado, investigado e
  // descartado em 2026-10-28 -- sempre devolvia um PDF generico identico,
  // porque esse endpoint e para relatorio, nao para reemitir o documento
  // fiscal. Autorizacao propria aqui porque e endpoint de uso normal do
  // cliente/representante, nao so de quem sincroniza (o gate logo abaixo e
  // so admin/manager).
  const baixarNfId = req.query?.baixar_nf;
  const baixarXmlId = req.query?.baixar_xml;
  if (baixarNfId || baixarXmlId) {
    const notaId = baixarNfId || baixarXmlId;
    const tipo = baixarNfId ? 'pdf' : 'xml';
    if (!authHeader) return res.status(401).json({ error: 'Autenticacao necessaria' });
    try {
      const userRes = await fetch(HUB_URL + '/auth/v1/user', {
        headers: { Authorization: authHeader, apikey: SB_SERVICE }
      });
      const caller = await userRes.json();
      if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

      const perfilRes = await fetch(
        HUB_URL + '/rest/v1/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=role,tipo,cliente_id,representante_id',
        { headers: hubH('GET') });
      const perfil = (await perfilRes.json())?.[0];
      if (!perfil) return res.status(403).json({ error: 'Perfil nao encontrado' });

      const nfRes = await fetch(
        HUB_URL + '/rest/v1/hub_notas_fiscais?id=eq.' + notaId + '&ativo=eq.true&select=id,cliente_id,erp_nf_id',
        { headers: hubH('GET') });
      const nf = (await nfRes.json())?.[0];
      if (!nf) return res.status(404).json({ error: 'Nota nao encontrada' });
      if (!nf.erp_nf_id) return res.status(422).json({ error: 'Nota sem vinculo com o Zen' });

      // Mesma regra de acesso da RLS de hub_notas_fiscais, replicada aqui
      // porque esta rota usa a service_role (bypassa RLS por definicao).
      let autorizado = ['admin', 'manager', 'analyst', 'financial'].includes(perfil.role);
      if (!autorizado && perfil.tipo === 'cliente') autorizado = perfil.cliente_id === nf.cliente_id;
      if (!autorizado && perfil.tipo === 'representante' && perfil.representante_id) {
        const cartRes = await fetch(
          HUB_URL + '/rest/v1/hub_carteira?representante_id=eq.' + perfil.representante_id + '&cliente_id=eq.' + nf.cliente_id + '&ativo=eq.true&select=id',
          { headers: hubH('GET') });
        autorizado = ((await cartRes.json()) || []).length > 0;
      }
      if (!autorizado) return res.status(403).json({ error: 'Sem acesso a esta nota' });

      const dfe = await zenBuscarDfeNfeProcOut(nf.erp_nf_id);
      if (!dfe) return res.status(404).json({ error: 'Documento fiscal nao encontrado no Zen' });

      const arquivo = tipo === 'pdf' ? dfe.fileDanfe : dfe.file;
      if (!arquivo?.id) {
        const motivo = dfe.status === 'ERROR'
          ? 'Emissao fiscal desta nota falhou no Zen (status ERROR) -- nao ha documento para baixar.'
          : 'Documento ainda nao disponivel (status ' + (dfe.status || 'desconhecido') + ').';
        return res.status(422).json({ error: motivo });
      }

      const buf = await zenBaixarArquivo(arquivo.id);
      res.setHeader('Content-Type', tipo === 'pdf' ? 'application/pdf' : 'application/xml');
      const ext = tipo === 'pdf' ? 'pdf' : 'xml';
      res.setHeader('Content-Disposition', 'inline; filename="NF-' + nf.erp_nf_id + '.' + ext + '"');
      return res.status(200).send(buf);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (cronSecret) {
    if (!process.env.CRON_SECRET || cronSecret !== process.env.CRON_SECRET) {
      return res.status(401).json({ error: 'CRON_SECRET invalido' });
    }
  } else if (viaVercelCron) {
    // autorizado pelo agendador
  } else if (authHeader) {
    const userRes = await fetch(HUB_URL + '/auth/v1/user', {
      headers: { Authorization: authHeader, apikey: SB_SERVICE }
    });
    const caller = await userRes.json();
    if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });
    const perfilRes = await fetch(
      HUB_URL + '/rest/v1/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=role',
      { headers: hubH('GET') });
    const perfis = await perfilRes.json();
    if (!perfis?.[0] || !['admin', 'manager'].includes(perfis[0].role)) {
      return res.status(403).json({ error: 'Apenas admin ou manager pode sincronizar' });
    }
  } else {
    return res.status(401).json({ error: 'Autenticacao necessaria' });
  }

  // Backfill de pedido_id/chave_acesso para linhas gravadas ANTES desta
  // correcao (2026-10-29: chave_acesso vinha de campo inexistente em
  // outgoingInvoice, e pedido_id nunca foi resolvido). Paginado com
  // orcamento de tempo -- chamar de novo com os offsets devolvidos ate
  // `concluido: true`. Titulo precisa reconsultar o Zen pelo erp_titulo_id
  // porque o Hub nao guarda invoice.id, so a NF guarda.
  if (req.query?.backfill_pedido) {
    const t0b = Date.now();
    const ORCAMENTO_BACKFILL_MS = 18000; // maxDuration da function e 60s (vercel.json) -- reserva boa margem
    const PASSO = 50;
    const offsetNf = Number(req.query.offset_nf) || 0;
    const offsetTit = Number(req.query.offset_titulo) || 0;
    const resultado = { nf: { processadas: 0, atualizadas: 0 }, titulo: { processadas: 0, atualizadas: 0 } };
    try {
      const rNf = await fetch(HUB_URL +
        '/rest/v1/hub_notas_fiscais?pedido_id=is.null&erp_nf_id=not.is.null&ativo=eq.true' +
        '&select=id,erp_nf_id&order=erp_nf_id.asc&offset=' + offsetNf + '&limit=' + PASSO,
        { headers: hubH('GET') });
      const lotesNf = rNf.ok ? await rNf.json() : [];
      if (lotesNf.length) {
        resultado.nf.processadas = lotesNf.length;
        const invoiceIds = lotesNf.map((n) => n.erp_nf_id);
        const [mapaDfe, mapaPedido] = await Promise.all([
          zenBuscarDfeInfoPorInvoiceIds(invoiceIds),
          resolverPedidoIdsPorInvoice(invoiceIds, hubH)
        ]);
        const patchesNf = await Promise.all(lotesNf.map(async (n) => {
          const patch = {};
          const chave = mapaDfe[n.erp_nf_id]?.chNFe;
          if (chave) patch.chave_acesso = chave.slice(0, 50);
          if (mapaPedido[n.erp_nf_id]) patch.pedido_id = mapaPedido[n.erp_nf_id];
          if (!Object.keys(patch).length) return false;
          const pr = await fetch(HUB_URL + '/rest/v1/hub_notas_fiscais?id=eq.' + n.id, {
            method: 'PATCH', headers: hubH('PATCH'), body: JSON.stringify(patch)
          });
          return pr.ok;
        }));
        resultado.nf.atualizadas = patchesNf.filter(Boolean).length;
      }
      resultado.nf.proximo_offset = lotesNf.length < PASSO ? null : offsetNf + PASSO;

      if (Date.now() - t0b < ORCAMENTO_BACKFILL_MS) {
        const rTit = await fetch(HUB_URL +
          '/rest/v1/hub_titulos?pedido_id=is.null&erp_titulo_id=not.is.null&ativo=eq.true' +
          '&select=id,erp_titulo_id&order=erp_titulo_id.asc&offset=' + offsetTit + '&limit=' + PASSO,
          { headers: hubH('GET') });
        const lotesTit = rTit.ok ? await rTit.json() : [];
        if (lotesTit.length) {
          resultado.titulo.processadas = lotesTit.length;
          const receivables = await zenGet('/financial/receivable', {
            q: '(' + lotesTit.map((t) => 'id==' + t.erp_titulo_id).join(',') + ')',
            max: lotesTit.length, limite: lotesTit.length
          });
          const invoicePorTitulo = {};
          for (const rec of receivables) if (rec.invoice?.id) invoicePorTitulo[String(rec.id)] = String(rec.invoice.id);
          const mapaPedido = await resolverPedidoIdsPorInvoice(Object.values(invoicePorTitulo), hubH);
          const patchesTit = await Promise.all(lotesTit.map(async (t) => {
            const invId = invoicePorTitulo[t.erp_titulo_id];
            if (!invId || !mapaPedido[invId]) return false;
            const pr = await fetch(HUB_URL + '/rest/v1/hub_titulos?id=eq.' + t.id, {
              method: 'PATCH', headers: hubH('PATCH'), body: JSON.stringify({ pedido_id: mapaPedido[invId] })
            });
            return pr.ok;
          }));
          resultado.titulo.atualizadas = patchesTit.filter(Boolean).length;
        }
        resultado.titulo.proximo_offset = lotesTit.length < PASSO ? null : offsetTit + PASSO;
      } else {
        resultado.titulo.proximo_offset = offsetTit;
      }

      resultado.concluido = resultado.nf.proximo_offset === null && resultado.titulo.proximo_offset === null;
      return res.status(200).json({ ok: true, ...resultado });
    } catch (e) {
      return res.status(500).json({ ok: false, erro: e.message, ...resultado });
    }
  }

  const t0 = Date.now();
  const alvo = String(req.query?.alvo || 'ambos'); // 'titulos' | 'notas' | 'ambos'
  const dryRun = req.query?.dry === '1';
  const desde = req.query?.desde || null; // id inicial (para retomar / limitar volume)

  const r = { dry_run: dryRun, alvo };

  try {
    // Mapa erp_cliente_id (Person.id) -> hub_cliente_id (uuid). Uma vez so, no
    // inicio -- sem isto nao da para gravar cliente_id nas linhas.
    const idHub = await carregarMapaClientes(hubH);
    r.clientes_mapeados = Object.keys(idHub).length;

    if (alvo === 'titulos' || alvo === 'ambos') {
      r.titulos = await sincronizarTitulos({ idHub, hubH, dryRun, desde, t0 });
    }
    if (alvo === 'notas' || alvo === 'ambos') {
      r.notas = await sincronizarNotas({ idHub, hubH, dryRun, desde, t0 });
    }

    r.duracao_ms = Date.now() - t0;
    console.log('[FINANCEIRO]', JSON.stringify(r));
    return res.status(200).json({ ok: true, ...r });
  } catch (e) {
    console.error('[FINANCEIRO] erro:', e.message);
    return res.status(500).json({ ok: false, erro: e.message, ...r });
  }
};

async function carregarMapaClientes(hubH) {
  const idHub = {};
  let offset = 0;
  while (true) {
    const r = await fetch(HUB_URL +
      '/rest/v1/hub_clientes?erp_cliente_id=not.is.null&ativo=eq.true' +
      '&select=id,erp_cliente_id&order=erp_cliente_id.asc' +
      '&offset=' + offset + '&limit=1000', { headers: hubH('GET') });
    if (!r.ok) break;
    const lote = await r.json();
    if (!lote.length) break;
    lote.forEach(c => {
      if (/^\d+$/.test(String(c.erp_cliente_id))) idHub[String(c.erp_cliente_id)] = c.id;
    });
    if (lote.length < 1000) break;
    offset += lote.length;
  }
  return idHub;
}

// Resolve invoice.id (Zen) -> hub_pedidos.id (uuid Hub), em lote. Usado por
// titulo e NF -- os dois so guardam invoice.id, e sale.Sale tem o campo
// `invoice` direto (achado/confirmado em 2026-10-29: venda 51705 <->
// invoice 74838). Venda sem origem no Hub (sem erp_pedido_id gravado)
// simplesmente nao aparece no mapa -- pedido_id fica null, esperado.
async function resolverPedidoIdsPorInvoice(invoiceIds, hubH) {
  const mapaSale = await zenBuscarVendasPorInvoiceIds(invoiceIds);
  const saleIds = [...new Set(Object.values(mapaSale))];
  if (!saleIds.length) return {};

  const mapaPedido = {};
  for (let i = 0; i < saleIds.length; i += 200) {
    const fatia = saleIds.slice(i, i + 200);
    const q = fatia.map((id) => 'erp_pedido_id.eq.' + id).join(',');
    const resp = await fetch(
      HUB_URL + '/rest/v1/hub_pedidos?or=(' + q + ')&select=id,erp_pedido_id',
      { headers: hubH('GET') });
    if (!resp.ok) continue;
    for (const p of (await resp.json())) mapaPedido[p.erp_pedido_id] = p.id;
  }

  const resultado = {};
  for (const [invoiceId, saleId] of Object.entries(mapaSale)) {
    if (mapaPedido[saleId]) resultado[invoiceId] = mapaPedido[saleId];
  }
  return resultado;
}

// ---------- TITULOS ----------
async function sincronizarTitulos({ idHub, hubH, dryRun, desde, t0 }) {
  const r = { lidos: 0, aplicaveis: 0, sem_cliente_hub: 0, gravados: 0, erros: [] };

  let cursor = desde ? Number(desde) : 0;
  const pendentes = []; // { row, invoiceId } -- pedido_id resolvido em lote no final

  while (Date.now() - t0 < ORCAMENTO_MS) {
    // Zen tem bug conhecido de paginacao com filtro complexo -- a defesa usada
    // por _zen.js (anti-ciclo por id) so vale quando pagino a mesma query.
    // Aqui uso a estrategia de "id ascendente": pega tudo com id > cursor,
    // ordenado por id, e o cursor da proxima rodada e o maior id do lote.
    let lote;
    try {
      lote = await zenGet('/financial/receivable', {
        q: 'id>' + cursor + ';flow==IN;status==APPROVED',
        order: 'id',
        max: PASSO_ZEN,
        limite: PASSO_ZEN
      });
    } catch (e) {
      r.erros.push({ etapa: 'ler', cursor, detalhe: e.message.slice(0, 200) });
      break;
    }
    if (!lote.length) { r.concluido = true; break; }

    r.lidos += lote.length;
    cursor = Math.max(...lote.map(x => x.id));

    const hoje = new Date().toISOString().slice(0, 10);
    for (const tit of lote) {
      const clienteId = idHub[String(tit.person?.id)];
      if (!clienteId) { r.sem_cliente_hub++; continue; }
      r.aplicaveis++;
      pendentes.push({ row: mapearTitulo(tit, clienteId, hoje), invoiceId: tit.invoice?.id ? String(tit.invoice.id) : null });
    }

    if (lote.length < PASSO_ZEN) { r.concluido = true; break; }
  }

  r.proximo_desde = r.concluido ? null : cursor;

  // Resolve pedido_id em lote (titulo so guarda invoice.id -- ver
  // resolverPedidoIdsPorInvoice) antes de gravar. Nem todo titulo tem
  // invoice (ex: antecipacao) -- fica null, esperado.
  try {
    const mapaPedido = await resolverPedidoIdsPorInvoice(pendentes.map((p) => p.invoiceId), hubH);
    for (const p of pendentes) {
      if (p.invoiceId && mapaPedido[p.invoiceId]) p.row.pedido_id = mapaPedido[p.invoiceId];
    }
  } catch (e) {
    r.erros.push({ etapa: 'resolver_pedido', detalhe: e.message.slice(0, 200) });
  }
  const bufferGravar = pendentes.map((p) => p.row);

  if (!dryRun && bufferGravar.length) {
    for (let i = 0; i < bufferGravar.length; i += 200) {
      const fatia = bufferGravar.slice(i, i + 200);
      const g = await fetch(HUB_URL + '/rest/v1/hub_titulos?on_conflict=erp_titulo_id', {
        method: 'POST',
        headers: { ...hubH('POST'), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(fatia)
      });
      if (!g.ok) {
        r.erros.push({ etapa: 'gravar_titulo', offset: i, status: g.status, detalhe: (await g.text()).slice(0, 200) });
        continue;
      }
      r.gravados += fatia.length;
    }
  } else {
    r.a_gravar = bufferGravar.length;
  }

  return r;
}

// Ainda so `boleto` como default -- a distincao boleto/duplicata/cheque nao
// esta no receivable, esta na `salePayment` associada. Se virar necessario
// mostrar isso pro cliente, olhar o `sale.salePayment` do pedido origem.
function mapearTitulo(tit, clienteId, hoje) {
  const valor = Number(tit.value) || 0;
  const balance = Number(tit.balance) || 0;
  const settlement = Number(tit.valueSettlement) || 0;
  const venc = (tit.dueDate || '').slice(0, 10);
  const emissao = (tit.issueDate || tit.date || '').slice(0, 10);

  let status;
  if (balance <= 0.005) status = 'pago';
  else if (venc && venc < hoje) status = 'vencido';
  else if (settlement > 0.005 && balance > 0.005) status = 'parcial';
  else status = 'aberto';

  const diasAtraso = status === 'vencido'
    ? Math.max(0, Math.floor((new Date(hoje) - new Date(venc)) / 86400000))
    : 0;

  // numero_titulo pega `code`, com sufixo de parcela quando o code repete
  // entre parcelas -- o receivable e por parcela.
  const numero = tit.code
    ? String(tit.code) + (tit.installment > 1 ? '/' + tit.installment : '')
    : String(tit.id);

  return {
    cliente_id: clienteId,
    erp_titulo_id: String(tit.id),
    numero_titulo: numero.slice(0, 30),
    tipo: 'boleto',
    valor_original: valor,
    valor_aberto: balance,
    data_emissao: emissao || hoje,
    data_vencimento: venc || hoje,
    data_pagamento: status === 'pago' ? (tit.date || '').slice(0, 10) || null : null,
    status,
    dias_atraso: diasAtraso,
    ativo: true
  };
}

// ---------- NOTAS FISCAIS ----------
// fiscal.OutgoingInvoice = nota de saida (venda). E o que o cliente ve no
// financeiro para baixar XML/PDF.
//
// Volume real (medido 2026-09-08): ids passam de 70.000. Testei filtro por
// `issueDate>=` e o Zen aceita mas IGNORA -- o cursor avanca normal com 400
// lidos por rodada. Entao a estrategia e: cursor persistente vindo do proprio
// hub_notas_fiscais (max erp_nf_id ja gravado), sem filtro de data. O cron
// diario cobre so os novos; a carga historica e responsabilidade de rodar
// manualmente ate concluir (varias execucoes) se alguem quiser tudo.
//
// Regra pratica para o piloto: nao carregar historico. Cursor comeca em algum
// id relativamente recente (via `desde` manual) na primeira vez, e o cron
// mantem em dia dali para a frente. Cliente ve o que foi emitido a partir
// dessa data; NF antiga pede pro contador, como sempre foi.
async function sincronizarNotas({ idHub, hubH, dryRun, desde, t0 }) {
  const r = { lidos: 0, sem_cliente_hub: 0, gravados: 0, erros: [] };

  // Cursor: prioridade eh o parametro explicito; sem ele, retoma do maior
  // erp_nf_id ja sincronizado -- self-hosting, sem tabela de estado nova.
  let cursor = desde ? Number(desde) : 0;
  if (!cursor) {
    const rMax = await fetch(HUB_URL +
      '/rest/v1/hub_notas_fiscais?select=erp_nf_id&order=erp_nf_id.desc.nullslast&limit=1',
      { headers: hubH('GET') });
    if (rMax.ok) {
      const lin = await rMax.json();
      const ult = Number(lin?.[0]?.erp_nf_id);
      if (Number.isFinite(ult) && ult > 0) cursor = ult;
    }
  }
  r.cursor_inicial = cursor;
  const buffer = [];

  while (Date.now() - t0 < ORCAMENTO_MS - 5000) { // 5s reserva para o gravar
    let lote;
    try {
      lote = await zenGet('/fiscal/outgoingInvoice', {
        q: 'id>' + cursor + ';flow==OUT',
        order: 'id',
        max: PASSO_ZEN,
        limite: PASSO_ZEN
      });
    } catch (e) {
      r.erros.push({ etapa: 'ler', cursor, detalhe: e.message.slice(0, 200) });
      break;
    }
    if (!lote.length) { r.concluido = true; break; }

    r.lidos += lote.length;
    cursor = Math.max(...lote.map(x => x.id));

    for (const nf of lote) {
      const clienteId = idHub[String(nf.person?.id)];
      if (!clienteId) { r.sem_cliente_hub++; continue; }
      buffer.push({
        cliente_id: clienteId,
        erp_nf_id: String(nf.id),
        numero_nf: String(nf.number || nf.code || nf.id).slice(0, 20),
        serie: (nf.series || '').toString().slice(0, 5) || null,
        data_emissao: (nf.issueDate || nf.date || '').slice(0, 10) || null,
        valor_total: Number(nf.totalValue) || 0,
        status: nf.status === 'CANCELED' ? 'cancelada' : 'ativa',
        ativo: true
      });
    }

    if (lote.length < PASSO_ZEN) { r.concluido = true; break; }
  }

  r.proximo_desde = r.concluido ? null : cursor;

  // chave_acesso e pedido_id em lote. outgoingInvoice NAO tem accessKey/key
  // (codigo antigo assumia isso -- sempre vinha null); a chave de verdade
  // mora no documento fiscal (fiscal.br.DfeNfeProcOut.chNFe), mesma fonte do
  // download real de PDF/XML. pedido_id vem de sale.invoice (ver
  // resolverPedidoIdsPorInvoice) -- NF de venda fora do Hub fica sem pedido,
  // esperado.
  try {
    const invoiceIds = buffer.map((b) => b.erp_nf_id);
    const [mapaDfe, mapaPedido] = await Promise.all([
      zenBuscarDfeInfoPorInvoiceIds(invoiceIds),
      resolverPedidoIdsPorInvoice(invoiceIds, hubH)
    ]);
    for (const b of buffer) {
      b.chave_acesso = (mapaDfe[b.erp_nf_id]?.chNFe || '').slice(0, 50) || null;
      if (mapaPedido[b.erp_nf_id]) b.pedido_id = mapaPedido[b.erp_nf_id];
    }
  } catch (e) {
    r.erros.push({ etapa: 'resolver_chave_pedido', detalhe: e.message.slice(0, 200) });
  }

  if (!dryRun && buffer.length) {
    for (let i = 0; i < buffer.length; i += 200) {
      const fatia = buffer.slice(i, i + 200);
      const g = await fetch(HUB_URL + '/rest/v1/hub_notas_fiscais?on_conflict=erp_nf_id', {
        method: 'POST',
        headers: { ...hubH('POST'), Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(fatia)
      });
      if (!g.ok) {
        r.erros.push({ etapa: 'gravar_nf', offset: i, status: g.status, detalhe: (await g.text()).slice(0, 200) });
        continue;
      }
      r.gravados += fatia.length;
    }
  } else {
    r.a_gravar = buffer.length;
  }

  return r;
}
