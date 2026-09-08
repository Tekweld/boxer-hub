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
const { zenGet } = require('./_zen');

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

// ---------- TITULOS ----------
async function sincronizarTitulos({ idHub, hubH, dryRun, desde, t0 }) {
  const r = { lidos: 0, aplicaveis: 0, sem_cliente_hub: 0, gravados: 0, erros: [] };

  let cursor = desde ? Number(desde) : 0;
  const bufferGravar = [];

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
      bufferGravar.push(mapearTitulo(tit, clienteId, hoje));
    }

    if (lote.length < PASSO_ZEN) { r.concluido = true; break; }
  }

  r.proximo_desde = r.concluido ? null : cursor;

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
        chave_acesso: (nf.accessKey || nf.key || '').slice(0, 50) || null,
        data_emissao: (nf.issueDate || nf.date || '').slice(0, 10) || null,
        valor_total: Number(nf.totalValue) || 0,
        status: nf.status === 'CANCELED' ? 'cancelada' : 'ativa',
        ativo: true
      });
    }

    if (lote.length < PASSO_ZEN) { r.concluido = true; break; }
  }

  r.proximo_desde = r.concluido ? null : cursor;

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
