// Comissao -- Fase 1 (so leitura, automatica e interligada ao portal do
// financeiro: le AO VIVO o schema deles, boxer-controle-financeiro, no MESMO
// projeto Supabase -- nunca copia/sincroniza dado, pra nao criar uma segunda
// fonte de verdade da comissao). Pedido do Andre, 2026-11-19/23.
//
// Join testado e confirmado: comissao_*.vendedor_id (bigint, id do Zen) bate
// 1:1 com comercial.hub_representantes.erp_representante_id. Representante
// so ve a propria carteira (pelo proprio hub_perfis.representante_id); admin/
// manager veem qualquer um (com seletor no front).
//
// Fase 2 (validar/aprovar/reprovar/apontar correcao) fica pra depois de
// alinhar com o time financeiro -- eles sao donos deste schema, e esse fluxo
// escreveria nele (comissao_exclusoes e uma tabela de contestacao que ainda
// nao existe).
//
// Despachado via api/push-pedido.js?target=comissoes -- underscore de
// proposito, nao conta nos 12 do plano Hobby.
const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJtZXB4Y25yc29mb2Zvc3d1YnV1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3MTczNzMsImV4cCI6MjA5NTI5MzM3M30.S55ouFczRYlUYNFf5PotYKXBPT5idypTSmbzR-x2Pk0';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token necessario' });

  function hubH(perfil) {
    return {
      'Content-Type': 'application/json',
      apikey: SB_SERVICE,
      Authorization: 'Bearer ' + SB_SERVICE,
      'Accept-Profile': perfil,
      'Content-Profile': perfil
    };
  }

  try {
    const userRes = await fetch(HUB_URL + '/auth/v1/user', { headers: { Authorization: authHeader, apikey: SB_ANON } });
    const caller = await userRes.json();
    if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

    const perfilRes = await fetch(
      HUB_URL + '/rest/v1/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=tipo,role,representante_id',
      { headers: hubH('comercial') }
    );
    const perfil = (await perfilRes.json())?.[0];
    if (!perfil) return res.status(403).json({ error: 'Perfil nao encontrado' });

    const ehGestor = ['admin', 'manager'].includes(perfil.role);
    const ehRepresentante = perfil.tipo === 'representante' && perfil.representante_id;
    if (!ehGestor && !ehRepresentante) return res.status(403).json({ error: 'Sem acesso a comissao' });

    const body = req.body || {};

    // Resolve o(s) erp_representante_id permitido(s) pra este chamador.
    let vendedorIds = null; // null = gestor sem filtro, ve todo mundo
    if (ehRepresentante) {
      const repRes = await fetch(
        HUB_URL + '/rest/v1/hub_representantes?id=eq.' + perfil.representante_id + '&select=erp_representante_id',
        { headers: hubH('comercial') }
      );
      const erpId = (await repRes.json())?.[0]?.erp_representante_id;
      if (!erpId) return res.status(200).json({ ok: true, vendedor_ids: [], linhas: [], fechamentos: [], vendedores: [] });
      vendedorIds = [erpId];
    } else if (body.vendedor_id) {
      // Gestor pode filtrar por um representante especifico (seletor na tela).
      vendedorIds = [String(body.vendedor_id)];
    }

    // Lista de representantes pro seletor (so gestor usa isso de verdade).
    let vendedores = [];
    if (ehGestor) {
      const r = await fetch(
        HUB_URL + '/rest/v1/hub_representantes?erp_representante_id=not.is.null&ativo=eq.true&select=id,nome,erp_representante_id&order=nome.asc&limit=500',
        { headers: hubH('comercial') }
      );
      vendedores = await r.json();
    }

    const filtroVendedor = vendedorIds ? '&vendedor_id=in.(' + vendedorIds.join(',') + ')' : '';

    const [linhasRes, fechRes] = await Promise.all([
      fetch(HUB_URL + '/rest/v1/comissao_linhas?select=id,chave,competencia,tipo,data_evento,vendedor_id,vendedor_nome,' +
        'titulo_codigo,nf_numero,cliente_nome,cliente_documento,valor_evento,taxa,valor_comissao,excluida,motivo_exclusao' +
        filtroVendedor + '&order=data_evento.desc&limit=500', { headers: hubH('boxer-controle-financeiro') }),
      fetch(HUB_URL + '/rest/v1/comissao_fechamentos?select=competencia,vendedor_id,observacao,fechado_por,fechado_em' +
        filtroVendedor + '&order=competencia.desc&limit=100', { headers: hubH('boxer-controle-financeiro') })
    ]);

    if (!linhasRes.ok) throw new Error('Falha ao ler comissao_linhas: ' + (await linhasRes.text()).slice(0, 300));
    if (!fechRes.ok) throw new Error('Falha ao ler comissao_fechamentos: ' + (await fechRes.text()).slice(0, 300));

    const linhas = await linhasRes.json();
    const fechamentos = await fechRes.json();

    // Resumo por competencia (feito aqui, nao no banco deles -- Fase 1 e so
    // leitura, zero escrita/view nova no schema do financeiro).
    const porCompetencia = {};
    for (const l of linhas) {
      const k = l.competencia;
      if (!porCompetencia[k]) porCompetencia[k] = { competencia: k, qtd: 0, qtd_excluidas: 0, valor_comissao: 0, valor_evento: 0 };
      porCompetencia[k].qtd++;
      if (l.excluida) porCompetencia[k].qtd_excluidas++;
      else { porCompetencia[k].valor_comissao += Number(l.valor_comissao) || 0; porCompetencia[k].valor_evento += Number(l.valor_evento) || 0; }
    }
    const fechadoPorCompetenciaVendedor = new Set(fechamentos.map(f => f.competencia + '|' + f.vendedor_id));
    const resumo = Object.values(porCompetencia)
      .sort((a, b) => (a.competencia < b.competencia ? 1 : -1))
      .map(r => ({ ...r, fechado: vendedorIds ? vendedorIds.every(v => fechadoPorCompetenciaVendedor.has(r.competencia + '|' + v)) : null }));

    return res.status(200).json({ ok: true, vendedor_ids: vendedorIds, vendedores, linhas, fechamentos, resumo });
  } catch (e) {
    console.error('[comissoes] erro:', e);
    return res.status(502).json({ error: e.message });
  }
};
