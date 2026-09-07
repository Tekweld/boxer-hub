// Mantem o pedido do Hub e a venda do Zen conversando, nos dois sentidos.
//
// 1. EMPURRA o que ficou para tras: pedido submetido sem erp_pedido_id. O push
//    no checkout e best-effort de proposito -- se o Zen estiver fora do ar, o
//    cliente nao pode ficar preso numa tela de erro depois de ja ter passado
//    pelo portao. Quem garante que o pedido chega e este job, nao o navegador.
//
// 2. TRAZ a etapa de volta. O status util NAO e `sale.status` (fica PREPARED o
//    tempo todo, ate o fim) e sim o no ativo do workflow -- 'Analise de
//    Credito', 'Aguardando importacao', 'Pedido aprovado'. Sem isso o cliente
//    ve "submetido" para sempre e liga para perguntar, que e exatamente o
//    telefonema que o Hub existe para eliminar.
//
// Armadilha que ja custou tempo (ver bav-boxer/backend/app/zen_pedidos.py):
// `workpiece.id` NAO e o id da venda. O caminho e sale.workpiece.id, e a volta
// vem em workpiece.source, formatado '/sale/sale:<saleId>'.
const { zenGet, zenAuth, ZEN_BASE } = require('./_zen');

const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

// Etapas do Zen que encerram o acompanhamento: depois delas o no nao muda mais
// sozinho, entao nao vale gastar consulta por elas em toda rodada.
const ETAPAS_FINAIS = ['Pedido aprovado', 'Pedido reprovado'];

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

  // Diagnostico: devolve o payload cru do Zen para uma venda, em vez de
  // sincronizar. Existe dentro deste endpoint (e nao num /api/debug proprio)
  // porque o plano Hobby limita a 12 Serverless Functions e nao ha vaga.
  // Amostra crua de workpiece/workpieceNode: serve para descobrir o formato do
  // `source` (o vinculo de volta para a venda) sem chutar.
  if (req.query?.debug_wp) {
    try {
      const wps = await zenGet('/system/workflow/workpiece', { max: 5, limite: 5 });
      const nos = await zenGet('/system/workflow/workpieceNode', { max: 5, limite: 5 });
      return res.status(200).json({
        ok: true, debug: true,
        workpiece_exemplos: wps.slice(0, 3),
        workpiece_campos: wps[0] ? Object.keys(wps[0]) : null,
        no_exemplos: nos.slice(0, 3),
        no_campos: nos[0] ? Object.keys(nos[0]) : null
      });
    } catch (e) {
      return res.status(200).json({ ok: false, debug: true, erro: e.message.slice(0, 400) });
    }
  }

  // Compara as vendas recentes: quais tem instancia de workflow e quais nao.
  // A pergunta que isso responde: a venda criada pela API nasce fora do
  // workflow, ou so demora a entrar?
  if (req.query?.debug_recentes) {
    try {
      const desde = String(req.query.debug_recentes);
      const vendas = await zenGet('/sale/sale', { q: 'id>=' + desde, max: 200, limite: 400 });

      // Busca o workpiece PELO source das vendas em questao. A primeira versao
      // pegava os 2000 primeiros workpieces sem filtro -- que sao os mais
      // antigos -- e concluia "sem workflow" para vendas recentes que na
      // verdade nunca tinham sido consultadas.
      const wpPorSale = {};
      const ids = vendas.map(v => String(v.id));
      for (let i = 0; i < ids.length; i += 40) {
        const lote = ids.slice(i, i + 40);
        const wps = await zenGet('/system/workflow/workpiece', {
          q: '(' + lote.map(id => 'source=="/sale/sale:' + id + '"').join(',') + ')',
          max: 100, limite: 200
        });
        wps.forEach(w => {
          const m = /\/sale\/sale:(\d+)/.exec(w.source || '');
          if (m) wpPorSale[m[1]] = w.workflowNode?.description || w.status;
        });
      }
      const resumo = vendas.map(v => ({
        id: v.id, status: v.status,
        profile: v.saleProfile?.code,
        tags: v.tags || null,
        etapa: wpPorSale[String(v.id)] || null
      }));
      return res.status(200).json({
        ok: true, debug: true,
        vendas: resumo.length,
        com_workflow: resumo.filter(v => v.etapa).length,
        sem_workflow: resumo.filter(v => !v.etapa).length,
        por_status: resumo.reduce((a, v) => { a[v.status] = (a[v.status] || 0) + 1; return a; }, {}),
        // A pergunta central: o que separa a venda que entrou no workflow da
        // que nao entrou? Se for o status, isto mostra na hora.
        workflow_por_status: resumo.reduce((a, v) => {
          const k = v.status;
          a[k] = a[k] || { com: 0, sem: 0 };
          if (v.etapa) a[k].com++; else a[k].sem++;
          return a;
        }, {}),
        amostra: resumo.slice(-25)
      });
    } catch (e) {
      return res.status(200).json({ ok: false, debug: true, erro: e.message.slice(0, 400) });
    }
  }

  // Sonda quais operacoes de venda existem, sem executar nenhuma: GET num
  // endpoint de operacao costuma devolver 405 (existe, metodo errado) e 404
  // quando nao existe. Serve para achar o que leva a venda de PREPARING para
  // PREPARED -- que e o que faz a instancia de workflow nascer.
  if (req.query?.debug_ops) {
    // A doc do projeto sugeria sale.Quote com quoteOpSubmit/quoteOpApprove, e
    // nunca testamos -- criamos sale.Sale direto. Se as operacoes de Quote
    // existirem, a doc provavelmente estava certa: e o Quote que tem o rito de
    // submissao, e e o rito que faz a instancia de workflow nascer.
    const candidatos = [
      '/sale/quote', '/sale/quoteOpSubmit', '/sale/quoteOpApprove',
      '/sale/quoteOpConvert', '/sale/quoteItem',
      '/sale/saleOpChangeStatus', '/sale/saleOpPrepared', '/sale/saleOpUpdateStatus',
      '/system/workflow/workpiece', '/system/workflow/workflowNode',
      '/system/workflow/workpieceNode'
    ];
    const headers = await zenAuth();
    const achados = {};
    for (const p of candidatos) {
      try {
        const rr = await fetch(ZEN_BASE + p + '?first=0&max=1', { headers });
        achados[p] = rr.status;
      } catch (e) { achados[p] = 'erro: ' + e.message.slice(0, 60); }
    }
    return res.status(200).json({ ok: true, debug: true, sondagem: achados });
  }

  // Tenta levar UMA venda de PREPARING para PREPARED. Nao existe endpoint de
  // operacao (todos os candidatos deram 404), entao a transicao deve ser
  // atualizacao do proprio recurso -- isto testa as formas possiveis, parando
  // na primeira que funcionar, e diz exatamente qual funcionou.
  if (req.query?.preparar) {
    const saleId = String(req.query.preparar);
    const headers = await zenAuth();
    const tentativas = [];

    // PUT /sale/sale e o caminho: reclamou de company/person obrigatorios, ou
    // seja, espera o objeto inteiro, nao um patch. Le a venda e devolve com o
    // status trocado (read-modify-write).
    const atual = (await zenGet('/sale/sale', { q: 'id==' + saleId, max: 1, limite: 1 }))[0];
    if (!atual) return res.status(404).json({ error: 'venda nao encontrada no Zen' });
    const novoStatus = String(req.query.status || 'PREPARED');

    const formas = [
      // Minimo com os obrigatorios explicitos.
      { metodo: 'PUT', url: '/sale/sale', rotulo: 'minimo', body: {
          id: Number(saleId),
          company: { id: atual.company?.id },
          person: { id: atual.person?.id },
          saleProfile: { id: atual.saleProfile?.id },
          status: novoStatus,
          tags: atual.tags || undefined
        } },
      // O objeto inteiro de volta, se o minimo nao bastar.
      { metodo: 'PUT', url: '/sale/sale', rotulo: 'completo', body: { ...atual, status: novoStatus } }
    ];
    for (const f of formas) {
      try {
        const rr = await fetch(ZEN_BASE + f.url, {
          method: f.metodo, headers, body: JSON.stringify(f.body)
        });
        const txt = (await rr.text()).slice(0, 300);
        tentativas.push({ forma: f.metodo + ' ' + f.url + ' (' + f.rotulo + ')', status: rr.status, resposta: txt });
        if (rr.ok) break;
      } catch (e) {
        tentativas.push({ forma: f.metodo + ' ' + f.url + ' (' + f.rotulo + ')', erro: e.message.slice(0, 150) });
      }
    }
    // Confere o efeito real, que e o que importa -- nao o codigo devolvido.
    const depois = await zenGet('/sale/sale', { q: 'id==' + saleId, max: 1, limite: 1 });
    const wps = await zenGet('/system/workflow/workpiece', {
      q: 'source=="/sale/sale:' + saleId + '"', max: 5, limite: 5 });
    return res.status(200).json({
      ok: true, debug: true, tentativas,
      status_depois: depois[0]?.status || null,
      workflow_depois: wps[0]?.workflowNode?.description || null
    });
  }

  // Ultima hipotese: criar a instancia de workflow no braco, ja que a venda
  // nao deixa gravar status e nao existe operacao de submissao. Se o Zen
  // aceitar, o pedido entra na fila que o time enxerga; se recusar, a resposta
  // dele diz o que falta -- e ai a pergunta vai para o fornecedor com prova.
  if (req.query?.criar_wp) {
    const saleId = String(req.query.criar_wp);
    const headers = await zenAuth();
    try {
      const nos = await zenGet('/system/workflow/workflowNode', {
        q: 'workflow.id==1001', max: 50, limite: 50 });
      const resumoNos = nos.map(n => ({ id: n.id, type: n.type, code: n.code, description: n.description }));
      const inicial = nos.find(n => n.type === 'START')
        || nos.find(n => /inicio|início/i.test(n.code || n.description || ''));
      if (!inicial) {
        return res.status(200).json({ ok: false, debug: true, motivo: 'no inicial nao identificado', nos: resumoNos });
      }
      const rr = await fetch(ZEN_BASE + '/system/workflow/workpiece', {
        method: 'POST', headers,
        body: JSON.stringify({
          source: '/sale/sale:' + saleId,
          workflow: { id: 1001 },
          workflowNode: { id: inicial.id },
          status: 'RUNNING'
        })
      });
      const txt = (await rr.text()).slice(0, 400);
      const conf = await zenGet('/system/workflow/workpiece', {
        q: 'source=="/sale/sale:' + saleId + '"', max: 5, limite: 5 });
      return res.status(200).json({
        ok: rr.ok, debug: true,
        no_inicial: { id: inicial.id, code: inicial.code, description: inicial.description },
        nos: resumoNos,
        resposta: { status: rr.status, corpo: txt },
        workpiece_depois: conf[0]?.workflowNode?.description || null
      });
    } catch (e) {
      return res.status(200).json({ ok: false, debug: true, erro: e.message.slice(0, 400) });
    }
  }

  // Busca na spec OpenAPI do proprio Zen (~2 MB, 889 endpoints). Existe para
  // parar de adivinhar nome de endpoint: sondar candidato por candidato ja
  // custou uma rodada inteira, e ainda por cima com falso negativo -- as
  // operacoes levam o id no path (`saleOpForwardAuto/{id}`), entao GET na raiz
  // devolve 404 mesmo quando a operacao existe.
  if (req.query?.debug_spec) {
    const termo = String(req.query.debug_spec).toLowerCase();
    try {
      const rr = await fetch(ZEN_BASE + '/platform/openapi.json', { headers: await zenAuth() });
      if (!rr.ok) return res.status(200).json({ ok: false, debug: true, status: rr.status });
      const spec = await rr.json();
      const caminhos = Object.keys(spec.paths || {});
      const achados = caminhos.filter(p => p.toLowerCase().includes(termo));
      return res.status(200).json({
        ok: true, debug: true, termo,
        total_endpoints: caminhos.length,
        achados: achados.slice(0, 60),
        metodos: achados.slice(0, 20).reduce((a, p) => {
          a[p] = Object.keys(spec.paths[p] || {}); return a;
        }, {})
      });
    } catch (e) {
      return res.status(200).json({ ok: false, debug: true, erro: e.message.slice(0, 300) });
    }
  }

  // Como um pedido REAL do time preenche o pagamento. Copiar a forma que o Zen
  // ja usa e mais seguro que montar pelo schema: mostra inclusive qual condicao
  // de pagamento e a usual.
  if (req.query?.debug_pay) {
    try {
      // debug_pay=<saleId> confere o pagamento de um pedido especifico;
      // debug_pay=1 traz a amostra geral (para descobrir a convencao da casa).
      const alvo = String(req.query.debug_pay);
      const filtro = /^\d{2,}$/.test(alvo) ? { q: 'sale.id==' + alvo } : {};
      const pags = await zenGet('/sale/salePayment', { ...filtro, max: 200, limite: 200 });
      // Compacto de proposito: o objeto `sale` vem expandido inteiro e afoga o
      // que interessa (type/term) em centenas de linhas de log.
      const enxuto = pags.map(p => ({
        id: p.id,
        sale_id: p.sale?.id,
        type: p.type,
        term: typeof p.term === 'object' ? { id: p.term?.id, code: p.term?.code, description: p.term?.description } : p.term,
        assetTag: p.assetTag
      }));
      const contaTipo = enxuto.reduce((a, p) => { a[p.type || 'null'] = (a[p.type || 'null'] || 0) + 1; return a; }, {});
      const contaTermo = enxuto.reduce((a, p) => {
        const k = p.term && typeof p.term === 'object' ? (p.term.description || p.term.id) : String(p.term);
        a[k] = (a[k] || 0) + 1; return a;
      }, {});
      return res.status(200).json({
        ok: true, debug: true,
        total_amostra: pags.length,
        campos: pags[0] ? Object.keys(pags[0]) : null,
        por_type: contaTipo,
        por_term: contaTermo,
        exemplos: enxuto.slice(-8)
      });
    } catch (e) {
      return res.status(200).json({ ok: false, debug: true, erro: e.message.slice(0, 300) });
    }
  }

  // Exclusao de venda de teste. Fica atras de parametro explicito e devolve o
  // estado DEPOIS da tentativa, porque codigo HTTP nao basta: o Zen ja aceitou
  // um PUT com 200 e ignorou a alteracao.
  if (req.query?.excluir) {
    const saleId = String(req.query.excluir);
    const headers = await zenAuth();
    const tentativas = [];
    try {
      // O ERP so deixa excluir enquanto a venda esta em PREPARING (o erro e
      // explicito: invalidStatus [PREPARING, PREPARED]). Para uma venda ja
      // avancada, desfazer a preparacao primeiro -- `saleOpPrepareRevert` e o
      // inverso do "Finalizar preparacao de pedido de venda" da tela.
      if (req.query?.reverter) {
        const rp = await fetch(ZEN_BASE + '/sale/saleOpPrepareRevert/' + saleId, { method: 'POST', headers });
        tentativas.push({ alvo: 'saleOpPrepareRevert:' + saleId, status: rp.status, corpo: (await rp.text()).slice(0, 200) });
      }

      // Itens e pagamentos primeiro: se houver FK, a venda so sai depois deles.
      // Ordem inversa da criacao, que e como dependencia costuma se desfazer.
      for (const rec of ['salePayment', 'saleItem']) {
        const filhos = await zenGet('/sale/' + rec, { q: 'sale.id==' + saleId, max: 100, limite: 100 });
        for (const f of filhos) {
          const rr = await fetch(ZEN_BASE + '/sale/' + rec + '/' + f.id, { method: 'DELETE', headers });
          tentativas.push({ alvo: rec + ':' + f.id, status: rr.status });
        }
      }
      const rv = await fetch(ZEN_BASE + '/sale/sale/' + saleId, { method: 'DELETE', headers });
      tentativas.push({ alvo: 'sale:' + saleId, status: rv.status, corpo: (await rv.text()).slice(0, 300) });

      const resta = await zenGet('/sale/sale', { q: 'id==' + saleId, max: 1, limite: 1 });
      return res.status(200).json({
        ok: resta.length === 0, debug: true, tentativas,
        ainda_existe: resta.length > 0,
        status_atual: resta[0]?.status || null
      });
    } catch (e) {
      return res.status(200).json({ ok: false, debug: true, tentativas, erro: e.message.slice(0, 300) });
    }
  }

  const debugSale = req.query?.debug_sale || req.body?.debug_sale;
  if (debugSale) {
    try {
      const vendas = await zenGet('/sale/sale', { q: 'id==' + debugSale, max: 5, limite: 5 });
      const venda = vendas[0] || null;
      const wpId = venda?.workpiece?.id;
      let nos = null, nosPorSource = null;
      if (wpId) {
        nos = await zenGet('/system/workflow/workpieceNode', {
          q: 'workpiece.id==' + wpId, max: 50, limite: 50 });
      }
      // Caminho alternativo: achar o workpiece pelo `source`, que e como o
      // bav-boxer faz a volta ('/sale/sale:<id>').
      try {
        const wps = await zenGet('/system/workflow/workpiece', {
          q: 'source=="/sale/sale:' + debugSale + '"', max: 5, limite: 5 });
        nosPorSource = wps;
      } catch (e) { nosPorSource = { erro: e.message.slice(0, 200) }; }

      return res.status(200).json({
        ok: true, debug: true,
        venda_campos: venda ? Object.keys(venda) : null,
        venda,
        workpiece_id: wpId || null,
        nos,
        workpiece_por_source: nosPorSource
      });
    } catch (e) {
      return res.status(200).json({ ok: false, debug: true, erro: e.message.slice(0, 400) });
    }
  }

  const r = {
    pendentes: 0, empurrados: 0, falhas_push: [],
    acompanhados: 0, etapas_lidas: 0, mudancas: 0, erros: []
  };

  try {
    // ---- 1. Empurrar pedidos submetidos que ainda nao foram para o Zen ----
    const pendRes = await fetch(HUB_URL +
      '/rest/v1/hub_pedidos?status=in.(submetido,aprovado)&erp_pedido_id=is.null' +
      '&ativo=eq.true&select=id,numero&order=criado_em.asc&limit=25', { headers: hubH('GET') });
    const pendentes = pendRes.ok ? await pendRes.json() : [];
    r.pendentes = pendentes.length;

    for (const p of pendentes) {
      try {
        const pushRes = await fetch('https://hub.boxersoldas.com.br/api/push-pedido', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-cron-secret': process.env.CRON_SECRET },
          body: JSON.stringify({ pedido_id: p.id, dry: 0 })
        });
        const out = await pushRes.json();
        if (pushRes.ok && out.erp_pedido_id) {
          r.empurrados++;
          // O evento 'Enviado ao ERP' e gravado dentro do proprio push-pedido,
          // que e por onde os dois caminhos passam (checkout e este job).
        } else {
          r.falhas_push.push({ numero: p.numero, erro: (out.error || 'erro').slice(0, 200) });
        }
      } catch (e) {
        r.falhas_push.push({ numero: p.numero, erro: e.message.slice(0, 200) });
      }
    }

    // ---- 2. Trazer a etapa do workflow de volta ----
    const acompRes = await fetch(HUB_URL +
      '/rest/v1/hub_pedidos?erp_pedido_id=not.is.null&ativo=eq.true' +
      '&select=id,numero,erp_pedido_id,erp_workflow_status' +
      '&order=criado_em.desc&limit=200', { headers: hubH('GET') });
    let acompanhar = acompRes.ok ? await acompRes.json() : [];
    acompanhar = acompanhar.filter(p => !ETAPAS_FINAIS.includes(p.erp_workflow_status));
    r.acompanhados = acompanhar.length;

    if (acompanhar.length) {
      const porSale = {};
      acompanhar.forEach(p => { porSale[String(p.erp_pedido_id)] = p; });
      const saleIds = Object.keys(porSale);

      // Uma consulta so, direto no workpiece, filtrando pelo `source` -- que e
      // como o Zen guarda a volta para a venda ('/sale/sale:<id>').
      //
      // Duas correcoes em relacao a primeira versao, que rodava verde sem ler
      // nada: (1) `sale` NAO traz `workpiece` no payload (traz `workflow`, que
      // e a definicao do fluxo, nao a instancia), entao partir da venda nao
      // leva a lugar nenhum; (2) o proprio workpiece ja carrega `workflowNode`,
      // entao o endpoint workpieceNode e desnecessario.
      for (let i = 0; i < saleIds.length; i += 40) {
        const lote = saleIds.slice(i, i + 40);
        try {
          const wps = await zenGet('/system/workflow/workpiece', {
            q: '(' + lote.map(id => 'source=="/sale/sale:' + id + '"').join(',') + ')',
            max: 100, limite: 200
          });
          r.etapas_lidas += wps.length;

          for (const wp of wps) {
            const m = /\/sale\/sale:(\d+)/.exec(wp.source || '');
            const pedido = m && porSale[m[1]];
            // description e o nome que o time usa ('Analise de Credito'); o
            // status (SUCCESS/FAIL/RUNNING) e generico demais para a tela.
            const etapa = wp.workflowNode?.description;
            if (!pedido || !etapa || etapa === pedido.erp_workflow_status) continue;

            await fetch(HUB_URL + '/rest/v1/hub_pedidos?id=eq.' + pedido.id, {
              method: 'PATCH', headers: hubH('PATCH'),
              body: JSON.stringify({ erp_workflow_status: etapa, erp_workflow_em: new Date().toISOString() })
            });
            await registrarEvento(pedido.id, etapa, 'zen', null, hubH);
            r.mudancas++;
          }
        } catch (e) {
          r.erros.push({ etapa: 'workpiece', detalhe: e.message.slice(0, 200) });
        }
      }

      // Pedido no Zen sem instancia de workflow nao e detalhe tecnico: e pedido
      // que ninguem esta tocando. Contar para virar sinal em vez de silencio.
      r.sem_workflow = acompanhar.length - r.etapas_lidas;
    }

    console.log('[PEDIDOS-ZEN]', JSON.stringify(r));
    return res.status(200).json({ ok: r.erros.length === 0 && !r.falhas_push.length, ...r });

  } catch (e) {
    console.error('[PEDIDOS-ZEN] erro:', e.message);
    return res.status(500).json({ ok: false, erro: e.message, ...r });
  }
};

// Append-only: o indice unico (pedido_id, etapa) descarta a repeticao, entao
// pode ser chamado a cada rodada sem verificar antes se ja existe.
async function registrarEvento(pedidoId, etapa, origem, detalhe, hubH) {
  await fetch(HUB_URL + '/rest/v1/hub_pedido_eventos?on_conflict=pedido_id,etapa', {
    method: 'POST',
    headers: { ...hubH('POST'), Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({ pedido_id: pedidoId, etapa, origem, detalhe })
  });
}
